// 到账提醒: what counts as a payment, the copy, and the whole path
// PUT income → cron reads the new blocks → APNs.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as H from "./helpers.js";
import { installFetch, setNow, restoreNow, T0, tok, call, tick, makeChain, signJWS, proTx } from "./helpers.js";
import { sanitizeIncome, receipts, parseCursor, CURSOR, MAX_BEHIND, BLOCK_FAILS, TOLD_KEEP, PENDING_MAX, GRACE } from "../src/income-watch.js";
import { incomePayloadFor, fmtPRL, LANGS } from "../src/i18n.js";
import { dataFor } from "../src/fcm.js";

// blockbook() wraps whatever fetch is installed: put the real one back after each test.
const realFetch = globalThis.fetch;
afterEach(() => { restoreNow(); globalThis.fetch = realFetch; });

const chain = await makeChain();
const PRO = await signJWS(chain, proTx());
// Only the official indexer, unless a test asks for ours too.
const makeEnv = (extra = {}) => H.makeEnv({ APPLE_ROOT_SHA256: chain.rootSHA256, OWN_BLOCKBOOK_BASE: "", ...extra });
const put = (env, token, income, extra = {}) =>
  call(env, "PUT", `/v1/devices/${token}`, { env: "production", topic: "com.prl.wizard", oneshot: true, rules: [], income, pro_jws: PRO, ...extra });

const A = "prl1p9me4eaujkj6wl8n0a379jef0cqtu89kdm7d9vh2qt5s9zkpdt6wqr37u3n";
const B = "prl1pg8k2sr49wtavg3f7x7y5mxztttzyc4daalx4t6hpdakr32v0z7lq6ckcth";
const OTHER = "prl1pt2cnvpqjdhvw5kwyqc9mz3ah2vakaqv63xsysfe7f4aw0qt9rgdqtzn5yf";
const txid = (i) => i.toString(16).padStart(64, "0");
const hash = (h, fork = 0) => (fork ? "f" : "b") + h.toString(16).padStart(63, "0");
const io = (addr, sats) => ({ addresses: [addr], isAddress: true, value: String(sats) });
/// A transaction from `from` (null: a coinbase) paying [addr, sats] pairs.
const tx = (i, from, ...outs) => ({
  txid: txid(i),
  vin: from ? [io(from, 1e12)] : [{ coinbase: "03abcd", n: 0, isAddress: false }],
  vout: outs.map(([a, v], n) => ({ ...io(a, v), n })),
});

/// A Blockbook stand-in: `chain[h]` = { txs, fork? } for each height; the tip is the highest.
function blockbook(net, host = "blockbook.pearlresearch.ai") {
  // down: nothing answers; blocksDown: the tip answers, blocks don't; noPrev: blocks lack their parent's hash.
  const bb = { chain: {}, reads: [], down: false, blocksDown: false, noPrev: false, t: T0 };
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname !== host) return inner(url, init);
    if (bb.down) return new Response("down", { status: 503 });
    const heights = Object.keys(bb.chain).map(Number);
    const best = heights.length ? Math.max(...heights) : 0;
    if (u.pathname === "/api/") return Response.json({ blockbook: { bestHeight: best, inSync: true }, backend: { blocks: best } });
    const m = /^\/api\/v2\/block\/(\d+)$/.exec(u.pathname);
    if (m) {
      const h = Number(m[1]), b = bb.chain[h];
      // The network sampler (sampleNetwork) reads the tip block too; only the income reader's reads count here.
      if (!new Error().stack.includes("sampleNetwork")) bb.reads.push(h);
      if (!b) return Response.json({ error: "Block not found" }, { status: 400 });
      if (b.fail || bb.blocksDown) return new Response("too big", { status: 500 });
      return Response.json({ page: 1, totalPages: 1, itemsOnPage: 1000, height: h, hash: hash(h, b.fork),
                             ...(bb.noPrev ? {} : { previousBlockHash: hash(h - 1, bb.chain[h - 1]?.fork) }),
                             time: b.time ?? bb.t, txCount: b.txs.length, txs: b.txs });
    }
    return new Response("nope", { status: 404 });
  };
  return bb;
}

