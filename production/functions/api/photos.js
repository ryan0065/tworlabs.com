/**
 * GET  /api/photos               -> { ok, photos: [{ id, name, ts }] } (approved only)
 * GET  /api/photos?status=pending -> { ok, photos: [...] } (held for review)
 * POST /api/photos               -> { ok, id } — submits one edited photo for review.
 *
 * Photos do NOT post straight to the board: every photo is held for Dad's
 * approval first (POST /api/photos/approve). The KV namespace must be bound
 * as tworlabs_wall (Pages -> Settings -> Bindings, or [[kv_namespaces]] in
 * wrangler.toml).
 *
 * Keys:  photo:pending:<uuid>   JSON { id, name, image, ts }
 *        photo:approved:<uuid>  JSON { id, name, image, ts }
 *        image is a data:image/png;base64,... URL, capped at 8 MB.
 *        The image bytes themselves are served by /api/photos/<id>.
 *
 * Rate-limit keys use the prefix "rl:" and expire. They are not photos.
 * No environment variables are required.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const RATE_LIMIT = 5;
const RATE_TTL_SECONDS = 60 * 60;
const IMAGE_PREFIX = "data:image/png;base64,";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-robots-tag": "noindex",
};

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.tworlabs_wall) {
    return respond({ ok: false, message: "The photo wall is offline for a minute. Please try again soon." }, 503);
  }
  const url = new URL(request.url);
  const status = url.searchParams.get("status") === "pending" ? "pending" : "approved";
  try {
    const photos = await listPhotos(env.tworlabs_wall, status);
    return respond({ ok: true, photos });
  } catch (error) {
    console.error(JSON.stringify({ event: "photos", outcome: "error", stage: "list" }));
    return respond({ ok: false, message: "The photo wall is offline for a minute. Please try again soon." }, 503);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!originAllowed(request)) {
    return respond({ ok: false, message: "Photos are only accepted from TwoRLabs.com." }, 403);
  }

  if (!env || !env.tworlabs_wall) {
    console.error(JSON.stringify({ event: "photos", outcome: "unavailable" }));
    return respond({ ok: false, message: "The photo wall is offline for a minute. Please try again soon." }, 503);
  }

  let fields;
  try {
    fields = await readFields(request);
  } catch (error) {
    if (error && error.code === "too_large") {
      return respond({ ok: false, message: "That photo is too large. Try a smaller one." }, 413);
    }
    return respond({ ok: false, message: "Please send a photo to post." }, 400);
  }

  const image = typeof fields.image === "string" ? fields.image : "";
  if (!image.startsWith(IMAGE_PREFIX) || image.length > MAX_BODY_BYTES) {
    return respond({ ok: false, message: "Please send a photo to post." }, 400);
  }
  const b64 = image.slice(IMAGE_PREFIX.length);
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length % 4 !== 0) {
    return respond({ ok: false, message: "Please send a photo to post." }, 400);
  }

  try {
    const limited = await hitRateLimit(env.tworlabs_wall, request, "photo");
    if (limited) {
      console.log(JSON.stringify({ event: "photos", outcome: "rate_limited" }));
      return respond({ ok: false, message: "Too many tries. Please wait a bit and try again." }, 429);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "photos", outcome: "error", stage: "rate" }));
    return respond({ ok: false, message: "The photo wall is offline for a minute. Please try again soon." }, 503);
  }

  const id = crypto.randomUUID();
  const record = {
    id,
    name: sanitizeName(fields.name),
    image,
    ts: new Date().toISOString(),
  };

  try {
    await env.tworlabs_wall.put(`photo:pending:${id}`, JSON.stringify(record));
    console.log(JSON.stringify({ event: "photos", outcome: "stored_pending", id }));
    return respond({ ok: true, id, message: "Sent for review — Dad checks photos before they go on the wall." });
  } catch (error) {
    console.error(JSON.stringify({ event: "photos", outcome: "error", stage: "store" }));
    return respond({ ok: false, message: "The photo wall is offline for a minute. Please try again soon." }, 503);
  }
}

async function listPhotos(kv, status) {
  const prefix = status === "pending" ? "photo:pending:" : "photo:approved:";
  const listed = await kv.list({ prefix });
  const photos = [];
  for (const key of listed.keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      if (record && record.id) {
        photos.push({ id: record.id, name: record.name || "ANONYMOUS", ts: record.ts || "" });
      }
    } catch {
      /* skip a bad record */
    }
  }
  photos.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return photos.slice(0, 50);
}

function sanitizeName(value) {
  if (typeof value !== "string") return "ANONYMOUS";
  const cleaned = value
    .normalize("NFKC")
    .replace(/[​‌‍﻿]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 &.'-]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 12)
    .trim();
  return cleaned || "ANONYMOUS";
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
  return {
    name: typeof data.name === "string" ? data.name : "",
    image: typeof data.image === "string" ? data.image : "",
  };
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

async function hitRateLimit(kv, request, scope) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const hour = new Date().toISOString().slice(0, 13);
  const key = `rl:${scope}:${ip}:${hour}`;
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
