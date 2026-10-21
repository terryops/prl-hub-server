import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FX_CODES } from "../src/fx.js";
import { makeEnv, call, setNow, restoreNow, T0 } from "./helpers.js";
const original = fetch;
afterEach(() => { globalThis.fetch = original; restoreNow(); });
test("fx: curated USD rates persist, refresh at twelve hours, and stale fallback", async () => {
  setNow(T0); const e = makeEnv(); let calls = 0;
  const rates = Object.fromEntries([...FX_CODES, "USD", "CHF"].map((c) => [c, c === "CNY" ? 7.1 : 2]));
  globalThis.fetch = async () => { calls++; return Response.json({ rates }); };
  const r = await call(e, "GET", "/v1/fx");
  assert.equal(r.status, 200); assert.equal(r.body.base, "USD"); assert.equal(r.body.ts, T0);
  assert.deepEqual(Object.keys(r.body.rates).sort(), [...FX_CODES].sort());
  setNow(T0 + 43199); assert.deepEqual(await call(e, "GET", "/v1/fx"), r); assert.equal(calls, 1);
  setNow(T0 + 43200); globalThis.fetch = async () => new Response(null, { status: 500 });
  const stale = await call(e, "GET", "/v1/fx"); assert.equal(stale.status, 200); assert.equal(stale.body.stale, true); assert.equal(stale.body.ts, T0);
  assert.equal((await call(makeEnv(), "GET", "/v1/fx")).status, 503);
  assert.equal((await call(makeEnv({ RL_READ: { limit: async () => ({ success: false }) } }), "GET", "/v1/fx")).status, 429);
});
test("fx: concurrent reads share one fetch, malformed/base-mismatched rates never replace the cache", async () => {
  setNow(T0); const e = makeEnv(); let requests = 0;
  const rates = Object.fromEntries(FX_CODES.map((c) => [c, 2]));
  globalThis.fetch = async () => { requests++; return Response.json({ result: "success", base_code: "USD", rates }); };
  const replies = await Promise.all(Array.from({ length: 4 }, () => call(e, "GET", "/v1/fx")));
  assert.equal(requests, 1); assert.ok(replies.every((r) => r.status === 200));
  setNow(T0 + 43200);
  for (const data of [{ rates: { ...rates, JPY: 0 } }, { rates: { ...rates, CNY: "2" } }, { base_code: "EUR", rates }, { result: "error", rates }]) {
    globalThis.fetch = async () => Response.json(data);
    const r = await call(e, "GET", "/v1/fx");
    assert.equal(r.body.stale, true); assert.equal(r.body.ts, T0);
    assert.equal(e.DB.one("SELECT ts FROM kv WHERE k = 'fx:USD'").ts, T0);
  }
});
test("fx and the long price history: the shared refresh is handed to waitUntil, so a reader that leaves cannot strand the rest", async () => {
  setNow(T0);
  const { fx } = await import("../src/fx.js"), { longPriceHistory } = await import("../src/pricehistory.js");
  const rates = Object.fromEntries(FX_CODES.map((c) => [c, 2]));
  for (const [read, reply] of [[(env, ctx) => fx(env, ctx), () => Response.json({ rates })],
    [(env, ctx) => longPriceHistory(env, "7d", ctx), () => Response.json({ code: 0, data: [{ open: "1", close: "1", high: "1", low: "1", volume: "1", time: new Date(T0 * 1000).toISOString() }] })]]) {
    globalThis.fetch = async () => reply();
    const kept = [], ctx = { waitUntil: (p) => kept.push(p) };
    await read(makeEnv(), ctx);
    assert.equal(kept.length, 1);
    await kept[0];
  }
});
