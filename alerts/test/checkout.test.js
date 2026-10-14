import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call as rawCall, installFetch, setNow, restoreNow, T0, tok, tick } from "./helpers.js";
import { createOrder, checkPayments, ORDER_TTL } from "../src/orders.js";
import { pruneEmptyGroups } from "../src/groupstore.js";
import { sha256 } from "../src/http.js";

import { seedSession } from "./account-fixture.js";
const call = async (env, method, path, body, h) => {
  const token = h?.Authorization?.replace("Bearer ", "");
  if (["A".repeat(43), "B".repeat(43)].includes(token)) await seedSession(env, token);
  return rawCall(env, method, path, body, h);
};
const realFetch = globalThis.fetch;
afterEach(() => {
  restoreNow();
  globalThis.fetch = realFetch;
});
const addr = "prl1" + "a".repeat(38);
const headers = { Authorization: `Bearer ${"A".repeat(43)}` };
const gid = await sha256("A".repeat(43));
const ciphertext = Buffer.from(new Uint8Array(40)).toString("base64");
const price = (env, t = T0) => env.DB.raw.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('price', ?, ?)")
  .run(JSON.stringify({ usd: 0.8, ts: t }), t);
const emptyGroup = (env, id, created = T0) => env.DB.raw
  .prepare("INSERT INTO groups (gid, created_at, seen_at) VALUES (?, ?, ?)").run(id, created, created);
function fullFreeStorage(env) {
  const insert = env.DB.raw.prepare("INSERT INTO groups (gid, created_at, seen_at, config) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 1000; i++) insert.run(`free${i}`, T0, T0, ciphertext);
}
function chain(txs = []) {
  const apns = installFetch(), previous = globalThis.fetch, addresses = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "blockbook.pearlresearch.ai") {
      if (u.pathname === "/api/") return Response.json({ blockbook: { bestHeight: 1000, inSync: true } });
      if (u.pathname.startsWith("/api/v2/address/")) {
        addresses.push(String(url));
        return Response.json({ transactions: txs, totalPages: 1 });
      }
      if (u.pathname.startsWith("/api/v2/block/")) return Response.json({ time: T0, difficulty: 1 });
    }
    return previous(url, init);
  };
  return { apns, addresses };
}
const payment = (order, confirmations, t) => ({
  txid: "c".repeat(64), confirmations, blockHeight: confirmations ? 1001 : undefined, blockTime: t,
  vin: [{ addresses: ["sender"], value: String(order.sats + 100) }],
  vout: [{ addresses: [addr], value: String(order.sats) }],
});

test("checkout cleanup: every minute, strict 30-minute boundary, identity only and no payment dependency", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0); chain(); price(env);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  const saved = env.DB.one("SELECT * FROM orders WHERE id = ?", order.id);
  env.PAY_ADDRESS = "";
  globalThis.fetch = async () => new Response(null, { status: 500 });
  for (const [offset, kept] of [[29 * 60, true], [ORDER_TTL, true], [ORDER_TTL + 60, false]]) {
    setNow(T0 + offset);
    // A recent read cannot extend a checkout-only identity's lifetime.
    if (kept) env.DB.raw.prepare("UPDATE groups SET seen_at = ? WHERE gid = ?").run(T0 + offset, gid);
    env.DB.log.length = 0;
    await tick(env);
    assert.equal(!!env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid), kept);
    assert.deepEqual(env.DB.one("SELECT * FROM orders WHERE id = ?", order.id), saved);
    assert.equal(env.DB.log.filter((sql) => sql.startsWith("DELETE FROM groups")).length, 1);
    assert.equal(env.DB.log.some((sql) => sql.startsWith("DELETE FROM orders")), false);
  }
});

test("checkout cleanup: no orders, broken reconciler and thrown price work still run the minute deletion", async () => {
  for (const failure of ["none", "payment", "price"]) {
    const env = makeEnv({ PAY_ADDRESS: addr }, {
      before: (sql) => {
        if (failure === "payment" && sql.includes("MIN(created_at)")) throw Error("payment fixture failed");
        if (failure === "price" && sql.includes("FROM prices")) throw Error("price fixture failed");
      },
    });
    setNow(T0 + ORDER_TTL + 60); emptyGroup(env, gid);
    const fixture = chain();
    if (failure === "price") await assert.rejects(tick(env), /price fixture failed/);
    else await tick(env);
    assert.equal(env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid), null, failure);
    assert.equal(fixture.addresses.length, 0);
  }
});