const row = (env, token) => env.DB.one("SELECT addr, label, since, told, pending FROM income_watches WHERE token = ?", token);
const cursor = (env) => parseCursor(env.DB.one("SELECT v FROM kv WHERE k = ?", CURSOR)?.v);
const at = (env, t) => { setNow(t); return tick(env); };

// ── pure parts ───────────────────────────────────────────────────────────────

test("sanitizeIncome: one PRL address, lower-cased, with an optional short name", () => {
  assert.deepEqual(sanitizeIncome({ addr: ` ${A.toUpperCase()} `, label: "  Pool\npayouts " }), { addr: A, label: "Pool payouts" });
  assert.deepEqual(sanitizeIncome({ addr: A }), { addr: A, label: "" });
  assert.equal(sanitizeIncome({ addr: A, label: "x".repeat(60) }).label.length, 40);
  // Cut between whole characters: never half an emoji (a lone surrogate prints as garbage).
  const emoji = sanitizeIncome({ addr: A, label: "a" + "😀".repeat(25) }).label;
  assert.ok(emoji.length <= 40 && emoji.isWellFormed() && emoji.endsWith("😀"));
  for (const bad of [null, "x", [], [{ addr: A }], {}, { addr: "bc1qxyz" }, { addr: "prl1short" }, { addr: `${A}/../x` }, { addr: 5 }]) {
    assert.equal(sanitizeIncome(bad), null, JSON.stringify(bad));
  }
});

test("receipts: what a block pays the watched addresses — never the owner's own sends", () => {
  const watched = new Set([A, B]);
  const got = receipts([
    tx(1, null, [A, 625e6]),                          // coinbase (solo mining): income
    tx(2, OTHER, [A, 1e8], [OTHER, 5e8], [A, 2e8]),   // a payment in two outputs: one entry, added up
    tx(3, A, [OTHER, 1e8], [A, 9e8]),                 // a send from A, its change back to A: not income
    tx(4, OTHER, [B, 7], [OTHER, 1]),
    tx(5, OTHER, [OTHER, 1e8]),                       // nobody watched
    { txid: "nothex", vin: [], vout: [io(A, 1)] },    // garbage is skipped, not fatal
    { txid: txid(6), vin: [io(OTHER, 1)], vout: [{ addresses: [A], value: "-5" }] },
  ], watched);
  assert.deepEqual(got, [
    { addr: A, txid: txid(1), sats: 625000000n },
    { addr: A, txid: txid(2), sats: 300000000n },
    { addr: B, txid: txid(4), sats: 7n },
  ]);
  // No list: every address paid (looked up among the watched ones afterwards).
  assert.deepEqual(receipts([tx(2, OTHER, [A, 1], [OTHER, 2]), tx(3, A, [A, 1], [OTHER, 1])]).map((r) => r.addr), [A, OTHER]);
});

test("copy: on Android and in the browser a payment is its own notification, and opens the wallet", () => {
  const one = (id) => incomePayloadFor("en", { addr: A }, [{ txid: txid(id), sats: 1n }]);
  const d1 = dataFor(one(1)), d2 = dataFor(one(2));
  assert.equal(d1.kind, "income");
  assert.equal(d1.route, "wallet");
  assert.equal(d1.tag, `income:${txid(1).slice(-16)}`);
  assert.notEqual(d1.tag, d2.tag, "a second payment must not replace the first");
  assert.equal(dataFor({ aps: { alert: { title: "t" } }, alert: { test: true } }).kind, "test");
});

