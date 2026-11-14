/**
 * POST /api/subscribe
 *
 * Stores launch emails in Workers KV. The namespace must be bound as SIGNUPS
 * (Pages → Settings → Bindings, or [[kv_namespaces]] in wrangler.toml).
 *
 * Key:   lowercased email
 * Value: JSON { timestamp, userAgent, country }
 *
 * Rate-limit keys use the prefix "rl:" and expire. They are not signups.
 * No environment variables are required.
 */

const MAX_BODY_BYTES = 4096;
const RATE_LIMIT = 5;
const RATE_TTL_SECONDS = 60 * 60 * 2;
const SUCCESS = "You're on the list!";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-robots-tag": "noindex",
};

export async function onRequestPost(context) {
  const { request, env } = context;
  const html = wantsHtml(request);

  if (!originAllowed(request)) {
    return respond(html, { ok: false, message: "Signups are only accepted from TwoRLabs.com." }, 403);
  }

  if (!env || !env.SIGNUPS) {
    console.error(JSON.stringify({ event: "signup", outcome: "unavailable" }));
    return respond(
      html,
      { ok: false, message: "Signups are offline for a minute. Please try again soon." },
      503,
    );
  }

  let fields;
  try {
    fields = await readFields(request);
  } catch (error) {
    if (error && error.code === "too_large") {
      return respond(html, { ok: false, message: "That submission was too large." }, 413);
    }
    return respond(html, { ok: false, message: "Please enter a valid email address.", field: "email" }, 400);
  }

  // Honeypot: pretend it worked and store nothing, so bots are not told apart.
  if (fields.honeypot) {
    console.log(JSON.stringify({ event: "signup", outcome: "honeypot" }));
    return respond(html, { ok: true, message: SUCCESS }, 200);
  }

  try {
    const limited = await hitRateLimit(env.SIGNUPS, request);
    if (limited) {
      console.log(JSON.stringify({ event: "signup", outcome: "rate_limited" }));
      return respond(
        html,
        { ok: false, message: "Too many tries. Please wait a bit and try again." },
        429,
      );
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "signup", outcome: "error", stage: "rate" }));
    return respond(
      html,
      { ok: false, message: "Signups are offline for a minute. Please try again soon." },
      503,
    );
  }

  const email = normalizeEmail(fields.email);
  if (!email) {
    return respond(html, { ok: false, message: "Please enter a valid email address.", field: "email" }, 400);
  }

  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    userAgent: (request.headers.get("user-agent") || "").slice(0, 300),
    country: countryOf(request),
  });

  try {
    const existing = await env.SIGNUPS.get(email);
    if (!existing) {
      await env.SIGNUPS.put(email, record);
      console.log(JSON.stringify({ event: "signup", outcome: "stored", country: countryOf(request) }));
    } else {
      console.log(JSON.stringify({ event: "signup", outcome: "duplicate", country: countryOf(request) }));
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "signup", outcome: "error", stage: "store" }));
    return respond(
      html,
      { ok: false, message: "Signups are offline for a minute. Please try again soon." },
      503,
    );
  }

  return respond(html, { ok: true, message: SUCCESS }, 200);
}

function wantsHtml(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (type.includes("application/json")) return false;
  return (request.headers.get("accept") || "").includes("text/html");
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
  const type = (request.headers.get("content-type") || "").toLowerCase();
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error("too large"), { code: "too_large" });
  }

  if (type.includes("multipart/form-data")) {
    if (!declared || declared > MAX_BODY_BYTES) {
      throw Object.assign(new Error("too large"), { code: "too_large" });
    }
    const form = await request.formData();
    return {
      email: fieldString(form.get("email")),
      honeypot: honeypotTripped(form.get("fax_number")),
    };
  }

  const text = await readLimitedText(request, MAX_BODY_BYTES);
  if (type.includes("application/json") || text.trim().startsWith("{")) {
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
      email: typeof data.email === "string" ? data.email : "",
      honeypot: honeypotTripped(data.fax_number),
    };
  }

  const params = new URLSearchParams(text);
  return {
    email: params.get("email") || "",
    honeypot: honeypotTripped(params.get("fax_number")),
  };
}

function fieldString(value) {
  return typeof value === "string" ? value : "";
}

function honeypotTripped(value) {
  if (value == null || value === "") return false;
  if (typeof value !== "string") return true;
  return value.trim() !== "";
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
  const key = `rl:${ip}:${hour}`;
  const current = Number((await kv.get(key)) || "0");
  const count = Number.isFinite(current) ? current : 0;
  if (count >= RATE_LIMIT) return true;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_TTL_SECONDS });
  return false;
}

export function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toLowerCase();
  if (!email || email.length > 254 || /\s/.test(email) || email.includes("..")) return "";
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".")) return "";
  const labels = domain.split(".");
  if (labels.length < 2) return "";
  if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    return "";
  }
  if (labels[labels.length - 1].length < 2) return "";
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return "";
  if (!/^[a-z0-9.-]+$/.test(domain)) return "";
  return email;
}

function countryOf(request) {
  try {
    const country = request.cf && request.cf.country;
    if (typeof country === "string" && /^[A-Za-z0-9]{2}$/.test(country)) return country.toUpperCase();
  } catch {
    /* request.cf is Workers-only */
  }
  return null;
}

function respond(html, body, status) {
  if (html) return htmlResponse(body, status);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function htmlResponse(body, status) {
  const title = body.ok ? "You're on the list!" : "Check that email";
  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} · TwoRLabs</title>
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
  <main class="fallback">
    <p class="pixel-title">${escapeHtml(body.ok ? "OK" : "Hmm")}</p>
    <h1>${escapeHtml(body.message)}</h1>
    <p><a class="button" href="/">Back home</a></p>
  </main>
  <div class="ground" aria-hidden="true"></div>
</body>
</html>`;
  return new Response(page, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}
