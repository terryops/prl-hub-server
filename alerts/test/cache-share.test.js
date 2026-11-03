import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { cached, SHARE_WAIT_MS } from "../src/http.js";
import { fx, FX_CODES } from "../src/fx.js";
import { longPriceHistory } from "../src/pricehistory.js";

// Node has no `caches`, so every call misses the edge cache and reaches the shared-fetch logic.
const flush = () => new Promise((resolve) => setImmediate(resolve));
let n = 0;
const key = () => `test/share-${++n}`;
const body = async (res) => (await res).json();

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 }));
test.afterEach(() => mock.timers.reset());

test("cached: concurrent requests share one fetch", async () => {
  const k = key();
  let builds = 0, release;
  const build = () => { builds++; return new Promise((resolve) => { release = () => resolve({ v: 1 }); }); };
  const a = cached(k, 15, null, build), b = cached(k, 15, null, build);
  await flush(); release();
  assert.deepEqual(await body(a), { v: 1 });
  assert.deepEqual(await body(b), { v: 1 });
  assert.equal(builds, 1);
});

test("cached: a fetch that never settles holds later requests at most SHARE_WAIT_MS, then is replaced", async () => {
  const k = key();
  let builds = 0;
  // The request that started it was cut off: its promise never settles.
  void cached(k, 15, null, () => { builds++; return new Promise(() => {}); });
  await flush();
  let done = false;
  const waiter = cached(k, 15, null, async () => { builds++; return { v: 2 }; }).then((r) => { done = true; return r; });
  await flush();
  mock.timers.tick(SHARE_WAIT_MS - 1); await flush();
  assert.equal(done, false, "still within the shared wait");
  mock.timers.tick(1); await flush();
  assert.deepEqual(await body(waiter), { v: 2 });
  assert.equal(builds, 2);
  // The stuck fetch is gone: the next request does not wait on it.
  let third = 0;
  assert.deepEqual(await body(cached(k, 15, null, async () => { third++; return { v: 3 }; })), { v: 3 });
  assert.equal(third, 1);
});

test("cached: requests waiting out the same stuck fetch start one replacement between them", async () => {
  const k = key();
  void cached(k, 15, null, () => new Promise(() => {}));
  await flush();
  let builds = 0, release;
  const build = () => { builds++; return new Promise((resolve) => { release = () => resolve({ v: 10 }); }); };
  const waiters = [cached(k, 15, null, build), cached(k, 15, null, build), cached(k, 15, null, build)];
  await flush();
  mock.timers.tick(SHARE_WAIT_MS); await flush();
  assert.equal(builds, 1);
  release();
  for (const w of waiters) assert.deepEqual(await body(w), { v: 10 });
});

test("cached: a request arriving after the stuck fetch is SHARE_WAIT_MS old does not wait at all", async () => {
  const k = key();
  void cached(k, 15, null, () => new Promise(() => {}));
  await flush();
  mock.timers.tick(SHARE_WAIT_MS);
  // No more ticks: it must resolve without a timer.
  assert.deepEqual(await body(cached(k, 15, null, async () => ({ v: 4 }))), { v: 4 });
});

test("cached: a slow fetch that finishes inside the wait is shared, not repeated", async () => {
  const k = key();
  let builds = 0, release;
  const first = cached(k, 15, null, () => { builds++; return new Promise((resolve) => { release = () => resolve({ v: 5 }); }); });
  await flush();
  mock.timers.tick(SHARE_WAIT_MS - 2000);
  const waiter = cached(k, 15, null, async () => { builds++; return { v: 6 }; });
  await flush();
  mock.timers.tick(1000); await flush();
  release();
  assert.deepEqual(await body(waiter), { v: 5 });
  assert.deepEqual(await body(first), { v: 5 });
  assert.equal(builds, 1);
});

test("cached: a failed shared fetch fails its waiters and the next request fetches again", async () => {
  const k = key();
  let fail;
  const first = cached(k, 15, null, () => new Promise((_, reject) => { fail = () => reject(new Error("d1 down")); }));
  await flush();
  const waiter = cached(k, 15, null, async () => ({ v: 7 }));
  await flush();
  fail();
  await assert.rejects(first, /d1 down/);
  await assert.rejects(waiter, /d1 down/);
  assert.deepEqual(await body(cached(k, 15, null, async () => ({ v: 8 }))), { v: 8 });
});

test("cached: an error Response from the builder reaches waiters with its status", async () => {
  const k = key();
  let release;
  const first = cached(k, 15, null, () => new Promise((resolve) => { release = () => resolve(Response.json({ error: "no price yet" }, { status: 503 })); }));
  const waiter = cached(k, 15, null, async () => ({ v: 9 }));
  await flush(); release();
  for (const r of [await first, await waiter]) { assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: "no price yet" }); }
});

// fx and the long price history share their D1-backed refresh the same way (`share`): on 2026-10-23
// a stalled D1 call kept their old WeakMap promises pending, and every later request on the isolate hung.
for (const [name, row, call, check] of [
  ["fx", { ok: true, base: "USD", ts: 1000, rates: Object.fromEntries(FX_CODES.map((c) => [c, 2])) },
   (env) => fx(env, null), (o) => assert.equal(o.rates.CNY, 2)],
  ["the long price history", { source: "bigone", market: "PEARL-USDT", quote: "USDT", ts: 1000, points: [[1, 0.5], [2, 0.6]] },
   (env) => longPriceHistory(env, "7d", null), (o) => assert.deepEqual(o.points, [[1, 0.5], [2, 0.6]])],
]) {
  test(`${name}: a refresh stuck on D1 holds later requests at most SHARE_WAIT_MS`, async () => {
    let reads = 0;
    // The first read never answers (the stall); later ones find a fresh row (ts = now, 1000 s).
    const DB = { prepare: () => ({ bind() { return this; }, first: () => ++reads === 1 ? new Promise(() => {}) : Promise.resolve({ v: JSON.stringify(row), ts: 1000 }) }) };
    const env = { DB };
    void call(env);
    await flush();
    let done = false;
    const waiter = call(env).then((r) => { done = true; return r; });
    await flush();
    mock.timers.tick(SHARE_WAIT_MS - 1); await flush();
    assert.equal(done, false, "still within the shared wait");
    mock.timers.tick(1); await flush();
    const res = await waiter;
    assert.equal(res.status, 200);
    check(await res.json());
    assert.equal(reads, 2);
  });
}
