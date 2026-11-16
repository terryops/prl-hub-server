import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sampleNetwork, rollingSeries } from "../src/network.js";
import { parseCandles, parseGateCandles, parseCoinbaseCandles, parseKrakenCandles, parseSafeTradeCandles } from "../src/pricehistory.js";
import { fetchQuotes } from "../src/price.js";
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
  // Two samples 14 blocks apart are not 200 blocks of history: no estimate yet.
  assert.deepEqual(r.body.points.map((p) => [p.hashrate, p.blockTime]), [[null, null], [null, null]]);
  assert.equal(r.body.window, 200);
  assert.equal((await call(e, "GET", "/v1/network/history?span=bad")).status, 400);
  assert.equal((await call(makeEnv(), "GET", "/v1/network/history?span=all")).body.points.length, 0);
});
test("network: each point is the work of the 200 blocks behind it over their time, bounded and with the newest", async () => {
  // Block times of 100 s, then 50 s for the last 200 blocks; samples every 10 blocks.
  const samples = Array.from({ length: 101 }, (_, i) => ({ height: i * 10, ts: i <= 80 ? i * 1000 : 80000 + (i - 80) * 500, difficulty: 4e6 }));
  const series = rollingSeries(samples, samples), at = (h) => series.find((p) => p.height === h);
  assert.equal(at(190).hashrate, null); assert.equal(at(190).blockTime, null);
  assert.equal(at(800).blockTime, 100); assert.equal(at(800).hashrate, 4e6 * 2 ** 48 / 100);
  assert.equal(at(1000).blockTime, 50); assert.equal(at(1000).hashrate, 4e6 * 2 ** 48 / 50);
  assert.equal(at(900).blockTime, 75);
  // Sparse samples are interpolated: the window stays 200 blocks.
  const sparse = samples.filter((p) => p.height % 300 === 0);
  assert.equal(rollingSeries([at(800)], sparse)[0].blockTime, 100);
  setNow(T0); const e = makeEnv();
  const insert = e.DB.raw.prepare("INSERT INTO network_samples VALUES (?, ?, 2, ?)");
  for (let i = 1; i <= 3000; i++) insert.run(i, T0 - (3000 - i) * 100, T0);
  const r = await call(e, "GET", "/v1/network/history?span=all");
  assert.ok(r.body.points.length <= 256); assert.equal(r.body.firstHeight, 1); assert.equal(r.body.lastHeight, 3000);
  assert.ok(r.body.points.filter((p) => p.height > 200).every((p) => p.blockTime === 100 && p.hashrate === 2 * 2 ** 48 / 100));
});
test("network: spans start with estimates from the blocks before them and share the change anchors", async () => {
  setNow(T0); const e = makeEnv();
  const insert = e.DB.raw.prepare("INSERT INTO network_samples VALUES (?, ?, ?, ?)");
  // One sample per block for 40 days at 150 s, faster (120 s) over the last 10 days.
  const start = T0 - 40 * 86400, blocks = []; let ts = start;
  for (let h = 1; ts <= T0; h++) { blocks.push({ h, ts }); ts += T0 - ts < 10 * 86400 ? 120 : 150; }
  for (const b of blocks) insert.run(b.h, b.ts, 3e7, T0);
  const tip = blocks.at(-1), spans = {};
  for (const span of ["24h", "7d", "30d", "all"]) spans[span] = (await call(e, "GET", `/v1/network/history?span=${span}`)).body;
  for (const [span, body] of Object.entries(spans)) {
    assert.ok(body.points.length <= 256, span);
    assert.equal(body.points.at(-1).height, tip.h, `${span} ends at the newest block`);
    // The first point already has 200 blocks behind it (from before the span), except at the chain's start.
    if (span !== "all") assert.ok(body.points[0].hashrate > 0, `${span} first estimate`);
    assert.equal(body.points.at(-1).blockTime, 120);
  }
  // The sample nearest each anchor is in every span that reaches it, with the same estimate.
  const nearest = (back) => blocks.reduce((a, b) => Math.abs(b.ts - (tip.ts - back)) < Math.abs(a.ts - (tip.ts - back)) ? b : a).h;
  for (const [back, names] of [[86400, ["24h", "7d", "30d", "all"]], [3 * 86400, ["7d", "30d", "all"]], [7 * 86400, ["7d", "30d", "all"]], [30 * 86400, ["30d", "all"]]]) {
    const found = names.map((n) => spans[n].points.find((p) => p.height === nearest(back)));
    assert.ok(found.every(Boolean), `anchor ${back / 86400}d in ${names}`);
    assert.ok(found.every((p) => p.hashrate === found[0].hashrate), `anchor ${back / 86400}d agrees`);
  }
  // Ten days ago blocks took 150 s: the 30d anchor's estimate is the slower rate.
  assert.equal(spans["30d"].points.find((p) => p.height === nearest(30 * 86400)).blockTime, 150);
});
test("network: a span reads a few hundred samples however many D1 holds (\"all\" once spread the whole table into Math.min)", async () => {
  setNow(T0); const e = makeEnv();
  // 150,000 samples, about 80 days of the cron's one or two a minute: past the ~125,000 that overflowed.
  const n = 150000, insert = e.DB.raw.prepare("INSERT INTO network_samples VALUES (?, ?, 3, ?)");
  e.DB.raw.exec("BEGIN"); for (let i = 1; i <= n; i++) insert.run(i, T0 - (n - i) * 45, T0); e.DB.raw.exec("COMMIT");
  let read = 0;
  const all = e.DB.raw.prepare.bind(e.DB.raw);
  e.DB.raw.prepare = (sql) => { const st = all(sql), get = st.all.bind(st), one = st.get.bind(st);
    st.all = (...a) => { const r = get(...a); read += r.length; return r; }; st.get = (...a) => { const r = one(...a); read += r ? 1 : 0; return r; }; return st; };
  for (const span of ["all", "30d", "7d", "24h"]) {
    const r = await call(e, "GET", `/v1/network/history?span=${span}`);
    assert.equal(r.status, 200, span);
    assert.ok(r.body.points.length > 100 && r.body.points.length <= 256, `${span}: ${r.body.points.length} points`);
    assert.equal(r.body.lastHeight, n);
    assert.ok(r.body.points.filter((p) => p.height > 200).every((p) => p.blockTime === 45), span);
  }
  assert.ok(read < 4 * 1500, `rows handed back for four spans: ${read}`);
});
test("price: explicit spans use Gate daily close, share 1h D1 cache, fall back to Coinbase / Kraken, and retain old reply without span", async () => {
  setNow(T0); const e = makeEnv(); let requests = 0;
  // 90 Gate candlesticks [ts, quote_vol, close, high, low, open, base_vol, closed]
  const candles = Array.from({ length: 90 }, (_, i) => [String(T0 - (89 - i) * 86400), "1000000", String(0.8 + i / 100), "2", "0.5", "1", "500000", "true"]);
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(String(url), "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=PEARL_USDT&interval=1d&limit=90");
    assert.equal(init.redirect, "manual");
    return Response.json(candles);
  };
  const r = await call(e, "GET", "/v1/price/history?span=7d");
  assert.equal(r.status, 200); assert.equal(r.body.source, "gate"); assert.equal(r.body.market, "PEARL/USDT"); assert.equal(r.body.quote, "USDT"); assert.equal(r.body.points.length, 7);
  assert.deepEqual(r.body.points, candles.slice(-7).map((c) => [Number(c[0]), Number(c[2])]));
  assert.equal((await call(e, "GET", "/v1/price/history?span=90d")).body.points.length, 90); assert.equal(requests, 1);
  assert.deepEqual((await call(e, "GET", "/v1/price/history")).body, { source: null, points: [] });
  assert.equal((await call(e, "GET", "/v1/price/history?span=bad")).status, 400);
  setNow(T0 + 3600); globalThis.fetch = async () => new Response(null, { status: 500 });
  const stale = await call(e, "GET", "/v1/price/history?span=30d");
  assert.equal(stale.body.stale, true); assert.equal(stale.body.source, "gate"); assert.equal(stale.body.ts, T0);
  assert.equal(stale.body.points.length, 30);
  assert.equal(e.DB.raw.prepare("SELECT ts FROM kv WHERE k = 'price:daily:v2'").get().ts, T0);
  assert.equal((await call(makeEnv(), "GET", "/v1/price/history?span=30d")).status, 502);
  assert.throws(() => parseCandles([["invalid", "0", "bad"]]));
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
test("price: Gate 25-day series serves pure Gate for 7d and SafeTrade+Gate backfill for 30d/90d; Coinbase & Kraken stand in when Gate is down", async () => {
  // Simulate 2026-11-16 UTC midnight (1794787200), with Gate having 25 candles since 2026-10-23 (1792713600).
  const T_NOV16 = 1794787200;
  setNow(T_NOV16);
  const e = makeEnv();
  const gate25 = Array.from({ length: 25 }, (_, i) => [String(1792713600 + i * 86400), "2000000", String(1.5 + i * 0.005), "2", "1", "1.5", "1000000", "true"]);
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === "api.gateio.ws") return Response.json(gate25);
    return new Response("down", { status: 503 });
  };

  const r7 = await call(e, "GET", "/v1/price/history?span=7d");
  assert.equal(r7.status, 200);
  assert.equal(r7.body.source, "gate");
  assert.equal(r7.body.market, "PEARL/USDT");
  assert.equal(r7.body.points.length, 7);

  const r30 = await call(e, "GET", "/v1/price/history?span=30d");
  assert.equal(r30.body.source, "safetrade+gate");
  assert.equal(r30.body.points.length, 30);

  const r90 = await call(e, "GET", "/v1/price/history?span=90d");
  assert.equal(r90.body.source, "safetrade+gate");
  assert.equal(r90.body.points.length, 90);
  assert.ok(r90.body.points.every((p, idx) => idx === 0 || p[0] > r90.body.points[idx - 1][0]));

  // After TTL expires, if Gate fails and Coinbase answers 4 recent daily candles, 30d/90d remain complete without gaps.
  setNow(T_NOV16 + 3700);
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === "api.exchange.coinbase.com") {
      return Response.json([
        [1794787200, 1.49, 1.70, 1.50, 1.6196, 890000],
        [1794700800, 1.48, 1.80, 1.51, 1.7884, 920000],
        [1794614400, 1.45, 1.60, 1.51, 1.5021, 710000],
        [1794528000, 1.38, 1.58, 1.40, 1.5113, 640000],
      ]);
    }
    return new Response("down", { status: 503 });
  };
  const cb30 = await call(e, "GET", "/v1/price/history?span=30d");
  assert.equal(cb30.status, 200);
  assert.equal(cb30.body.source, "safetrade+coinbase");
  assert.equal(cb30.body.quote, "USD");
  assert.equal(cb30.body.points.length, 30);
  assert.equal(cb30.body.points.at(-1)[1], 1.6196);
});
test("price: pushed SafeTrade daily candles take precedence without upstream fetch, and Kraken fallback works", async () => {
  setNow(T0);
  const e = makeEnv({ INGEST_TOKEN: "sec-tok" });
  const daily90 = Array.from({ length: 90 }, (_, i) => [T0 - (89 - i) * 86400, 1.2, 1.5, 1.1, 1.35 + i * 0.001, 100000]);
  const ing = await call(
    e,
    "POST",
    "/v1/ingest/safetrade",
    { at: T0, ticker: { last: "1.61", open: "1.50", volume: "3400000" }, daily: daily90 },
    { authorization: "Bearer sec-tok" },
  );
  assert.equal(ing.status, 200);

  globalThis.fetch = async () => { throw new Error("must not call upstream when pushed SafeTrade daily is fresh"); };
  const r = await call(e, "GET", "/v1/price/history?span=90d");
  assert.equal(r.status, 200);
  assert.equal(r.body.source, "safetrade");
  assert.equal(r.body.market, "PEARL/USDT");
  assert.equal(r.body.points.length, 90);

  // Separate env testing Kraken fallback when Gate and Coinbase return 503.
  const eKr = makeEnv();
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === "api.kraken.com") {
      return Response.json({
        error: [],
        result: {
          PEARLUSD: Array.from({ length: 90 }, (_, i) => [T0 - (89 - i) * 86400, "1.4", "1.6", "1.3", String(1.45 + i * 0.001), "1.5", "10000", 500]),
          last: T0,
        },
      });
    }
    return new Response("down", { status: 503 });
  };
  const kr = await call(eKr, "GET", "/v1/price/history?span=90d");
  assert.equal(kr.status, 200);
  assert.equal(kr.body.source, "kraken");
  assert.equal(kr.body.quote, "USD");
  assert.equal(kr.body.points.length, 90);
});
test("price: corrupt cached daily candles trigger a refresh rather than an invalid successful reply", async () => {
  setNow(T0); const e = makeEnv();
  e.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('price:daily:v2', ?, ?)").run(JSON.stringify({ source: "gate", market: "PEARL/USDT", quote: "USDT", points: [[T0, "bad"]] }), T0);
  const candles = Array.from({ length: 90 }, (_, i) => [String(T0 - (89 - i) * 86400), "1000", "0.8", "0.9", "0.7", "0.8", "1000", "true"]);
  globalThis.fetch = async () => Response.json(candles);
  const r = await call(e, "GET", "/v1/price/history?span=7d");
  assert.equal(r.status, 200); assert.equal(r.body.points.at(-1)[1], 0.8);
});
test("price: Gate, Coinbase, Kraken and SafeTrade candle parsers sort ascending and reject malformed rows", () => {
  assert.deepEqual(
    parseGateCandles([["1791590400", "100", "1.3883", "1.4", "1.3", "1.36", "70", "true"], ["1791504000", "100", "1.36", "1.4", "1.3", "1.35", "70", "true"]]),
    [[1791504000, 1.36], [1791590400, 1.3883]],
  );
  assert.deepEqual(
    parseCoinbaseCandles([[1791590400, 1.3, 1.4, 1.36, 1.3883, 100], [1791504000, 1.3, 1.4, 1.35, 1.36, 100]]),
    [[1791504000, 1.36], [1791590400, 1.3883]],
  );
  assert.deepEqual(
    parseKrakenCandles({ error: [], result: { PEARLUSD: [[1791504000, "1.35", "1.4", "1.3", "1.36", "1.36", "100", 10]], last: 1791504000 } }),
    [[1791504000, 1.36]],
  );
  assert.deepEqual(
    parseSafeTradeCandles([[1791504000, "1.35", "1.4", "1.3", "1.36", "100"]]),
    [[1791504000, 1.36]],
  );
  for (const bad of [[["bad", "0", "1.2"]], [["1791590400", "0", "0"]], [["1791590400", "0", "-1"]], [["1791590400", "0", "Infinity"]], [["1791590400", "0", "1.2bad"]]]) {
    assert.throws(() => parseGateCandles(bad));
  }
  assert.throws(() => parseKrakenCandles({ error: ["EQuery:Unknown asset pair"], result: {} }));
  assert.throws(() => parseSafeTradeCandles([]));
});
test("price: concurrent spans share one refresh; legacy bigone and coinex daily caches are never served", async () => {
  setNow(T0); const e = makeEnv(); let requests = 0, release;
  const oldCoinex = { source: "coinex", market: "PRLUSDT", quote: "USDT", ts: T0, points: [[T0, .11]] };
  const oldBigone = { source: "bigone", market: "PEARL-USDT", quote: "USDT", ts: T0, points: [[T0, 1.51]] };
  e.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('price:coinex:daily', ?, ?)").run(JSON.stringify(oldCoinex), T0);
  e.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('price:bigone:daily', ?, ?)").run(JSON.stringify(oldBigone), T0);
  const gateLatch = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    requests++;
    await gateLatch;
    return Response.json(Array.from({ length: 90 }, (_, i) => [String(T0 - (89 - i) * 86400), "1000", "1.3883", "1.4", "1.3", "1.38", "800", "true"]));
  };
  const pending = ["7d", "30d", "90d"].map((span) => call(e, "GET", `/v1/price/history?span=${span}`));
  release();
  const replies = await Promise.all(pending);
  assert.equal(requests, 1);
  assert.deepEqual(replies.map((r) => r.body.points.length), [7, 30, 90]);
  for (const r of replies) { assert.equal(r.status, 200); assert.equal(r.body.source, "gate"); assert.equal(r.body.points.at(-1)[1], 1.3883); }
  const failed = makeEnv();
  failed.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('price:coinex:daily', ?, ?)").run(JSON.stringify(oldCoinex), T0);
  failed.DB.raw.prepare("INSERT INTO kv (k, v, ts) VALUES ('price:bigone:daily', ?, ?)").run(JSON.stringify(oldBigone), T0);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  assert.equal((await call(failed, "GET", "/v1/price/history?span=7d")).status, 502);
});
