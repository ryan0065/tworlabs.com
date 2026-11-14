/**
 * GET /api/photos/<id> — serves one stored photo's PNG bytes.
 *
 * Looks in the approved photos first, then the pending ones (the admin page
 * needs to see pending photos before approving them). IDs are unguessable
 * UUIDs, so a pending photo is only reachable from the admin page.
 */

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = params && params.id ? String(params.id) : "";
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return new Response("Not found", { status: 404, headers: { "x-robots-tag": "noindex" } });
  }
  if (!env || !env.tworlabs_wall) {
    return new Response("Photo wall offline", { status: 503, headers: { "x-robots-tag": "noindex" } });
  }
  let record = null;
  for (const prefix of ["photo:approved:", "photo:pending:"]) {
    try {
      const raw = await env.tworlabs_wall.get(prefix + id);
      if (raw) {
        record = JSON.parse(raw);
        break;
      }
    } catch {
      /* keep looking */
    }
  }
  if (!record || typeof record.image !== "string" || !record.image.startsWith("data:image/png;base64,")) {
    return new Response("Not found", { status: 404, headers: { "x-robots-tag": "noindex" } });
  }
  const bytes = Uint8Array.from(atob(record.image.slice("data:image/png;base64,".length)), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}
