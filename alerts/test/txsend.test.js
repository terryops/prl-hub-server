import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendTx, SEND_PER_IP, SEND_MAX_BYTES } from "../src/chain.js";
import { makeEnv, call, setNow, restoreNow, T0 } from "./helpers.js";

const original = fetch;
afterEach(() => { globalThis.fetch = original; restoreNow(); });

// Mainnet transaction 5a379e1d…d5e1 (block 130566), as Blockbook returned it on 2026-10-20.
const txid = "5a379e1d6e78ec7d6e08e4fb77b730ed3b4698891f8b7e04e427a7724647d5e1";
const hex = "020000000001018381ff534381656129d7b91238db88bbed6d78803f0b751f2e02ade2468ce5cf6502000000ffffffff018ea1d2060000000022512016893170a218167462fa5cbb3d8e6e246bb629e43424b326c7228f12d5fa582301400eaca7325369d943ba39c3d4276b1f5767126d30072a5a81ba27a7e979fe0508a93e5daf86a05a1acdede3f304857e21da3ea01d2996353e902f16e3cf16610500000000";
const OWN = "https://node.pearlhub.net/api/v2/sendtx/", OFFICIAL = "https://blockbook.pearlresearch.ai/api/v2/sendtx/";
// Replies seen live on 2026-10-20 (from both indexers) for a mined transaction, one whose inputs are
// long spent, and a garbled one.
const ACCEPTED = () => Response.json({ result: txid });
const KNOWN = () => Response.json({ error: `-26: TX rejected: already have transaction in mempool ${txid}` }, { status: 400 });
const ORPHAN = `-25: TX rejected: orphan transaction ${txid} references outputs of unknown or fully-spent transaction ${"5584f2e8".repeat(8)}`;
const REFUSED = () => Response.json({ error: ORPHAN }, { status: 400 });
const DOWN = () => { throw new TypeError("network"); };
// node.pearlhub.net's gateway answers for itself with these.
const GATEWAY = (status, error) => () => Response.json({ error }, { status });
/// Each indexer answers with its own handler; every request is recorded.
function indexers(own, official) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return String(url) === OWN ? own() : String(url) === OFFICIAL ? official() : DOWN();
  };
  return requests;
}
// A fresh database each time, so these broadcasts never meet the per-IP limit.
const send = async (body, extra = {}) => { const r = await sendTx(makeEnv(extra), body, "198.51.100.7"); return { status: r.status, body: await r.json() }; };

test("send: the hex goes to our own indexer and the official one at once, as text", async () => {
  const requests = indexers(ACCEPTED, ACCEPTED);
  // Pasted hex may be upper case and wrapped over lines.
  const { status, body } = await send({ hex: ` ${hex.slice(0, 100).toUpperCase()}\n${hex.slice(100)}\n` });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, txid, via: "own" });
  assert.deepEqual(requests.map((r) => r.url).sort(), [OFFICIAL, OWN].sort());
  for (const { init } of requests) {
    assert.equal(init.method, "POST");
    assert.equal(init.body, hex);
    assert.equal(init.headers["content-type"], "text/plain");
  }
});

test("send: accepted wins, then already known; a refusal only when every node that saw it refused", async () => {
  const cases = [
    // [own, official] → expected
    [[ACCEPTED, KNOWN], 200, { ok: true, txid, via: "own" }],
    [[KNOWN, ACCEPTED], 200, { ok: true, txid, via: "official" }],
    [[REFUSED, ACCEPTED], 200, { ok: true, txid, via: "official" }, "our node may lack a parent the official one has"],
    [[DOWN, ACCEPTED], 200, { ok: true, txid, via: "official" }],
    [[GATEWAY(502, "node unreachable"), ACCEPTED], 200, { ok: true, txid, via: "official" }],
    [[ACCEPTED, DOWN], 200, { ok: true, txid, via: "own" }],
    [[KNOWN, KNOWN], 200, { ok: true, known: true, via: "own" }],
    [[REFUSED, KNOWN], 200, { ok: true, known: true, via: "official" }],
    [[GATEWAY(429, "rate limited"), KNOWN], 200, { ok: true, known: true, via: "official" }],
    [[REFUSED, REFUSED], 422, { ok: false, error: "rejected", reason: ORPHAN, via: "own" }],
    // One refused, the other gave no answer: it may have relayed it (a lost answer is not a refusal),
    // and calling it refused could have the sender sign and pay again.
    [[DOWN, REFUSED], 502, { ok: false, error: "upstream" }, "the official node refused, ours may have it"],
    [[REFUSED, DOWN], 502, { ok: false, error: "upstream" }, "our node refused, the official one may have it"],
    [[GATEWAY(502, "node unreachable"), REFUSED], 502, { ok: false, error: "upstream" }],
    // Turned away before any node saw it: the other node's refusal is the verdict.
    [[GATEWAY(429, "rate limited"), REFUSED], 422, { ok: false, error: "rejected", reason: ORPHAN, via: "official" }],
    [[GATEWAY(413, "too large"), REFUSED], 422, { ok: false, error: "rejected", reason: ORPHAN, via: "official" }],
    [[GATEWAY(401, "unauthorized"), GATEWAY(429, "x")], 502, { ok: false, error: "upstream" }, "no node saw it"],
    [[DOWN, DOWN], 502, { ok: false, error: "upstream" }, "no answer: unknown outcome"],
    [[GATEWAY(503, "node unhealthy"), GATEWAY(500, "x")], 502, { ok: false, error: "upstream" }],
  ];
  for (const [[own, official], status, body, why] of cases) {
    indexers(own, official);
    assert.deepEqual(await send({ hex }), { status, body }, why || JSON.stringify(body));
  }
  indexers(() => Response.json({ error: "-27: transaction already in block chain" }, { status: 400 }), DOWN);
  assert.deepEqual((await send({ hex })).body, { ok: true, known: true, via: "own" });
});