test("copy: every language the app ships has a payment push; amounts are cut, never rounded up", () => {
  assert.equal(fmtPRL(6040000000n), "60.4");
  assert.equal(fmtPRL(48182119n), "0.48182119");
  assert.equal(fmtPRL(123456789999n), "1234.5678");
  assert.equal(fmtPRL(100000000n), "1");
  assert.equal(fmtPRL(1n), "0.00000001");
  const one = [{ txid: txid(1), sats: 6040000000n }];
  const two = [...one, { txid: txid(2), sats: 48182119n }];
  for (const lang of LANGS) {
    const p1 = incomePayloadFor(lang, { addr: A, label: "" }, one), p2 = incomePayloadFor(lang, { addr: A, label: "Rig" }, two);
    assert.match(p1.aps.alert.title, /60\.4 PRL/, lang);
    assert.match(p2.aps.alert.title, /60\.8818 PRL/, lang);
    assert.match(p2.aps.alert.title, /2/, lang);
    if (lang !== "en") assert.notEqual(p1.aps.alert.title, incomePayloadFor("en", { addr: A }, one).aps.alert.title, `${lang} is translated`);
    assert.equal(p1.aps.alert.body, "prl1p9me…r37u3n");
    assert.equal(p1.aps.alert.subtitle, undefined);
    assert.equal(p2.aps.alert.subtitle, "Rig");
    assert.equal(p1.aps["thread-id"], "income");
    assert.deepEqual(p2.income, { txid: txid(2), n: 2, tag: `income:${txid(2).slice(-16)}` });
    if (!lang.startsWith("zh")) assert.doesNotMatch(JSON.stringify(p2.aps), /min(e|ing|er)/i, lang);
  }
  assert.equal(incomePayloadFor("zh-Hans", { addr: A }, two).aps.alert.title, "收到 2 笔，共 60.8818 PRL");
  assert.equal(incomePayloadFor("xx", { addr: A }, one).aps.alert.title, "Received 60.4 PRL", "unknown language: English");
});

// ── registration ─────────────────────────────────────────────────────────────

