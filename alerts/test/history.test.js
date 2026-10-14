import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sampleNetwork, measuredSeries } from "../src/network.js";
import { parseCandles } from "../src/pricehistory.js";
import { makeEnv, call, setNow, restoreNow, T0 } from "./helpers.js";
const original = fetch;
afterEach(() => { globalThis.fetch = original; restoreNow(); });
test("network: cron samples at most two blocks; history reads D1 only and keeps sparse coverage", async () => {
  setNow(T0); const e = makeEnv(), urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (String(u).endsWith("/api/")) return Response.json({ blockbook: { bestHeight: 10000, inSync: true } });
    const height = Number(String(u).split("/").at(-1));
    return Response.json({ height, time: T0 - (10000 - height) * 235, difficulty: "12000000" });
  };
  await sampleNetwork(e);
  assert.equal(urls.filter((u) => u.includes("/block/")).length, 2);
  globalThis.fetch = async () => { throw new Error("HTTP reads must not fetch upstream"); };
  const r = await call(e, "GET", "/v1/network/history?span=24h");
  assert.equal(r.status, 200); assert.equal(r.body.points.length, 2); assert.equal(r.body.avgBlockTime, 235);
  assert.ok(Math.abs(r.body.points[0].hashrate - 12000000 * 2 ** 48 / 235) < 1);
  assert.equal((await call(e, "GET", "/v1/network/history?span=bad")).status, 400);
  assert.equal((await call(makeEnv(), "GET", "/v1/network/history?span=all")).body.points.length, 0);
});
test("network: measured neighbourhood tracks changing block times, bounds response and includes newest", async () => {
  const points = Array.from({ length: 12 }, (_, i) => ({ height: i * 10, ts: i < 6 ? i * 1000 : 5000 + (i - 5) * 2000, difficulty: 2 }));
  const series = measuredSeries(points);
  assert.ok(series[0].hashrate > series.at(-1).hashrate);
  setNow(T0); const e = makeEnv();
  const insert = e.DB.raw.prepare("INSERT INTO network_samples VALUES (?, ?, 2, ?)");
  for (let i = 1; i <= 3000; i++) insert.run(i, T0 - (3000 - i) * 100, T0);
  const r = await call(e, "GET", "/v1/network/history?span=all");
  assert.ok(r.body.points.length <= 256); assert.equal(r.body.firstHeight, 1); assert.equal(r.body.lastHeight, 3000);
});
test("price: explicit spans use sorted BigONE daily close, share 1h D1 cache and retain old reply without span", async () => {
  setNow(T0); const e = makeEnv(); let requests = 0;
  const candles = Array.from({ length: 90 }, (_, i) => ({ time: new Date((T0 - i * 86400) * 1000).toISOString(), close: String(.8 + i / 100) }));
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(String(url), "https://big.one/api/v3/asset_pairs/PRL-USDT/candles?period=day1&limit=90");
    assert.equal(init.redirect, "manual");
    return Response.json({ code: 0, data: candles });
  };
  const r = await call(e, "GET", "/v1/price/history?span=7d");
  assert.equal(r.status, 200); assert.equal(r.body.source, "bigone"); assert.equal(r.body.market, "PRL-USDT"); assert.equal(r.body.quote, "USDT"); assert.equal(r.body.points.length, 7);
  assert.deepEqual(r.body.points, candles.slice(0, 7).reverse().map((c) => [Date.parse(c.time) / 1000, Number(c.close)]));
  assert.equal((await call(e, "GET", "/v1/price/history?span=90d")).body.points.length, 90); assert.equal(requests, 1);
  assert.deepEqual((await call(e, "GET", "/v1/price/history")).body, { source: null, points: [] });
  assert.equal((await call(e, "GET", "/v1/price/history?span=bad")).status, 400);
  setNow(T0 + 3600); globalThis.fetch = async () => new Response(null, { status: 500 });
  const stale = await call(e, "GET", "/v1/price/history?span=30d");
  assert.equal(stale.body.stale, true); assert.equal(stale.body.source, "bigone"); assert.equal(stale.body.ts, T0);
  assert.equal(stale.body.points.length, 30);
  assert.equal(e.DB.raw.prepare("SELECT ts FROM kv WHERE k = 'price:bigone:daily'").get().ts, T0);
  assert.equal((await call(makeEnv(), "GET", "/v1/price/history?span=30d")).status, 502);
  assert.throws(() => parseCandles({ code: 0, data: [{ time: "invalid", close: "bad" }] }));
});
test("network: read throttle, bounded backfill rounds, and failed sampling preserve existing points", async () => {
  setNow(T0); const e = makeEnv(); let blocks = 0;
  globalThis.fetch = async (u) => {
    if (String(u).endsWith("/api/")) return Response.json({ blockbook: { bestHeight: 10000, inSync: true } });
    blocks++;
    const height = Number(String(u).split("/").at(-1));
    return Response.json({ height, time: T0 - (10000 - height) * 235, difficulty: "12000000" });
  };
  for (let i = 0; i < 6; i++) { const before = blocks; setNow(T0 + i * 60); await sampleNetwork(e); assert.ok(blocks - before <= 2); }
  const saved = e.DB.rows("SELECT * FROM network_samples ORDER BY height");
  globalThis.fetch = async () => new Response(null, { status: 500 });
  await assert.rejects(sampleNetwork(e));
  assert.deepEqual(e.DB.rows("SELECT * FROM network_samples ORDER BY height"), saved);
  const limited = makeEnv({ RL_READ: { limit: async () => ({ success: false }) } });
  assert.equal((await call(limited, "GET", "/v1/network/history?span=7d")).status, 429);
});
test("price: corrupt cached daily candles trigger a refresh rather than an invalid successful reply", async () => {
  setNow(T0); const e = makeEnv();
  e.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('price:bigone:daily', ?, ?)").run(JSON.stringify({ source: "bigone", market: "PRL-USDT", quote: "USDT", points: [[T0, "bad"]] }), T0);
  globalThis.fetch = async () => Response.json({ code: 0, data: [{ time: new Date(T0 * 1000).toISOString(), close: "0.8" }] });
  const r = await call(e, "GET", "/v1/price/history?span=7d");
  assert.equal(r.status, 200); assert.deepEqual(r.body.points, [[T0, .8]]);
});
test("price: BigONE ISO times and string closes are parsed in ascending order; invalid candles fail", () => {
  const candle = { time: "2026-10-10T00:00:00Z", open: "1.36", high: "1.4489", low: "1.3032", close: "1.3883", volume: "427527.6999" };
  assert.deepEqual(parseCandles({ code: 0, data: [candle, { ...candle, time: "2026-10-09T00:00:00Z", close: "1.36" }] }), [[1791504000, 1.36], [1791590400, 1.3883]]);
  for (const patch of [{ time: "bad" }, { time: null }, { time: 1791590400000 }, { close: "0" }, { close: "-1" }, { close: "Infinity" }, { close: "1.2bad" }])
    assert.throws(() => parseCandles({ code: 0, data: [{ ...candle, ...patch }] }));
  assert.throws(() => parseCandles({ code: 1, data: [candle] }));
  assert.throws(() => parseCandles({ code: 0, data: null }));
});
test("price: concurrent spans share one BigONE refresh; the former daily cache is never served", async () => {
  setNow(T0); const e = makeEnv(); let requests = 0, release;
  const old = { source: "coinex", market: "PRLUSDT", quote: "USDT", ts: T0, points: [[T0, .11]] };
  e.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('price:coinex:daily', ?, ?)").run(JSON.stringify(old), T0);
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => { requests++; await gate; return Response.json({ code: 0, data: Array.from({ length: 90 }, (_, i) => ({ time: new Date((T0 - i * 86400) * 1000).toISOString(), close: "1.3883" })) }); };
  const pending = ["7d", "30d", "90d"].map((span) => call(e, "GET", `/v1/price/history?span=${span}`));
  release();
  const replies = await Promise.all(pending);
  assert.equal(requests, 1);
  assert.deepEqual(replies.map((r) => r.body.points.length), [7, 30, 90]);
  for (const r of replies) { assert.equal(r.status, 200); assert.equal(r.body.source, "bigone"); assert.equal(r.body.points.at(-1)[1], 1.3883); }
  const failed = makeEnv();
  failed.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('price:coinex:daily', ?, ?)").run(JSON.stringify(old), T0);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  assert.equal((await call(failed, "GET", "/v1/price/history?span=7d")).status, 502);
});