test("send: only an answer about the transaction counts; the indexers' own trouble does not", async () => {
  const decode = () => Response.json({ error: "-22: TX decode failed: unexpected EOF" }, { status: 400 });
  indexers(decode, decode);
  assert.deepEqual((await send({ hex })).body.reason, "-22: TX decode failed: unexpected EOF");
  // Control characters go, and a long reason is cut at 300 characters.
  const long26 = () => Response.json({ error: `-26: TX rejected:\n${"x".repeat(400)}` }, { status: 400 });
  indexers(long26, long26);
  const long = (await send({ hex })).body.reason;
  assert.equal(long.length, 300); assert.ok(long.startsWith("-26: TX rejected: xxx"));
  for (const trouble of [
    GATEWAY(400, "Missing tx blob"), GATEWAY(400, "-28: Loading block index"), GATEWAY(400, "-32603: internal"),
    () => Response.json({}, { status: 500 }), () => Response.json({ result: "nope" }), () => Response.json({ error: "-26: x" }, { status: 503 }),
    () => new Response("<html>", { status: 400 }), () => new Response("<html>", { status: 200 }),
  ]) {
    indexers(trouble, trouble);
    assert.deepEqual(await send({ hex }), { status: 502, body: { ok: false, error: "upstream" } });
  }
});

test("send: OWN_BLOCKBOOK_BASE moves our indexer, and an empty one leaves only the official one", async () => {
  let requests = indexers(DOWN, ACCEPTED);
  assert.deepEqual((await send({ hex }, { OWN_BLOCKBOOK_BASE: "" })).body, { ok: true, txid, via: "official" });
  assert.deepEqual(requests.map((r) => r.url), [OFFICIAL]);
  requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); return ACCEPTED(); };
  await send({ hex }, { OWN_BLOCKBOOK_BASE: "https://node2.example.test/", BLOCKBOOK_BASE: "https://bb.example.test/api/v2" });
  assert.deepEqual(requests.sort(), ["https://bb.example.test/api/v2/sendtx/", "https://node2.example.test/api/v2/sendtx/"]);
  // Our own may carry the /api/v2 too, without doubling it.
  requests = [];
  await send({ hex }, { OWN_BLOCKBOOK_BASE: "https://node2.example.test/api/v2/" });
  assert.deepEqual(requests.sort(), [OFFICIAL, "https://node2.example.test/api/v2/sendtx/"]);
  // The same address twice is asked once.
  requests = [];
  await send({ hex }, { OWN_BLOCKBOOK_BASE: "https://blockbook.pearlresearch.ai" });
  assert.deepEqual(requests, [OFFICIAL]);
});

test("send: anything but plausible hex is refused before any request", async () => {
  const requests = indexers(ACCEPTED, ACCEPTED);
  for (const bad of [undefined, 7, "", "zz", hex + "0", hex.replace("02", "0g"), "00".repeat(59), "00".repeat(SEND_MAX_BYTES + 1), "0".repeat(4 * SEND_MAX_BYTES + 2)])
    assert.deepEqual(await send({ hex: bad }), { status: 400, body: { ok: false, error: "bad transaction" } });
  assert.equal(requests.length, 0);
  assert.equal((await send({ hex: "00".repeat(60) })).status, 200);
  assert.equal((await send({ hex: "00".repeat(SEND_MAX_BYTES) })).status, 200);
});