test("checkout cleanup: saved config, any device, Apple links, Pro, seen and active pending orders are protected", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  const t = T0 + ORDER_TTL + 60;
  setNow(t); chain();
  for (const id of ["empty", "config", "web", "native", "apple", "pro", "pending", "seen", "expired", "paid"])
    emptyGroup(env, id);
  env.DB.raw.prepare("UPDATE groups SET config = ? WHERE gid = 'config'").run(ciphertext);
  env.DB.raw.prepare("UPDATE groups SET pro_at = 0 WHERE gid = 'pro'").run();
  for (const [id, chan] of [["web", "webpush"], ["native", "apns"]])
    env.DB.raw.prepare("INSERT INTO devices (token, env, topic, updated_at, chan, gid) VALUES (?, 'production', 'fixture', ?, ?, ?)")
      .run(id, t, chan, id);
  // Even a refunded link must survive to retain the purchase's replay protection.
  env.DB.raw.prepare("INSERT INTO apple_purchases (original_tx, revoked_at) VALUES ('refunded', ?)").run(t);
  env.DB.raw.prepare("INSERT INTO apple_links (original_tx, gid, linked_at) VALUES ('refunded', 'apple', ?)").run(T0);
  const insert = env.DB.raw.prepare("INSERT INTO orders (id, gid, usd, rate, sats, created_at, expires_at, status) VALUES (?, ?, 5, 1, ?, ?, ?, ?)");
  for (const [i, id] of ["pending", "seen", "expired", "paid"].entries())
    insert.run(id, id, i + 1, T0, id === "pending" ? t + 60 : t, id === "seen" ? "seen" : id === "paid" ? "paid" : "pending");
  // An expired order never overrides another seen order's protection.
  insert.run("seen-expired", "seen", 5, T0, T0 + ORDER_TTL, "pending");
  await tick(env);
  assert.deepEqual(env.DB.rows("SELECT gid FROM groups ORDER BY gid").map((g) => g.gid),
    ["apple", "config", "native", "pending", "pro", "seen", "web"]);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM orders").n, 5);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM devices").n, 2);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM apple_links").n, 1);
});

for (const initiallyConfirmed of [true, false]) {
  test(`late payment: deleted identity restored at a full free cap (${initiallyConfirmed ? "confirmed" : "seen then confirmed"}) and idempotency`, async () => {
    const env = makeEnv({ PAY_ADDRESS: addr });
    setNow(T0); chain(); price(env);
    const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
    setNow(T0 + ORDER_TTL + 60); await tick(env);
    assert.equal(env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid), null);
    const before = await call(env, "GET", "/v1/me", undefined, headers);
    assert.equal(before.body.pro, false);
    assert.equal(before.body.order, null);
    assert.equal((await call(env, "GET", `/v1/orders/${order.id}`, undefined, headers)).body.status, "pending");
    assert.equal((await call(env, "GET", `/v1/orders/${order.id}`, undefined, { Authorization: `Bearer ${"B".repeat(43)}` })).status, 404);
    assert.equal(env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid), null);
    fullFreeStorage(env);
    const late = T0 + 6 * 86400, tx = payment(order, initiallyConfirmed ? 1 : 0, late);
    const fixture = chain([tx]);
    setNow(late); await checkPayments(env);
    let confirmedAt = late;
    if (!initiallyConfirmed) {
      assert.equal(env.DB.one("SELECT status FROM orders WHERE id = ?", order.id).status, "seen");
      assert.equal(env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid), null);
      assert.equal(fixture.apns.alerts().length, 0);
      tx.confirmations = 1; tx.blockHeight = 1001;
      confirmedAt += 20; setNow(confirmedAt); await checkPayments(env);
    }
    const restored = env.DB.one("SELECT * FROM groups WHERE gid = ?", gid);
    assert.equal(restored.pro_at, confirmedAt);
    assert.equal(restored.created_at, confirmedAt);
    assert.equal(restored.seen_at, confirmedAt);
    assert.equal(restored.pro_src, "prl");
    assert.equal(restored.pro_ref, tx.txid);
    assert.equal(restored.config, null);
    const settled = env.DB.one("SELECT * FROM orders WHERE id = ?", order.id);
    assert.equal(settled.status, "paid");
    assert.equal(settled.paid_at, confirmedAt);
    assert.equal(env.DB.one("SELECT order_id, confirmed FROM payments WHERE txid = ?", tx.txid).confirmed, 1);
    assert.equal(env.DB.one("SELECT order_id FROM payments WHERE txid = ?", tx.txid).order_id, order.id);
    const me = await call(env, "GET", "/v1/me", undefined, headers);
    assert.equal(me.body.pro, true);
    assert.equal(me.body.order.id, order.id);
    // Keep another pending order so repeated checks actually process the page.
    price(env, confirmedAt);
    assert.equal((await createOrder(env, "b".repeat(64), "ip", () => 3818)).status, 200);
    setNow(confirmedAt + 20);
    await Promise.all([checkPayments(env), checkPayments(env)]);
    setNow(confirmedAt + 40); await checkPayments(env);
    assert.deepEqual(env.DB.one("SELECT * FROM groups WHERE gid = ?", gid), restored);
    assert.deepEqual(env.DB.one("SELECT * FROM orders WHERE id = ?", order.id), settled);
    assert.equal(env.DB.one("SELECT COUNT(*) n FROM payments").n, 1);
  });
}

