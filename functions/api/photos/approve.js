/**
 * POST /api/photos/approve — Dad's moderation step for the photo wall.
 *
 * Body: { id, action } where action is "approve" or "reject".
 * Approve moves a pending photo to the public board; reject deletes it.
 * This endpoint is only called from the unlinked admin page at
 * /wall-of-fame/admin/ — it is not linked anywhere public.
 */

const MAX_BODY_BYTES = 512;
const RATE_LIMIT = 20;
const RATE_TTL_SECONDS = 60 * 60;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-robots-tag": "noindex",
};

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!originAllowed(request)) {
    return respond({ ok: false, message: "Only TwoRLabs.com can review photos." }, 403);
  }

  if (!env || !env.tworlabs_wall) {
    return respond({ ok: false, message: "The photo wall is offline for a minute. Please try again soon." }, 503);
  }

  let fields;
  try {
    fields = await readFields(request);
  } catch (error) {
    return respond({ ok: false, message: "Please send a photo and an action." }, 400);
  }

  const id = typeof fields.id === "string" ? fields.id : "";
  const action = typeof fields.action === "string" ? fields.action : "";
  if (!/^[0-9a-fA-F-]{36}$/.test(id) || (action !== "approve" && action !== "reject")) {
    return respond({ ok: false, message: "Please send a photo and an action." }, 400);
  }

  try {
    const limited = await hitRateLimit(env.tworlabs_wall, request);
    if (limited) {
      return respond({ ok: false, message: "Too many tries. Please wait a bit and try again." }, 429);
    }
  } catch (error) {
    return respond({ ok: false, message: "The photo wall is offline for a minute. Please try again soon." }, 503);
  }

  try {
    const raw = await env.tworlabs_wall.get(`photo:pending:${id}`);
    if (!raw) {
      return respond({ ok: false, message: "That photo is not waiting for review." }, 404);
    }
    if (action === "approve") {
      await env.tworlabs_wall.put(`photo:approved:${id}`, raw);
      console.log(JSON.stringify({ event: "photos", outcome: "approved", id }));
    } else {
      console.log(JSON.stringify({ event: "photos", outcome: "rejected", id }));
    }
    await env.tworlabs_wall.delete(`photo:pending:${id}`);
    return respond({ ok: true, action });
  } catch (error) {
    console.error(JSON.stringify({ event: "photos", outcome: "error", stage: "approve" }));
    return respond({ ok: false, message: "The photo wall is offline for a minute. Please try again soon." }, 503);
  }
}

function originAllowed(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readFields(request) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error("too large"), { code: "too_large" });
  }
  const text = await readLimitedText(request, MAX_BODY_BYTES);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("bad json"), { code: "bad_json" });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("bad json"), { code: "bad_json" });
  }
  return data;
}

async function readLimitedText(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch {
        /* already over the cap */
      }
      throw Object.assign(new Error("too large"), { code: "too_large" });
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function hitRateLimit(kv, request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const hour = new Date().toISOString().slice(0, 13);
  const key = `rl:approve:${ip}:${hour}`;
  const current = Number((await kv.get(key)) || "0");
  const count = Number.isFinite(current) ? current : 0;
  if (count >= RATE_LIMIT) return true;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_TTL_SECONDS });
  return false;
}

function respond(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}
