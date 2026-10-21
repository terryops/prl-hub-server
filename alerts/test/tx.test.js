import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tx, TX_ROWS, TX_PER_IP } from "../src/chain.js";
import { makeEnv, call, setNow, restoreNow, T0 } from "./helpers.js";

const original = fetch;
afterEach(() => { globalThis.fetch = original; delete globalThis.caches; restoreNow(); });

const a = "prl1" + "a".repeat(58), b = "prl1" + "b".repeat(58);
// Mainnet block 130529's coinbase, as Blockbook returned it on 2026-10-20 (hex fields shortened).
const coinbase = {
  txid: "fbbb96eb840f79e9b166f613ceac23bfb5d4ba4acd995faa21eece2f1cfd7a3c", version: 2,
  vin: [{ sequence: 4294967295, n: 0, isAddress: false, coinbase: "03e1fd01" }],
  vout: [
    { value: "224003412204", n: 0, hex: "5120e31e", addresses: ["prl1puv0gqv4x0wd0ylwz086y3sqrg4a6umza9r08aecehjrmdqq7mctsmqaqsh"], isAddress: true },
    { value: "0", n: 1, hex: "6a24aa21", addresses: [], isAddress: false },
  ],
  blockHash: "efc93ab4fdf46b4ae938fa36974c289cd8e10066fcc9a7156568a90c5e97e16c", blockHeight: 130529, confirmations: 3,
  blockTime: 1792463603, size: 268, vsize: 241, value: "224003412204", valueIn: "0", fees: "0",
};
const reply = (o, status = 200) => async () => Response.json(o, { status });
// A fresh database each time, so these lookups never meet the per-IP limit.
const lookup = async (txid) => { const r = await tx(makeEnv(), { txid }, {}, "198.51.100.7"); return { status: r.status, body: await r.json() }; };

test("tx: a coinbase has no inputs, and its OP_RETURN output is marked as data", async () => {
  let requested;
  globalThis.fetch = async (url) => { requested = String(url); return Response.json(coinbase); };
  const { status, body } = await lookup(coinbase.txid.toUpperCase() + "  ");
  assert.equal(status, 200);
  assert.equal(requested, `https://blockbook.pearlresearch.ai/api/v2/tx/${coinbase.txid}`);
  assert.deepEqual(body, {
    ok: true, txid: coinbase.txid, confirmations: 3, height: 130529, blockHash: coinbase.blockHash, time: 1792463603,
    size: 268, vsize: 241, value: "224003412204", fee: "0", coinbase: true, inputCount: 0, outputCount: 2, inputs: [],
    outputs: [{ address: coinbase.vout[0].addresses[0], value: "224003412204" }, { address: null, value: "0", data: true }],
  });
});

test("tx: a mempool transaction has no block, and a payout lists at most TX_ROWS outputs", async () => {
  const txid = "ab".repeat(32);
  const vout = Array.from({ length: TX_ROWS + 5 }, (_, n) => ({ n, value: String(1000 + n), addresses: [n % 2 ? a : b], isAddress: true }));
  globalThis.fetch = reply({ txid, vin: [{ txid: "cd".repeat(32), addresses: [a], isAddress: true, value: "9007199254740993" }], vout,
    blockHeight: -1, confirmations: 0, blockTime: 1792463700, value: "9007199254700000", fees: "40993" });
  const { status, body } = await lookup(txid);
  assert.equal(status, 200);
  assert.equal(body.confirmations, 0); assert.equal(body.height, null); assert.equal(body.blockHash, null);
  assert.equal(body.time, 1792463700); assert.equal(body.size, null);
  assert.deepEqual(body.inputs, [{ address: a, value: "9007199254740993" }]);
  assert.equal(body.inputCount, 1); assert.equal(body.outputCount, TX_ROWS + 5); assert.equal(body.outputs.length, TX_ROWS);
  assert.equal(body.fee, "40993"); assert.equal(body.coinbase, false);
});

test("tx: unknown, malformed and failed lookups", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ error: `Transaction '${"0".repeat(64)}' not found` }, { status: 400 }); };
  assert.deepEqual(await lookup("0".repeat(64)), { status: 404, body: { ok: false, error: "not found" } });
  for (const bad of ["", "0".repeat(63), "g".repeat(64), "0".repeat(65), 7, null]) assert.equal((await lookup(bad)).status, 400);
  assert.equal(requests, 2, "one request to each indexer");
  for (const upstream of [
    reply({ error: "Internal error" }, 400), reply({}, 500), reply({ ...coinbase, txid: "ab".repeat(32) }),
    reply({ ...coinbase, vout: [{ value: "-1", addresses: [a], isAddress: true }] }), reply({ ...coinbase, vin: null }),
    async () => new Response("<html>", { status: 400 }), async () => { throw new TypeError("network"); },
  ]) {
    globalThis.fetch = upstream;
    assert.deepEqual(await lookup(coinbase.txid), { status: 502, body: { ok: false, error: "upstream" } });
  }
});