test("send limits: five broadcasts per IP a minute, refused ones included; 60 a minute in all", async () => {
  setNow(T0 + 5);
  const env = makeEnv(), requests = indexers(REFUSED, REFUSED);
  const ask = async (ip, body = { hex }) => { const r = await sendTx(env, body, ip); return { status: r.status, body: await r.json() }; };
  for (let i = 0; i < SEND_PER_IP; i++) assert.equal((await ask("203.0.113.1")).status, 422);
  assert.deepEqual(await ask("203.0.113.1"), { status: 429, body: { ok: false, error: "busy", retry_after: 55 } });
  assert.equal((await ask("203.0.113.1", { hex: "zz" })).status, 400, "malformed hex is refused before the limit");
  assert.equal((await ask("203.0.113.2")).status, 422, "another IP has its own five");
  // One broadcast is one unit of the budget, though it asks two indexers.
  for (let i = 1; i < 60 - SEND_PER_IP; i++) assert.equal((await ask(`10.0.0.${i}`)).status, 422);
  assert.equal(requests.length, 120);
  assert.equal((await ask("10.0.1.1")).status, 429);
  assert.equal(requests.length, 120);
  setNow(T0 + 65);
  assert.equal((await ask("203.0.113.1")).status, 422);
  assert.equal(requests.length, 122);
});

test("send route: POST only, read rate limit, and a body cap that still takes the largest transaction", async () => {
  const env = makeEnv();
  indexers(ACCEPTED, ACCEPTED);
  assert.deepEqual((await call(env, "POST", "/v1/tx/send", { hex })).body, { ok: true, txid, via: "own" });
  assert.equal((await call(env, "POST", "/v1/tx/send", { hex })).headers.get("cache-control"), "no-store");
  assert.equal((await call(env, "POST", "/v1/tx/send", { hex: "00".repeat(SEND_MAX_BYTES) })).status, 200);
  assert.equal((await call(env, "POST", "/v1/tx/send", { hex: "00".repeat(SEND_MAX_BYTES + 3000) })).status, 413);
  assert.equal((await call(env, "POST", "/v1/tx/send", "{")).status, 400);
  assert.equal((await call(env, "GET", "/v1/tx/send")).status, 404);
  env.RL_READ = { limit: async () => ({ success: false }) };
  assert.equal((await call(env, "POST", "/v1/tx/send", { hex })).status, 429);
});

// ── rebroadcast by txid ──
const OWN_TX = `https://node.pearlhub.net/api/v2/tx/${txid}`, OFFICIAL_TX = `https://blockbook.pearlresearch.ai/api/v2/tx/${txid}`;
const copy = (confirmations = 0) => () => Response.json({ txid, hex, confirmations, blockHeight: confirmations ? 130566 : -1, vin: [{ txid: "cd".repeat(32) }], vout: [{ value: "114467214" }] });
const MISSING = () => Response.json({ error: `Transaction '${txid}' not found` }, { status: 400 });
const UNHEALTHY = () => Response.json({ error: "node unhealthy" }, { status: 503 });
/// Each URL answers with its handler (anything else is unreachable); every request is recorded.
function chain(routes) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => { requests.push({ url: String(url), init }); return (routes[String(url)] || DOWN)(); };
  return requests;
}

test("rebroadcast: the hex an indexer still has goes to both nodes", async () => {
  // Our own refuses reads while it catches up; the official one has the transaction in its mempool.
  const requests = chain({ [OWN_TX]: UNHEALTHY, [OFFICIAL_TX]: copy(), [OWN]: ACCEPTED, [OFFICIAL]: KNOWN });
  assert.deepEqual(await send({ txid: ` ${txid.toUpperCase()} ` }), { status: 200, body: { ok: true, txid, via: "own" } });
  const sent = requests.filter((r) => r.url.endsWith("/sendtx/"));
  assert.deepEqual(sent.map((r) => r.url).sort(), [OFFICIAL, OWN].sort());
  assert.ok(sent.every((r) => r.init.body === hex));
  // Only our own has it (e.g. broadcast there first): that copy is used.
  chain({ [OWN_TX]: copy(), [OFFICIAL_TX]: MISSING, [OWN]: KNOWN, [OFFICIAL]: ACCEPTED });
  assert.deepEqual((await send({ txid })).body, { ok: true, txid, via: "official" });
  chain({ [OWN_TX]: copy(), [OFFICIAL_TX]: copy(), [OWN]: KNOWN, [OFFICIAL]: KNOWN });
  assert.deepEqual((await send({ txid })).body, { ok: true, known: true, via: "own" });
  // Our node gave no answer, so the official one's refusal is not the verdict.
  chain({ [OWN_TX]: DOWN, [OFFICIAL_TX]: copy(), [OWN]: DOWN, [OFFICIAL]: REFUSED });
  assert.deepEqual(await send({ txid }), { status: 502, body: { ok: false, error: "upstream" } });
  chain({ [OWN_TX]: DOWN, [OFFICIAL_TX]: copy(), [OWN]: REFUSED, [OFFICIAL]: REFUSED });
  assert.deepEqual(await send({ txid }), { status: 422, body: { ok: false, error: "rejected", reason: ORPHAN, via: "own" } });
});