test("register: one address per device, Pro only; replacing it starts over, null removes it", async () => {
  setNow(T0);
  installFetch();
  const env = makeEnv();
  // No signed purchase, no account: refused.
  assert.deepEqual(await put(env, tok(1), { addr: A }, { pro_jws: undefined }), { status: 403, body: { error: "not pro" } });
  assert.equal(row(env, tok(1)), null);
  // A list is not one address.
  assert.equal((await put(env, tok(1), [{ addr: A }])).status, 400);
  assert.equal((await put(env, tok(1), { addr: "nope" })).status, 400);

  const r = await put(env, tok(1), { addr: A, label: "Payouts" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.income, { since: T0 });
  assert.equal(JSON.stringify(r.body).includes(A), false, "the address is not echoed back");
  assert.deepEqual(row(env, tok(1)), { addr: A, label: "Payouts", since: T0, told: "[]", pending: "[]" });

  // Same address later (a rename, another sync): what it heard stays, and so does `since`.
  env.DB.raw.prepare("UPDATE income_watches SET told = ? WHERE token = ?").run(JSON.stringify([txid(9)]), tok(1));
  setNow(T0 + 500);
  await put(env, tok(1), { addr: A, label: "Rig" });
  assert.deepEqual(row(env, tok(1)), { addr: A, label: "Rig", since: T0, told: JSON.stringify([txid(9)]), pending: "[]" });
  // Another address: starts over.
  await put(env, tok(1), { addr: B });
  assert.deepEqual(row(env, tok(1)), { addr: B, label: "", since: T0 + 500, told: "[]", pending: "[]" });

  // An app that doesn't know `income` leaves it alone…
  await call(env, "PUT", `/v1/devices/${tok(1)}`, { env: "production", topic: "com.prl.wizard", oneshot: true, rules: [], pro_jws: PRO });
  assert.equal(row(env, tok(1)).addr, B);
  assert.ok(env.DB.one("SELECT 1 AS x FROM devices WHERE token = ?", tok(1)), "a device with only an income alert is not empty");
  assert.deepEqual((await call(env, "GET", `/v1/devices/${tok(1)}`)).body.income, { since: T0 + 500 });
  // …null removes it, and with nothing else left the device goes too.
  const off = await put(env, tok(1), null);
  assert.deepEqual(off.body, { ok: true, rules: [] });
  assert.equal(row(env, tok(1)), null);
  assert.equal(env.DB.one("SELECT 1 AS x FROM devices WHERE token = ?", tok(1)), null);

  // Forgetting a device takes its address with it.
  await put(env, tok(2), { addr: A });
  await call(env, "DELETE", `/v1/devices/${tok(2)}`);
  assert.equal(row(env, tok(2)), null);
});

// ── the cron ─────────────────────────────────────────────────────────────────

test("cron: each new block is read once, and a payment to the address is pushed once", async () => {
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[100] = { txs: [tx(1, null, [OTHER, 625e6])] };
  // Nobody watching: not one request to the indexer.
  await tick(env);
  assert.equal(bb.reads.length, 0);
  assert.equal(cursor(env), null);

  await put(env, tok(1), { addr: A, label: "Payouts" });
  await put(env, tok(2), { addr: A }, { lang: "zh-Hans" });
  await put(env, tok(3), { addr: B });
  await at(env, T0 + 60);
  assert.deepEqual(bb.reads, [100], "the first look reads the tip block only");
  assert.deepEqual(cursor(env), { h: 100, hashes: [hash(100)], fails: 0 });
  assert.equal(net.alerts().length, 0);

  await at(env, T0 + 120);
  assert.deepEqual(bb.reads, [100], "no new block, nothing read");

  bb.t = T0 + 150;
  bb.chain[101] = { txs: [tx(2, OTHER, [A, 6040000000], [OTHER, 1]), tx(3, A, [A, 5e8], [OTHER, 1e8])] };
  bb.chain[102] = { txs: [tx(4, OTHER, [A, 48182119]), tx(5, null, [B, 625e6])] };
  await at(env, T0 + 180);
  assert.deepEqual(bb.reads, [100, 101, 102]);
  const pushes = net.alerts().map((c) => [c.token, c.body.aps.alert, c.body.income]);
  assert.deepEqual(pushes.sort(), [
    [tok(1), { title: "Received 60.8818 PRL in 2 payments", subtitle: "Payouts", body: "prl1p9me…r37u3n" }, { txid: txid(4), n: 2, tag: `income:${txid(4).slice(-16)}` }],
    [tok(2), { title: "收到 2 笔，共 60.8818 PRL", body: "prl1p9me…r37u3n" }, { txid: txid(4), n: 2, tag: `income:${txid(4).slice(-16)}` }],
    [tok(3), { title: "Received 6.25 PRL", body: "prl1pg8k…6ckcth" }, { txid: txid(5), n: 1, tag: `income:${txid(5).slice(-16)}` }],
  ].sort());
  assert.equal(row(env, tok(1)).told, JSON.stringify([txid(4), txid(2)]));
  assert.equal(row(env, tok(1)).pending, "[]");

  await at(env, T0 + 240);
  await at(env, T0 + 300);
  assert.equal(net.alerts().length, 3, "each payment once");
});

test("cron: payments from before the address was set are not news", async () => {
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[200] = { txs: [] };
  await put(env, tok(1), { addr: OTHER });
  await at(env, T0 + 60);                         // the cursor is at 200
  // A block read while nobody watched A: setting A afterwards doesn't bring it back.
  bb.chain[201] = { txs: [tx(1, OTHER, [A, 1e8])] };
  await at(env, T0 + 120);
  setNow(T0 + 130);
  await put(env, tok(1), { addr: A });
  await at(env, T0 + 180);
  assert.equal(net.alerts().length, 0);

  // The indexer is down; meanwhile the address changes to B. Of the blocks read on catching up,
  // one stamped more than GRACE before B was set is not news, one stamped just before it is.
  bb.down = true;
  await at(env, T0 + 240);
  setNow(T0 + 9000);
  await put(env, tok(1), { addr: B });
  bb.chain[202] = { txs: [tx(2, OTHER, [B, 1e8])], time: T0 + 9000 - GRACE - 1 };
  bb.chain[203] = { txs: [tx(3, OTHER, [B, 2e8])], time: T0 + 8000 };
  bb.down = false;
  await at(env, T0 + 9060);
  assert.deepEqual(net.alerts().map((c) => c.body.aps.alert.title), ["Received 2 PRL"]);
});

test("cron: a payment made before the address was set is not news, though the reader is still catching up", async () => {
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[300] = { txs: [] };
  await put(env, tok(1), { addr: OTHER });
  await at(env, T0 + 60);                         // the cursor is at 300
  // Nobody watches for a while (the scan stops, the cursor stays), and A is paid 35 minutes
  // before it is set — a dozen blocks back, inside the catch-up window.
  await put(env, tok(1), null);
  bb.chain[301] = { txs: [tx(1, OTHER, [A, 1e8])], time: T0 + 600 };
  for (let h = 302; h <= 312; h++) bb.chain[h] = { txs: [], time: T0 + 600 + (h - 301) * 200 };
  await at(env, T0 + 1200);
  setNow(T0 + 600 + 35 * 60);
  await put(env, tok(1), { addr: A });
  bb.chain[313] = { txs: [tx(2, OTHER, [A, 3e8])], time: T0 + 600 + 36 * 60 };
  for (let i = 1; i <= 3; i++) await at(env, T0 + 600 + 35 * 60 + i * 60);
  assert.ok(312 - 300 <= MAX_BEHIND);
  assert.deepEqual(net.alerts().map((c) => c.body.aps.alert.title), ["Received 3 PRL"]);
});

test("cron: quiet hours hold the payment until the window opens; a push APNs didn't take is tried again", async () => {
  // T0 is 08:00 in Shanghai.
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[10] = { txs: [] };
  await put(env, tok(1), { addr: A }, { window: { start: 9 * 60, end: 22 * 60, tz: "Asia/Shanghai" } });
  await at(env, T0 + 60);
  bb.chain[11] = { txs: [tx(1, OTHER, [A, 1e8])] };
  await at(env, T0 + 120);
  assert.equal(net.alerts().length, 0, "08:02: quiet");
  assert.equal(JSON.parse(row(env, tok(1)).pending).length, 1);
  bb.chain[12] = { txs: [tx(2, OTHER, [A, 2e8])] };
  await at(env, T0 + 1800);
  assert.equal(net.alerts().length, 0);

  // 09:00: open — but APNs is in trouble.
  net.apns = () => ({ status: 503, reason: "ServiceUnavailable" });
  await at(env, T0 + 3600);
  assert.equal(net.alerts().length, 1);
  assert.equal(JSON.parse(row(env, tok(1)).pending).length, 2, "put back for the next tick");
  assert.equal(row(env, tok(1)).told, "[]");

  net.apns = () => ({ status: 200 });
  await at(env, T0 + 3660);
  assert.equal(net.alerts().length, 2);
  assert.equal(net.alerts()[1].body.aps.alert.title, "Received 3 PRL in 2 payments");
  assert.equal(row(env, tok(1)).pending, "[]");
  await at(env, T0 + 3720);
  assert.equal(net.alerts().length, 2);
});

test("cron: a dead token is forgotten, address and all", async () => {
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[10] = { txs: [] };
  await put(env, tok(1), { addr: A });
  await at(env, T0 + 60);
  net.apns = () => ({ status: 410, reason: "Unregistered" });
  bb.chain[11] = { txs: [tx(1, OTHER, [A, 1e8])] };
  await at(env, T0 + 120);
  assert.equal(net.alerts().length, 1);
  assert.equal(row(env, tok(1)), null);
  assert.equal(env.DB.one("SELECT 1 AS x FROM devices WHERE token = ?", tok(1)), null);
});

test("cron: a replaced block is read again; a payment in both is pushed once, one only in the new one is not missed", async () => {
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[50] = { txs: [] };
  await put(env, tok(1), { addr: A });
  await at(env, T0 + 60);
  bb.chain[51] = { txs: [tx(1, OTHER, [A, 1e8])] };
  await at(env, T0 + 120);
  assert.equal(net.alerts().length, 1);

  // 51 is replaced by 51' (with tx 1 and a new tx 2), and 52 follows it.
  bb.chain[51] = { fork: 1, txs: [tx(1, OTHER, [A, 1e8]), tx(2, OTHER, [A, 2e8])] };
  bb.chain[52] = { txs: [tx(3, OTHER, [A, 3e8])] };
  await at(env, T0 + 180);
  assert.deepEqual(bb.reads, [50, 51, 52, 51, 52]);
  assert.equal(net.alerts().length, 2);
  assert.equal(net.alerts()[1].body.aps.alert.title, "Received 5 PRL in 2 payments", "tx 2 and tx 3; tx 1 was told already");
  assert.deepEqual(cursor(env), { h: 52, hashes: [hash(52), hash(51, 1), hash(50)], fails: 0 });
});

test("cron: a block that keeps failing is skipped after a few ticks; a cursor far behind jumps to the tip", async () => {
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[10] = { txs: [] };
  await put(env, tok(1), { addr: A });
  await at(env, T0 + 60);
  bb.chain[11] = { fail: true, txs: [] };
  bb.chain[12] = { txs: [tx(1, OTHER, [A, 1e8])] };
  for (let i = 1; i < BLOCK_FAILS; i++) {
    await at(env, T0 + 60 + 60 * i);
    assert.equal(cursor(env).h, 10);
    assert.equal(net.alerts().length, 0);
  }
  await at(env, T0 + 60 + 60 * BLOCK_FAILS);
  assert.equal(cursor(env).h, 12);
  assert.equal(net.alerts().length, 1, "the blocks after it still count");

  // The indexer is down for hours.
  bb.down = true;
  await at(env, T0 + 3600);
  assert.equal(cursor(env).h, 12);
  bb.down = false;
  for (let h = 13; h <= 13 + MAX_BEHIND + 5; h++) bb.chain[h] = { txs: [tx(h, OTHER, [A, 1e8])] };
  const before = bb.reads.length;
  await at(env, T0 + 7200);
  assert.deepEqual(bb.reads.slice(before), [13 + MAX_BEHIND + 5], "only the tip is read");
  assert.equal(net.alerts().length, 2);
});

test("cron: our own indexer first, with its key; the official one when ours is behind", async () => {
  setNow(T0);
  const net = installFetch();
  const own = blockbook(net, "node.pearlhub.net");
  const official = blockbook(net);
  const env = makeEnv({ OWN_BLOCKBOOK_BASE: undefined, OWN_BLOCKBOOK_KEY: "k" });
  own.chain[10] = official.chain[10] = { txs: [] };
  await put(env, tok(1), { addr: A });
  await at(env, T0 + 60);
  assert.deepEqual([own.reads, official.reads], [[10], []]);
  own.down = true;
  official.chain[11] = { txs: [tx(1, OTHER, [A, 1e8])] };
  await at(env, T0 + 120);
  assert.deepEqual(official.reads, [11]);
  assert.equal(net.alerts().length, 1);
});

test("cron: at most PENDING_MAX payments are held; every one pushed is remembered", async () => {
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[1] = { txs: [] };
  await put(env, tok(1), { addr: A });
  await at(env, T0 + 60);
  bb.chain[2] = { txs: Array.from({ length: PENDING_MAX + 5 }, (_, i) => tx(100 + i, OTHER, [A, 1])) };
  await at(env, T0 + 120);
  assert.equal(net.alerts().length, 1);
  assert.deepEqual(net.alerts()[0].body.income.n, PENDING_MAX);
  assert.equal(net.alerts()[0].body.income.txid, txid(100 + PENDING_MAX + 4));
  const told = JSON.parse(row(env, tok(1)).told);
  assert.ok(TOLD_KEEP >= PENDING_MAX);
  assert.equal(told.length, PENDING_MAX);
  assert.equal(told[0], txid(100 + PENDING_MAX + 4), "newest first");
});

test("cron: held news that can't be read is dropped, not pushed and not fatal", async () => {
  // T0 is 08:00 in Shanghai: outside a 09:00–22:00 window.
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[1] = { txs: [] };
  await put(env, tok(1), { addr: A }, { window: { start: 9 * 60, end: 22 * 60, tz: "Asia/Shanghai" } });
  await put(env, tok(2), { addr: A });
  env.DB.raw.prepare("UPDATE income_watches SET pending = ? WHERE token = ?")
    .run(JSON.stringify([[txid(7), "not a number", T0], "junk", [txid(8), "300000000", T0]]), tok(2));
  await at(env, T0 + 60);
  assert.deepEqual(net.alerts().map((c) => [c.token, c.body.aps.alert.title]), [[tok(2), "Received 3 PRL"]]);
  assert.equal(row(env, tok(2)).pending, "[]");
});

test("cron: a block without its parent's hash is a failed read, not a reorg", async () => {
  setNow(T0);
  const net = installFetch();
  const bb = blockbook(net);
  const env = makeEnv();
  bb.chain[10] = { txs: [] };
  await put(env, tok(1), { addr: A });
  await at(env, T0 + 60);
  bb.noPrev = true;
  bb.chain[11] = { txs: [tx(1, OTHER, [A, 1e8])] };
  await at(env, T0 + 120);
  assert.equal(cursor(env).h, 10, "neither moved on nor stepped back");
  assert.equal(cursor(env).fails, 1);
  bb.noPrev = false;
  await at(env, T0 + 180);
  assert.equal(cursor(env).h, 11);
  assert.equal(net.alerts().length, 1);
});

test("cron: an indexer that failed a block is not asked for the next one in the same tick", async () => {
  setNow(T0);
  const net = installFetch();
  const own = blockbook(net, "node.pearlhub.net");
  const official = blockbook(net);
  const env = makeEnv({ OWN_BLOCKBOOK_BASE: undefined, OWN_BLOCKBOOK_KEY: "k" });
  own.chain[10] = official.chain[10] = { txs: [] };
  await put(env, tok(1), { addr: A });
  await at(env, T0 + 60);
  // Ours answers for the tip but not for blocks.
  for (const h of [11, 12, 13]) own.chain[h] = official.chain[h] = { txs: [tx(h, OTHER, [A, 1e8])] };
  own.blocksDown = true;
  const before = own.reads.length;
  await at(env, T0 + 120);
  assert.deepEqual(own.reads.slice(before), [11], "asked once, then left alone this tick");
  assert.deepEqual(official.reads, [11, 12, 13]);
  assert.equal(net.alerts().length, 1);
  assert.equal(net.alerts()[0].body.aps.alert.title, "Received 3 PRL in 3 payments");
});

test("schema: the cron's minute-by-minute lookups use their indexes", () => {
  const env = makeEnv();
  const plan = (sql) => env.DB.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT i.token FROM income_watches i JOIN devices d ON d.token = i.token WHERE i.pending <> '[]'"), /income_watches_pending/);
  assert.match(plan("SELECT i.token FROM income_watches i JOIN devices d ON d.token = i.token WHERE i.addr IN (SELECT value FROM json_each('[]'))"), /income_watches_addr/);
});