test("tx route: read rate limit, hashed edge cache key, and an unknown txid is not cached", async () => {
  const env = makeEnv();
  let key, stored, requests = 0;
  globalThis.caches = { default: { match: async (req) => { key = req.url; return stored?.clone(); }, put: async (_req, res) => { stored = res; } } };
  globalThis.fetch = async () => { requests++; return Response.json({ error: "not found" }, { status: 400 }); };
  assert.equal((await call(env, "POST", "/v1/tx", { txid: coinbase.txid })).status, 404);
  assert.equal(stored, undefined);
  globalThis.fetch = async () => { requests++; return Response.json(coinbase); };
  const r = await call(env, "POST", "/v1/tx", { txid: coinbase.txid });
  assert.equal(r.status, 200); assert.equal(r.body.height, 130529);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(!key.includes(coinbase.txid));
  assert.equal(stored.headers.get("cache-control"), "public, max-age=30");
  await call(env, "POST", "/v1/tx", { txid: coinbase.txid });
  assert.equal(requests, 4, "two lookups reached the indexers (one each); the third was a cache hit");
  assert.equal((await call(env, "GET", "/v1/tx")).status, 404);
  env.RL_READ = { limit: async () => ({ success: false }) };
  assert.equal((await call(env, "POST", "/v1/tx", { txid: coinbase.txid })).status, 429);
});

test("tx limits: five lookups per IP a minute, cache hits included; 60 Blockbook fetches a minute in all", async () => {
  setNow(T0 + 5);
  const env = makeEnv(), stored = new Map();
  let requests = 0;
  globalThis.caches = { default: { match: async (req) => stored.get(req.url)?.clone(), put: async (req, res) => { stored.set(req.url, res); } } };
  // Counts the official indexer's fetches; ours is asked alongside each one.
  globalThis.fetch = async (url) => { if (String(url).startsWith("https://blockbook.pearlresearch.ai/")) requests++; return Response.json({ ...coinbase, txid: String(url).split("/").pop() }); };
  const ask = async (txid, ip) => { const r = await tx(env, { txid }, {}, ip); return { status: r.status, body: await r.json() }; };
  // The same txid five times: one fetch, then cache hits, which still count for the IP.
  for (let i = 0; i < TX_PER_IP; i++) assert.equal((await ask(coinbase.txid, "203.0.113.1")).status, 200);
  assert.equal(requests, 1);
  assert.deepEqual(await ask(coinbase.txid, "203.0.113.1"), { status: 429, body: { ok: false, error: "busy", retry_after: 55 } });
  assert.equal((await ask("zz", "203.0.113.1")).status, 400, "a malformed txid is refused before the limit");
  assert.equal((await ask(coinbase.txid, "203.0.113.2")).status, 200, "another IP has its own five");
  // 60 different txids from many IPs fetch; the 61st is refused, while a cached one is still served.
  for (let i = 1; i < 60; i++) assert.equal((await ask(i.toString(16).padStart(64, "0"), `10.0.0.${i}`)).status, 200);
  assert.equal(requests, 60);
  assert.equal((await ask("f".repeat(64), "10.0.1.1")).status, 429);
  assert.equal(requests, 60);
  assert.equal((await ask(coinbase.txid, "10.0.1.2")).status, 200);
  // The next minute starts over for both.
  setNow(T0 + 65);
  assert.equal((await ask(coinbase.txid, "203.0.113.1")).status, 200);
  assert.equal((await ask("f".repeat(64), "10.0.1.1")).status, 200);
  assert.equal(requests, 61);
});

