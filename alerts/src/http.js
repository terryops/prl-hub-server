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
// A request waits at most this long (from when it started) for a fetch another request started.
// That request can be cut off before its fetch ends: on 2026-10-23 stalled D1 calls outlived their
// invocations, the shared promises never settled, and every later /v1/price on those isolates
// waited on them until the client gave up. Past this age the next request fetches for itself,
// and its fetch replaces the stuck one.
export const SHARE_WAIT_MS = 5000;
const building = new Map();
const WAITED_OUT = Symbol("waited out");
function startBuild(key, ctx, build) {
  const work = (async () => build())();
  const entry = { work, at: Date.now() };
  building.set(key, entry);
  const done = () => { if (building.get(key) === entry) building.delete(key); };
  work.then(done, done);
  // Finish the fetch for the requests waiting on it even if this request goes away first.
  if (ctx?.waitUntil) ctx.waitUntil(work.catch(() => {}));
  return work;
}
async function waitFor(work, ms) {
  let timer;
  try { return await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve(WAITED_OUT), ms); })]); }
  finally { clearTimeout(timer); }
}
/// One `build` at a time per `key` on this isolate, shared by the requests that arrive while it
/// runs; each waits at most SHARE_WAIT_MS (from when that build started), then builds for itself.
/// The lookup and the start happen in one turn, so two requests cannot both start one. After
/// waiting out a stuck build, look again: another waiter may already have started the replacement.
/// `build` resolves to data every waiter can use (never one Response: see sharedCopy).
export async function shareWork(key, ctx, build) {
  let out = WAITED_OUT;
  while (out === WAITED_OUT) {
    const entry = building.get(key);
    const left = entry ? SHARE_WAIT_MS - (Date.now() - entry.at) : 0;
    out = await (left > 0 ? waitFor(entry.work, left) : startBuild(key, ctx, build));
  }
  return out;
}
/// A key for `shareWork` per object (a D1 binding): a test's database never shares with another's.
const shareIds = new WeakMap();
let nextId = 0;
export const shareKey = (name, o) => {
  if (!shareIds.has(o)) shareIds.set(o, ++nextId);
  return `${name}#${shareIds.get(o)}`;
};
export async function cached(key, ttl, ctx, build) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = key instanceof Request ? key : new Request(`https://cache.internal/${key}`);
  const hit = cache && (await cache.match(req));
  if (hit) return clientCopy(hit);
  // Concurrent tabs hitting a cold/expired edge key share one upstream fetch.
  const copy = await shareWork(req.url, ctx, async () => {
    const body = await build();
    if (body instanceof Response) return sharedCopy(body);
    const res = json(body, 200, { "cache-control": `public, max-age=${ttl}` });
    if (cache) {
      const put = cache.put(req, res.clone());
      if (ctx?.waitUntil) ctx.waitUntil(put);
      else await put;
    }
    return sharedCopy(res);
  });
  const res = ownCopy(copy);
  return res.ok ? clientCopy(res) : res;
}
