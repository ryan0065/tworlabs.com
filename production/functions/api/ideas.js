/**
 * POST /api/ideas
 *
 * Collects game and project ideas from the Submit Ideas page.
 * Entries are stored privately in Workers KV for the TwoRLabs team to
 * review — they are never displayed anywhere public. There is no GET
 * handler: reading ideas is done by the team (Wrangler KV), not the site.
 * The KV namespace must be bound as tworlabs_wall (Pages -> Settings ->
 * Bindings, or [[kv_namespaces]] in wrangler.toml).
 *
 * Key:   ideas:<ISO timestamp>-<random>
 * Value: JSON { name, email, idea, ts, userAgent, country }
 *
 * Spam defence: Cloudflare Turnstile. The page renders the Turnstile
 * widget with the public site key; this function verifies the token
 * server-side against https://challenges.cloudflare.com/turnstile/v0/siteverify
 * using the TURNSTILE_SECRET_KEY environment variable (Pages -> Settings ->
 * Environment variables). Without that secret set, submissions are refused
 * rather than stored unverified.
 *
 * Rate-limit keys use the prefix "rl:" and expire. They are not ideas.
 */

const MAX_BODY_BYTES = 8192;
const RATE_LIMIT = 5;
const RATE_TTL_SECONDS = 60 * 60 * 2;
const SUCCESS = "Thanks! Your idea is on its way to Ridge and Rhett.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
    return respond(html, { ok: false, message: "Ideas are only accepted from TwoRLabs.com." }, 403);
  }

  if (!env || !env.tworlabs_wall) {
    console.error(JSON.stringify({ event: "ideas", outcome: "unavailable" }));
    return respond(
      html,
      { ok: false, message: "Ideas are offline for a minute. Please try again soon." },
      503,
    );
  }

  if (!env.TURNSTILE_SECRET_KEY) {
    console.error(JSON.stringify({ event: "ideas", outcome: "no_turnstile_secret" }));
    return respond(
      html,
      { ok: false, message: "Ideas are offline for a minute. Please try again soon." },
      503,
    );
  }

  let fields;
  try {
    fields = await readFields(request);
  } catch (error) {
    if (error && error.code === "too_large") {
      return respond(html, { ok: false, message: "That idea was too large." }, 413);
    }
    return respond(html, { ok: false, message: "Please write your idea first.", field: "idea" }, 400);
  }

  // Honeypot: pretend it worked and store nothing, so bots are not told apart.
  if (fields.honeypot) {
    console.log(JSON.stringify({ event: "ideas", outcome: "honeypot" }));
    return respond(html, { ok: true, message: SUCCESS }, 200);
  }

  // Turnstile: the token must verify before anything is stored.
  const token = fields.turnstileToken || fields.cfTurnstileResponse || "";
  if (!token) {
    return respond(html, { ok: false, message: "Please complete the captcha check, then send your idea." }, 400);
  }
  let captchaOk = false;
  try {
    captchaOk = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, request);
  } catch (error) {
    console.error(JSON.stringify({ event: "ideas", outcome: "error", stage: "turnstile" }));
    return respond(
      html,
      { ok: false, message: "Ideas are offline for a minute. Please try again soon." },
      503,
    );
  }
  if (!captchaOk) {
    console.log(JSON.stringify({ event: "ideas", outcome: "turnstile_failed" }));
    return respond(html, { ok: false, message: "That captcha check did not pass. Please try again." }, 400);
  }

  try {
    const limited = await hitRateLimit(env.tworlabs_wall, request);
    if (limited) {
      console.log(JSON.stringify({ event: "ideas", outcome: "rate_limited" }));
      return respond(
        html,
        { ok: false, message: "Too many tries. Please wait a bit and try again." },
        429,
      );
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "ideas", outcome: "error", stage: "rate" }));
    return respond(
      html,
      { ok: false, message: "Ideas are offline for a minute. Please try again soon." },
      503,
    );
  }

  const name = sanitizeName(fields.name);
  const email = sanitizeEmail(fields.email);
  const idea = sanitizeIdea(fields.idea);
  if (!name) {
    return respond(html, { ok: false, message: "Please add your name.", field: "name" }, 400);
  }
  if (!email) {
    return respond(html, { ok: false, message: "Please add a valid email address.", field: "email" }, 400);
  }
  if (!idea) {
    return respond(html, { ok: false, message: "Please tell us a little more about your idea — at least a few words.", field: "idea" }, 400);
  }

  const ts = new Date().toISOString();
  const key = `ideas:${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const record = JSON.stringify({
    name,
    email,
    idea,
    ts,
    userAgent: (request.headers.get("user-agent") || "").slice(0, 300),
    country: countryOf(request),
  });

  try {
    await env.tworlabs_wall.put(key, record);
    console.log(JSON.stringify({ event: "ideas", outcome: "stored" }));
  } catch (error) {
    console.error(JSON.stringify({ event: "ideas", outcome: "error", stage: "store" }));
    return respond(
      html,
      { ok: false, message: "Ideas are offline for a minute. Please try again soon." },
      503,
    );
  }

  return respond(html, { ok: true, message: SUCCESS }, 200);
}

async function verifyTurnstile(secret, token, request) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error("siteverify http " + res.status);
  const data = await res.json();
  return data && data.success === true;
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
      name: fieldString(form.get("name")),
      email: fieldString(form.get("email")),
      idea: fieldString(form.get("idea")),
      turnstileToken: fieldString(form.get("turnstileToken")),
      cfTurnstileResponse: fieldString(form.get("cf-turnstile-response")),
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
      name: typeof data.name === "string" ? data.name : "",
      email: typeof data.email === "string" ? data.email : "",
      idea: typeof data.idea === "string" ? data.idea : "",
      turnstileToken: typeof data.turnstileToken === "string" ? data.turnstileToken : "",
      cfTurnstileResponse: typeof data["cf-turnstile-response"] === "string" ? data["cf-turnstile-response"] : "",
      honeypot: honeypotTripped(data.fax_number),
    };
  }

  const params = new URLSearchParams(text);
  return {
    name: params.get("name") || "",
    email: params.get("email") || "",
    idea: params.get("idea") || "",
    turnstileToken: params.get("turnstileToken") || "",
    cfTurnstileResponse: params.get("cf-turnstile-response") || "",
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
  const key = `rl:ideas:${ip}:${hour}`;
  const current = Number((await kv.get(key)) || "0");
  const count = Number.isFinite(current) ? current : 0;
  if (count >= RATE_LIMIT) return true;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_TTL_SECONDS });
  return false;
}

function sanitizeName(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/[<>\n\r]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

function sanitizeEmail(value) {
  if (typeof value !== "string") return "";
  const cleaned = value.normalize("NFKC").trim().toLowerCase().slice(0, 254);
  return EMAIL_RE.test(cleaned) ? cleaned : "";
}

function sanitizeIdea(value) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .normalize("NFKC")
    .replace(/[​‌‍﻿]/g, "")
    .trim();
  if (cleaned.length < 10 || cleaned.length > 2000) return "";
  return cleaned;
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
  const title = body.ok ? "Thanks!" : "Hmm";
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
    <p class="pixel-title">${escapeHtml(title)}</p>
    <h1>${escapeHtml(body.message)}</h1>
    <p><a class="button" href="/submit-ideas/">Back to Submit an Idea</a></p>
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