test("payment restoration: existing Pro timestamp and saved configuration survive the PRL upsert", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0); chain(); price(env);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  env.DB.raw.prepare("UPDATE groups SET pro_at = ?, pro_src = 'admin', pro_ref = 'prior', config = ?, config_rev = 7 WHERE gid = ?")
    .run(T0 - 60, ciphertext, gid);
  const tx = payment(order, 1, T0 + 20); chain([tx]);
  setNow(T0 + 20); await checkPayments(env);
  assert.deepEqual(env.DB.one("SELECT created_at, seen_at, pro_at, pro_src, pro_ref, config, config_rev FROM groups WHERE gid = ?", gid),
    { created_at: T0, seen_at: T0, pro_at: T0 - 60, pro_src: "prl", pro_ref: tx.txid, config: ciphertext, config_rev: 7 });
});

test("payment restoration: a failed identity insert rolls back settlement and a retry grants Pro once", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0); chain(); price(env);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  setNow(T0 + ORDER_TTL + 60); await tick(env);
  const tx = payment(order, 1, T0 + ORDER_TTL + 120), fixture = chain([tx]);
  env.DB.raw.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON groups BEGIN SELECT RAISE(ABORT, 'fixture insert failed'); END");
  setNow(T0 + ORDER_TTL + 120);
  await assert.rejects(checkPayments(env), /fixture insert failed/);
  assert.equal(env.DB.one("SELECT status FROM orders WHERE id = ?", order.id).status, "pending");
  assert.equal(env.DB.one("SELECT confirmed FROM payments WHERE txid = ?", tx.txid).confirmed, 0);
  assert.equal(env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid), null);
  assert.equal(fixture.apns.alerts().length, 0);
  env.DB.raw.exec("DROP TRIGGER reject_restore");
  setNow(T0 + ORDER_TTL + 140); await checkPayments(env);
  assert.equal(env.DB.one("SELECT status FROM orders WHERE id = ?", order.id).status, "paid");
  assert.equal(env.DB.one("SELECT pro_src FROM groups WHERE gid = ?", gid).pro_src, "prl");
});

