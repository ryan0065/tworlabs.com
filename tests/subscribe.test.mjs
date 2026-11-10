import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost, normalizeEmail } from "../production/functions/api/subscribe.js";

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
  };
}

function post(body, { json = true, headers = {}, cf, url = "https://tworlabs.com/api/subscribe" } = {}) {
  const requestHeaders = new Headers(headers);
  if (json) {
    requestHeaders.set("content-type", "application/json");
    requestHeaders.set("accept", "application/json");
  }
  const request = new Request(url, {
    method: "POST",
    headers: requestHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
}

async function call(request, kv = memoryKv()) {
  const response = await onRequestPost({ request, env: { SIGNUPS: kv } });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { response, payload, kv };
}

test("normalizeEmail accepts ordinary addresses and rejects junk", () => {
  assert.equal(normalizeEmail("  Parent@Example.com "), "parent@example.com");
  assert.equal(normalizeEmail("a.b+tag@gmail.com"), "a.b+tag@gmail.com");
  assert.equal(normalizeEmail("not-an-email"), "");
  assert.equal(normalizeEmail("a@b"), "");
  assert.equal(normalizeEmail("a@b.c"), "");
  assert.equal(normalizeEmail("a..b@example.com"), "");
  assert.equal(normalizeEmail(""), "");
});

test("stores a signup under the lowercased email", async () => {
  const kv = memoryKv();
  const { response, payload } = await call(
    post(
      { email: "Fan@Example.com" },
      { headers: { "user-agent": "TestBrowser/1.0" }, cf: { country: "us" } },
    ),
    kv,
  );
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.message, "You're on the list!");
  const saved = JSON.parse(kv.store.get("fan@example.com"));
  assert.equal(saved.userAgent, "TestBrowser/1.0");
  assert.equal(saved.country, "US");
  assert.match(saved.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Object.keys(saved).sort().join(), "country,timestamp,userAgent");
});

test("duplicate signup keeps the original record", async () => {
  const kv = memoryKv();
  await call(post({ email: "fan@example.com" }), kv);
  const first = kv.store.get("fan@example.com");
  const { response, payload } = await call(post({ email: "FAN@example.com" }), kv);
  assert.equal(response.status, 200);
  assert.equal(payload.message, "You're on the list!");
  assert.equal(kv.store.get("fan@example.com"), first);
});

test("rejects an invalid email and stores nothing", async () => {
  const kv = memoryKv();
  const { response, payload } = await call(post({ email: "nope" }), kv);
  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(payload.field, "email");
  assert.equal([...kv.store.keys()].some((key) => key.includes("@")), false);
});

test("honeypot returns success without storing", async () => {
  const kv = memoryKv();
  const { response, payload } = await call(post({ email: "bot@example.com", fax_number: "acme" }), kv);
  assert.equal(response.status, 200);
  assert.equal(payload.message, "You're on the list!");
  assert.equal(kv.store.size, 0);
});

test("accepts a classic form post and can answer with HTML", async () => {
  const kv = memoryKv();
  const { response, payload } = await call(
    post("email=parent%40example.com", {
      json: false,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
    }),
    kv,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(payload, /You&#39;re on the list!/);
  assert.ok(kv.store.has("parent@example.com"));
});

test("missing KV binding is a friendly 503", async () => {
  const response = await onRequestPost({ request: post({ email: "a@b.co" }), env: {} });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
});

test("rate limit trips on the sixth attempt from one IP", async () => {
  const kv = memoryKv();
  const headers = { "cf-connecting-ip": "203.0.113.9" };
  for (let i = 0; i < 5; i += 1) {
    const { response } = await call(post({ email: `p${i}@example.com` }, { headers }), kv);
    assert.equal(response.status, 200);
  }
  const { response, payload } = await call(post({ email: "overflow@example.com" }, { headers }), kv);
  assert.equal(response.status, 429);
  assert.match(payload.message, /Too many tries/);
  assert.equal(kv.store.has("overflow@example.com"), false);
});

test("rejects a mismatched origin and an oversized body", async () => {
  const kv = memoryKv();
  const blocked = await call(
    post({ email: "a@example.com" }, { headers: { origin: "https://evil.example" } }),
    kv,
  );
  assert.equal(blocked.response.status, 403);
  assert.equal(kv.store.size, 0);

  const huge = await call(
    post({ email: "a@example.com" }, { headers: { "content-length": "99999" } }),
    kv,
  );
  assert.equal(huge.response.status, 413);
});
