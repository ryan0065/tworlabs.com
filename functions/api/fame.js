/**
 * GET  /api/fame  -> { ok, scores: [{ name, score, smashed, acc, ts }] } (top 10)
 * POST /api/fame  -> { ok, rank } — submits one score to the shared Wall of Fame.
 *
 * Scores post straight to the board (no approval hold). Names are capped at
 * 12 characters, first names only, no links. The KV namespace must be bound
 * as tworlabs_wall (Pages -> Settings -> Bindings, or [[kv_namespaces]] in
 * wrangler.toml).
 *
 * Key:   fame:scores
 * Value: JSON array of score objects, newest first by score, capped at 100.
 *
 * Rate-limit keys use the prefix "rl:" and expire. They are not scores.
 * No environment variables are required.
 */

const MAX_BODY_BYTES = 2048;
const RATE_LIMIT = 10;
const RATE_TTL_SECONDS = 60 * 60;
const SCORES_KEY = "fame:scores";
const MAX_STORED = 100;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-robots-tag": "noindex",
};

export async function onRequestGet(context) {
  const { env } = context;
  if (!env || !env.tworlabs_wall) {
    return respond({ ok: false, message: "The Wall of Fame is offline for a minute. Please try again soon." }, 503);
  }
  let scores;
  try {
    scores = await readScores(env.tworlabs_wall);
  } catch (error) {
    console.error(JSON.stringify({ event: "fame", outcome: "error", stage: "read" }));
    return respond({ ok: false, message: "The Wall of Fame is offline for a minute. Please try again soon." }, 503);
  }
  return respond({ ok: true, scores: scores.slice(0, 10) });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!originAllowed(request)) {
    return respond({ ok: false, message: "Scores are only accepted from TwoRLabs.com." }, 403);
  }

  if (!env || !env.tworlabs_wall) {
    console.error(JSON.stringify({ event: "fame", outcome: "unavailable" }));
    return respond({ ok: false, message: "The Wall of Fame is offline for a minute. Please try again soon." }, 503);
  }

  let fields;
  try {
    fields = await readFields(request);
  } catch (error) {
    if (error && error.code === "too_large") {
      return respond({ ok: false, message: "That submission was too large." }, 413);
    }
    return respond({ ok: false, message: "Please send a name and a score." }, 400);
  }

  try {
    const limited = await hitRateLimit(env.tworlabs_wall, request, "fame");
    if (limited) {
      console.log(JSON.stringify({ event: "fame", outcome: "rate_limited" }));
      return respond({ ok: false, message: "Too many tries. Please wait a bit and try again." }, 429);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "fame", outcome: "error", stage: "rate" }));
    return respond({ ok: false, message: "The Wall of Fame is offline for a minute. Please try again soon." }, 503);
  }

  const name = sanitizeName(fields.name);
  const score = toInt(fields.score, 0, 999999);
  const smashed = toInt(fields.smashed, 0, 9999);
  const acc = toInt(fields.acc, 0, 100);
  if (score === null || smashed === null || acc === null) {
    return respond({ ok: false, message: "Please send a name and a score." }, 400);
  }

  const entry = { name, score, smashed, acc, ts: new Date().toISOString() };

  try {
    const scores = await readScores(env.tworlabs_wall);
    scores.push(entry);
    scores.sort(byScore);
    const kept = scores.slice(0, MAX_STORED);
    await env.tworlabs_wall.put(SCORES_KEY, JSON.stringify(kept));
    const rank = kept.slice(0, 10).indexOf(entry);
    console.log(JSON.stringify({ event: "fame", outcome: "stored", name, score }));
    return respond({ ok: true, rank: rank === -1 ? null : rank + 1 });
  } catch (error) {
    console.error(JSON.stringify({ event: "fame", outcome: "error", stage: "store" }));
    return respond({ ok: false, message: "The Wall of Fame is offline for a minute. Please try again soon." }, 503);
  }
}

async function readScores(kv) {
  const raw = await kv.get(SCORES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e === "object" && typeof e.score === "number");
  } catch {
    return [];
  }
}

function byScore(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return String(a.ts).localeCompare(String(b.ts));
}

function sanitizeName(value) {
  if (typeof value !== "string") return "RIDGE";
  const cleaned = value
    .normalize("NFKC")
    .replace(/[​‌‍﻿]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 &.'-]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 12)
    .trim();
  return cleaned || "RIDGE";
}

function toInt(value, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < min || i > max) return null;
  return i;
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
    score: data.score,
    smashed: data.smashed,
    acc: data.acc,
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