test("checkout: verified account purchases bypass the obsolete anonymous storage cap", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0); chain(); price(env); fullFreeStorage(env);
  assert.equal((await call(env, "POST", "/v1/orders", undefined, headers)).status, 200);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM groups WHERE pro_at IS NULL").n, 1001);
});
test("checkout: authenticated checkout after legacy cleanup preserves old orders", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr });
  setNow(T0); chain(); price(env);
  const old = await (await createOrder(env, gid, "ip", () => 3817)).json();
  setNow(T0 + ORDER_TTL + 60); await tick(env);
  assert.equal(env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid), null);
  const t = T0 + ORDER_TTL + 120; setNow(t); price(env, t);
  const next = await call(env, "POST", "/v1/orders", undefined, headers);
  assert.equal(next.status, 200);
  assert.notEqual(next.body.id, old.id);
  assert.notEqual(next.body.sats, old.sats);
  assert.equal(next.body.expires_at, t + ORDER_TTL);
  assert.deepEqual(env.DB.one("SELECT created_at, seen_at FROM groups WHERE gid = ?", gid), { created_at: t, seen_at: t });
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM orders WHERE gid = ?", gid).n, 2);
  assert.equal(env.DB.one("SELECT status FROM orders WHERE id = ?", old.id).status, "pending");
  // Checkout's IP throttle remains in force after identity recreation.
  env.RL_NEW = { limit: async () => ({ success: false }) };
  assert.equal((await call(env, "POST", "/v1/orders", undefined, { Authorization: `Bearer ${"B".repeat(43)}` })).status, 429);
  assert.equal((await call(env, "POST", "/v1/orders", undefined, headers)).body.id, next.body.id);
});

test("checkout: cleanup racing the quote write cannot strand the identity or order", async () => {
  let raced = false;
  const env = makeEnv({ PAY_ADDRESS: addr }, { beforeBatch: async (stmts) => {
    if (!raced && stmts.some((s) => s.sql.includes("INSERT INTO orders"))) {
      raced = true;
      await pruneEmptyGroups(env.DB, T0 + ORDER_TTL + 60).run();
      assert.equal(env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid), null);
    }
  } });
  const t = T0 + ORDER_TTL + 60; setNow(t); chain(); price(env, t); emptyGroup(env, gid);
  assert.equal((await createOrder(env, gid, "ip", () => 3817)).status, 200);
  assert.equal(raced, true);
  assert.equal(env.DB.one("SELECT created_at FROM groups WHERE gid = ?", gid).created_at, t);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM orders WHERE gid = ?", gid).n, 1);
  await pruneEmptyGroups(env.DB, t).run();
  assert.ok(env.DB.one("SELECT gid FROM groups WHERE gid = ?", gid));
});

test("admin restoration: order and gid grants rebuild deleted identities at the cap and preserve original pro_at", async () => {
  const env = makeEnv({ PAY_ADDRESS: addr, ADMIN_TOKEN: "admin" });
  const other = "b".repeat(64), adminHeaders = { Authorization: "Bearer admin" };
  setNow(T0); chain(); price(env); emptyGroup(env, other);
  const order = await (await createOrder(env, gid, "ip", () => 3817)).json();
  setNow(T0 + ORDER_TTL + 60); await tick(env);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM groups").n, 0);
  fullFreeStorage(env);
  const t = T0 + ORDER_TTL + 120; setNow(t);
  const txid = "d".repeat(64);
  assert.equal((await call(env, "POST", "/v1/admin/grant", { order_id: order.id, txid }, adminHeaders)).status, 200);
  assert.deepEqual(env.DB.one("SELECT pro_at, pro_src, pro_ref, created_at FROM groups WHERE gid = ?", gid),
    { pro_at: t, pro_src: "admin", pro_ref: txid, created_at: t });
  assert.equal(env.DB.one("SELECT status FROM orders WHERE id = ?", order.id).status, "paid");
  assert.equal((await call(env, "POST", "/v1/admin/grant", { gid: other, note: "support" }, adminHeaders)).status, 200);
  env.DB.raw.prepare("UPDATE groups SET config = ?, config_rev = 2 WHERE gid = ?").run(ciphertext, gid);
  setNow(t + 60);
  for (const body of [{ order_id: order.id }, { gid: other, note: "follow-up" }])
    assert.equal((await call(env, "POST", "/v1/admin/grant", body, adminHeaders)).status, 200);
  assert.equal(env.DB.one("SELECT pro_at FROM groups WHERE gid = ?", gid).pro_at, t);
  assert.equal(env.DB.one("SELECT pro_at FROM groups WHERE gid = ?", other).pro_at, t);
  assert.equal(env.DB.one("SELECT config FROM groups WHERE gid = ?", gid).config, ciphertext);
  assert.equal(env.DB.one("SELECT config_rev FROM groups WHERE gid = ?", gid).config_rev, 2);
  assert.equal(env.DB.one("SELECT COUNT(*) n FROM groups WHERE pro_at IS NOT NULL").n, 2);
});