test("rebroadcast: nothing is sent for a transaction in a block, or one no indexer has", async () => {
  let requests = chain({ [OWN_TX]: copy(3), [OFFICIAL_TX]: copy(), [OWN]: ACCEPTED, [OFFICIAL]: ACCEPTED });
  assert.deepEqual(await send({ txid }), { status: 200, body: { ok: true, confirmed: true } }, "either indexer seeing it in a block is enough");
  assert.equal(requests.filter((r) => r.url.endsWith("/sendtx/")).length, 0);
  requests = chain({ [OWN_TX]: MISSING, [OFFICIAL_TX]: MISSING, [OWN]: ACCEPTED, [OFFICIAL]: ACCEPTED });
  assert.deepEqual(await send({ txid }), { status: 404, body: { ok: false, error: "not found" } });
  chain({ [OWN_TX]: UNHEALTHY, [OFFICIAL_TX]: MISSING });
  assert.equal((await send({ txid })).status, 404);
  // No usable answer from either: the outcome is unknown, not "not found".
  for (const bad of [UNHEALTHY, DOWN, () => Response.json({ txid, confirmations: 0, vin: [], vout: [] }), () => Response.json({ txid: "ab".repeat(32), hex, confirmations: 0, vin: [], vout: [] }),
    () => Response.json({ txid, hex: "zz", confirmations: 0, vin: [], vout: [] }), () => Response.json({ error: "Internal" }, { status: 400 })]) {
    requests = chain({ [OWN_TX]: bad, [OFFICIAL_TX]: bad, [OWN]: ACCEPTED, [OFFICIAL]: ACCEPTED });
    assert.deepEqual(await send({ txid }), { status: 502, body: { ok: false, error: "upstream" } });
    assert.equal(requests.filter((r) => r.url.endsWith("/sendtx/")).length, 0);
  }
  assert.equal(requests.length, 2);
});

test("rebroadcast: a bad txid is refused before any request; hex wins when both are given; same limits", async () => {
  setNow(T0 + 5);
  const requests = chain({ [OWN_TX]: copy(), [OFFICIAL_TX]: copy(), [OWN]: ACCEPTED, [OFFICIAL]: ACCEPTED });
  for (const bad of ["", "zz", txid.slice(1), txid + "0", `https://blockbook.pearlresearch.ai/tx/${txid}`])
    assert.deepEqual(await send({ txid: bad }), { status: 400, body: { ok: false, error: "bad txid" } });
  assert.equal(requests.length, 0);
  assert.deepEqual((await send({ txid: "0".repeat(64), hex })).body, { ok: true, txid, via: "own" });
  assert.equal(requests.filter((r) => r.url.includes("/api/v2/tx/")).length, 0, "with hex given, nothing is looked up");
  const env = makeEnv();
  for (let i = 0; i < SEND_PER_IP; i++) assert.equal((await sendTx(env, { txid }, "203.0.113.9")).status, 200);
  assert.equal((await sendTx(env, { hex }, "203.0.113.9")).status, 429, "rebroadcasts and broadcasts share the five");
});

test("our own indexer gets OWN_BLOCKBOOK_KEY in X-Pearl-Hub-Key; the official one never does", async () => {
  const key = "k".repeat(48), seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push([String(url).split("/api/")[0], new Headers(init.headers).get("x-pearl-hub-key")]);
    return String(url).endsWith("/sendtx/") ? ACCEPTED() : copy()();
  };
  await send({ hex }, { OWN_BLOCKBOOK_KEY: key });
  await send({ txid }, { OWN_BLOCKBOOK_KEY: key });
  assert.deepEqual([...new Set(seen.map(([base, k]) => `${base} ${k}`))].sort(),
    [`https://blockbook.pearlresearch.ai null`, `https://node.pearlhub.net ${key}`]);
  seen.length = 0;
  await send({ hex });
  assert.ok(seen.every(([, k]) => k === null), "no key configured: no header");
  // Without a key the gateway answers 401, which counts as no answer: the official one decides.
  indexers(() => Response.json({ error: "unauthorized" }, { status: 401 }), REFUSED);
  assert.deepEqual((await send({ hex })).body, { ok: false, error: "rejected", reason: ORPHAN, via: "official" });
});