test("tx limits: with the RL_TX binding the per-IP count costs no D1 write, and lookups and broadcasts count apart", async () => {
  setNow(T0 + 5);
  const counts = new Map(), keys = [];
  const env = makeEnv({ RL_TX: { limit: async ({ key }) => { keys.push(key); counts.set(key, (counts.get(key) ?? 0) + 1); return { success: counts.get(key) <= TX_PER_IP }; } } });
  globalThis.caches = undefined;
  globalThis.fetch = async (url) => Response.json({ ...coinbase, txid: String(url).split("/").pop() });
  for (let i = 0; i < TX_PER_IP; i++) assert.equal((await tx(env, { txid: coinbase.txid }, {}, "203.0.113.1")).status, 200);
  const r = await tx(env, { txid: coinbase.txid }, {}, "203.0.113.1");
  assert.equal(r.status, 429); assert.equal((await r.json()).error, "busy");
  assert.equal(env.DB.rows("SELECT * FROM kv WHERE k LIKE 'pb:ip:%'").length, 0);
  assert.ok(keys.every((k) => k.startsWith("Blockbook-tx:") && !k.includes("203.0.113.1")), "the IP is hashed");
  const { sendTx } = await import("../src/chain.js");
  globalThis.fetch = async () => Response.json({ result: coinbase.txid });
  assert.notEqual((await sendTx(env, { hex: "00".repeat(60) }, "203.0.113.1")).status, 429, "broadcasts have their own five");
  assert.ok(keys.at(-1).startsWith("broadcast:"));
});

// ── both indexers ──
const OWN_TX = (id) => `https://node.pearlhub.net/api/v2/tx/${id}`, OFFICIAL_TX = (id) => `https://blockbook.pearlresearch.ai/api/v2/tx/${id}`;
const mined = { ...coinbase }, stale = { ...coinbase, confirmations: 0, blockHeight: -1, blockHash: undefined };
const answers = (own, official) => {
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return (String(url) === OWN_TX(coinbase.txid) ? own : official)(); };
  return asked;
};
const NOT_FOUND = () => Response.json({ error: `Transaction '${coinbase.txid}' not found` }, { status: 400 });
const UNHEALTHY = () => Response.json({ error: "node unhealthy" }, { status: 503 });

test("tx: asks our own indexer and the official one, and shows the copy furthest along", async () => {
  // Seen 2026-10-20: the official indexer listed a mined transaction as unconfirmed.
  let asked = answers(() => Response.json(mined), () => Response.json(stale));
  assert.equal((await lookup(coinbase.txid)).body.confirmations, 3);
  assert.deepEqual(asked.sort(), [OFFICIAL_TX(coinbase.txid), OWN_TX(coinbase.txid)].sort());
  answers(() => Response.json(stale), () => Response.json(mined));
  assert.equal((await lookup(coinbase.txid)).body.height, 130529);
  // Ours refuses reads while it catches up, or is unreachable: the official one answers alone.
  for (const own of [UNHEALTHY, () => { throw new TypeError("down"); }, NOT_FOUND]) {
    answers(own, () => Response.json(mined));
    assert.equal((await lookup(coinbase.txid)).body.confirmations, 3);
  }
  // The official one is down or does not know it: ours answers alone.
  for (const official of [() => Response.json({}, { status: 500 }), () => { throw new TypeError("down"); }, NOT_FOUND]) {
    answers(() => Response.json(stale), official);
    const { status, body } = await lookup(coinbase.txid);
    assert.equal(status, 200); assert.equal(body.confirmations, 0);
  }
});

test("tx: not found only when an indexer says so and none has it; no answer at all is upstream", async () => {
  answers(NOT_FOUND, NOT_FOUND);
  assert.equal((await lookup(coinbase.txid)).status, 404);
  answers(UNHEALTHY, NOT_FOUND);
  assert.equal((await lookup(coinbase.txid)).status, 404);
  answers(UNHEALTHY, () => Response.json({}, { status: 500 }));
  assert.deepEqual(await lookup(coinbase.txid), { status: 502, body: { ok: false, error: "upstream" } });
  // A copy that is not this transaction counts as no answer.
  answers(() => Response.json({ ...coinbase, txid: "ab".repeat(32) }), NOT_FOUND);
  assert.equal((await lookup(coinbase.txid)).status, 404);
  // The gateway's own 404 for a path it doesn't serve is no answer, not "missing".
  answers(() => Response.json({ error: "not found" }, { status: 404 }), UNHEALTHY);
  assert.deepEqual(await lookup(coinbase.txid), { status: 502, body: { ok: false, error: "upstream" } });
  // OWN_BLOCKBOOK_BASE "" leaves the official indexer alone.
  const asked = answers(() => Response.json(mined), () => Response.json(stale));
  const r = await tx(makeEnv({ OWN_BLOCKBOOK_BASE: "" }), { txid: coinbase.txid }, {}, "198.51.100.8");
  assert.equal((await r.json()).confirmations, 0);
  assert.deepEqual(asked, [OFFICIAL_TX(coinbase.txid)]);
});
