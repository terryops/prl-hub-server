// Shared helpers for the web API. Personal identifiers never enter cache URLs.
export const json = (body, status = 200, headers) => Response.json(body, { status, headers });
export const webJson = (body, status = 200) => json(body, status, { "cache-control": "no-store" });
export const now = () => Math.floor(Date.now() / 1000);
export const hex = (bytes) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export const sha256 = async (s) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export function clientCopy(res) {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-store");
  return out;
}
// Concurrent requests may share one upstream fetch, but only as plain data. A Response and its
// body belong to the request that made them: another request reading them fails ("Cannot perform
// I/O on behalf of a different request"), and when that failure ends the request doing the fetch,
// the others waiting on it hang. Each request builds its own Response from the shared copy.
export const sharedCopy = async (res) => ({ status: res.status, headers: [...res.headers], text: await res.text() });
export const ownCopy = (copy) => new Response(copy.text, { status: copy.status, headers: copy.headers });
const building = new Map();
export async function cached(key, ttl, ctx, build) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = key instanceof Request ? key : new Request(`https://cache.internal/${key}`);
  const hit = cache && (await cache.match(req));
  if (hit) return clientCopy(hit);
  // Concurrent tabs hitting a cold/expired edge key share one upstream fetch.
  let work = building.get(req.url);
  if (!work) {
    work = (async () => {
      const body = await build();
      if (body instanceof Response) return sharedCopy(body);
      const res = json(body, 200, { "cache-control": `public, max-age=${ttl}` });
      if (cache) {
        const put = cache.put(req, res.clone());
        if (ctx?.waitUntil) ctx.waitUntil(put);
        else await put;
      }
      return sharedCopy(res);
    })();
    building.set(req.url, work);
    // Finish the fetch for the requests waiting on it even if this request goes away first.
    if (ctx?.waitUntil) ctx.waitUntil(work.catch(() => {}));
  }
  try { const res = ownCopy(await work); return res.ok ? clientCopy(res) : res; }
  finally { if (building.get(req.url) === work) building.delete(req.url); }
}
