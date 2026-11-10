/**
 * Local preview with an in-memory SIGNUPS store.
 * Static files come from /production and POST /api/subscribe runs the real function.
 *
 *   node scripts/preview.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { onRequestPost } from "../production/functions/api/subscribe.js";

const root = join(process.cwd(), "production");
const port = Number(process.env.PORT || 4173);
const store = new Map();
const SIGNUPS = {
  async get(key) {
    return store.has(key) ? store.get(key) : null;
  },
  async put(key, value) {
    store.set(key, String(value));
  },
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const full = normalize(join(root, relative));
  if (!full.startsWith(root)) return null;
  return full;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${port}`;
    const url = new URL(req.url || "/", `http://${host}`);

    if (url.pathname === "/api/subscribe") {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const request = new Request(url, { method: req.method, headers: req.headers, body });
      const response = req.method === "POST"
        ? await onRequestPost({ request, env: { SIGNUPS } })
        : new Response(JSON.stringify({ ok: false, message: "Use POST." }), {
          status: 405,
          headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
        });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    const file = safePath(url.pathname);
    if (!file) {
      res.statusCode = 400;
      res.end("Bad path");
      return;
    }
    try {
      const data = await readFile(file);
      res.statusCode = 200;
      res.setHeader("content-type", types[extname(file).toLowerCase()] || "application/octet-stream");
      res.end(data);
    } catch {
      const missing = await readFile(join(root, "404.html"));
      res.statusCode = 404;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(missing);
    }
  } catch (error) {
    res.statusCode = 500;
    res.end("Preview server error");
    console.error(error);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`TwoRLabs preview at http://127.0.0.1:${port}`);
});
