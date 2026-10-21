// Exact-amount orders: integer decimal arithmetic, atomic claims, no public txid claiming.
import { webJson as json, now, hex } from "./http.js";
import { chainAddress, chainHeight, totalTo, ADDRESS_RE } from "./chain.js";
import { send, apnsConfigured } from "./apns.js";
import { logError } from "./log.js";
export const ORDER_TTL = 1800; // seconds, quote validity and empty identity lifetime
const MATCH_FOR = 7 * 86400; // seconds
const PRICE_STALE = 300; // seconds
const CHECK_EVERY = 15; // seconds, shared by cron and order polling
export const paymentSettings = (env) => ({
  enabled: ADDRESS_RE.test(env.PAY_ADDRESS || ""),
  usd: Number(env.PRO_USD || 5),
});
export const publicOrder = (env, o) => ({
  id: o.id,
  address: env.PAY_ADDRESS,
  amount: `${Math.floor(o.sats / 1e8)}.${String(o.sats % 1e8)
    .padStart(8, "0")
    .slice(0, 6)}`,
  sats: o.sats,
  usd: o.usd,
  rate: o.rate,
  created_at: o.created_at,
  expires_at: o.expires_at,
  status: o.status,
  txid: o.txid || null,
});
function decimal(v) {
  const s = String(v),
    m = s.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!m) throw new Error("bad price");
  let a = BigInt(m[1] + (m[2] || "")),
    scale = (m[2]?.length || 0) - Number(m[3] || 0);
  return scale >= 0
    ? [a, 10n ** BigInt(scale)]
    : [a * 10n ** BigInt(-scale), 1n];
}
export function orderSats(usd, price, tail) {
  if (
    !(usd > 0 && price > 0 && Number.isFinite(usd) && Number.isFinite(price)) ||
    !Number.isInteger(tail) ||
    tail < 1 ||
    tail > 9999
  )
    throw new Error("bad amount");
  const [u, ud] = decimal(usd),
    [p, pd] = decimal(price);
  const numerator = u * pd * 100n,
    denominator = ud * p;
  const cents = (numerator + denominator - 1n) / denominator;
  const sats = cents * 1000000n + BigInt(tail) * 100n;
  if (sats > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("amount too large");
  return Number(sats);
}
function randomTail() {
  const bytes = new Uint32Array(1),
    max = Math.floor(2 ** 32 / 9999) * 9999;
  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0] >= max);
  return (bytes[0] % 9999) + 1;
}
export async function createOrder(env, gid, ip, tail = randomTail) {
  if (!paymentSettings(env).enabled)
    return json({ error: "payments_off" }, 503);
  const db = env.DB,
    t = now();
  if (
    (
      await db
        .prepare("SELECT pro_at FROM groups WHERE gid = ?")
        .bind(gid)
        .first()
    )?.pro_at != null
  )
    return json({ error: "already_pro" }, 409);
  const active = () =>
    db
      .prepare(
        "SELECT * FROM orders WHERE gid = ? AND (status = 'seen' OR (status = 'pending' AND expires_at > ?)) ORDER BY created_at DESC LIMIT 1",
      )
      .bind(gid, t)
      .first();
  const old = await active();
  if (old) return json(publicOrder(env, old));
  if (env.RL_NEW && !(await env.RL_NEW.limit({ key: ip })).success)
    return json({ error: "rate limited" }, 429);
  const row = await db.prepare("SELECT v FROM kv WHERE k = 'price'").first();
  let p;
  try {
    p = JSON.parse(row?.v);
  } catch {
    /* no usable quote */
  }
  const usd = Number(env.PRO_USD || 5);
  if (
    !p ||
    !(p.usd > 0) ||
    !Number.isFinite(p.usd) ||
    !Number.isFinite(p.ts) ||
    t - p.ts > PRICE_STALE ||
    !(usd > 0)
  )
    return json({ error: "price_unavailable" }, 503);
  let height;
  try { height = await chainHeight(env); }
  catch (e) { logError("checkout chain height failed", e, env); return json({ error: "upstream" }, 503); }
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = hex(crypto.getRandomValues(new Uint8Array(16))),
      sats = orderSats(usd, p.usd, tail());
    try {
      // Checkout bypasses the free config cap. Create the identity and order
      // atomically so minute cleanup cannot remove it between these writes.
      // A second concurrent checkout for this identity returns the first order.
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO groups (gid, created_at, seen_at) VALUES (?, ?, ?)")
          .bind(gid, t, t),
        db.prepare(
          `INSERT INTO orders (id, gid, usd, rate, sats, created_at, expires_at, start_height)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
        (SELECT 1 FROM orders WHERE gid = ? AND (status = 'seen' OR (status = 'pending' AND expires_at > ?)))
        AND EXISTS (SELECT 1 FROM groups WHERE gid = ? AND pro_at IS NULL)`,
        )
        .bind(id, gid, usd, p.usd, sats, t, t + ORDER_TTL, height, gid, t, gid),
      ]);
      const o = await active();
      return o
        ? json(publicOrder(env, o))
        : json({ error: "already_pro" }, 409);
    } catch (e) {
      if (!String(e).includes("UNIQUE") || !String(e).includes("sats")) throw e;
    }
  }
  return json({ error: "busy" }, 503);
}
export async function getOrder(env, gid, id) {
  const db = env.DB;
  let o = await db
    .prepare("SELECT * FROM orders WHERE id = ? AND gid = ?")
    .bind(id, gid)
    .first();
  if (!o) return json({ error: "not found" }, 404);
  if (o.status !== "paid") {
    try {
      await checkPayments(env);
    } catch (e) {
      logError("payment check failed", e, env);
    }
    o = await db
      .prepare("SELECT * FROM orders WHERE id = ? AND gid = ?")
      .bind(id, gid)
      .first();
  }
  return json(publicOrder(env, o));
}
/// The pay address shown before PAY_ADDRESS, and when it stopped being shown (PAY_ADDRESS_SINCE, unix
/// seconds). Orders carry no address of their own, so one quoted before then may have been paid there
/// (until 2026-10-16 that was the donation address). Null when unset.
export function previousPayAddress(env) {
  const address = env.PAY_ADDRESS_PREVIOUS, since = Number(env.PAY_ADDRESS_SINCE);
  return ADDRESS_RE.test(address || "") && address !== env.PAY_ADDRESS && Number.isSafeInteger(since) && since > 0
    ? { address, since } : null;
}
/// The orders still open to a payment (created before `before`, when given): the earliest one's time and,
/// when they all have one, the lowest chain tip seen at their checkout.
const openOrders = (db, t, before = null) => db
  .prepare(
    `SELECT MIN(created_at) AS earliest, CASE WHEN COUNT(*) = COUNT(start_height) THEN MIN(start_height) END AS height FROM orders WHERE (status = 'seen' OR (status = 'pending' AND created_at >= ?))${before == null ? "" : " AND created_at < ?"}`,
  )
  .bind(t - MATCH_FOR, ...(before == null ? [] : [before]))
  .first();
export async function checkPayments(env) {
  if (!paymentSettings(env).enabled) return;
  const db = env.DB,
    t = now();
  const pending = await openOrders(db, t);
  if (pending?.earliest == null) return;
  const lock = await db
    .prepare(
      `INSERT INTO kv (k, v, ts) VALUES ('paycheck', '', ?)
    ON CONFLICT(k) DO UPDATE SET ts = excluded.ts WHERE kv.ts <= ? RETURNING ts`,
    )
    .bind(t, t - CHECK_EVERY)
    .first();
  if (!lock) return;
  const threshold =
    Number.isInteger(Number(env.PAY_CONFIRMATIONS)) &&
    Number(env.PAY_CONFIRMATIONS) >= 0
      ? Number(env.PAY_CONFIRMATIONS)
      : 1;
  // Bound new/changed payment work as well as pages, across both addresses. Already settled
  // transactions cost a single page lookup; unchanged seen payments need no writes either.
  const budget = { work: 0 };
  if (!await scanAddress(env, db, t, env.PAY_ADDRESS, pending, threshold, budget)) return;
  const previous = previousPayAddress(env);
  if (!previous) return;
  const legacy = await openOrders(db, t, previous.since);
  if (legacy?.earliest != null) await scanAddress(env, db, t, previous.address, legacy, threshold, budget, previous.since);
}
/// Match the payments to `address` against the open orders (`pending`); false once the work budget ran
/// out. `before`: the previous address, which only orders created before then may be paid to.
async function scanAddress(env, db, t, address, pending, threshold, budget, before = null) {
  for (let page = 1; page <= 10; page++) {
    const o = await chainAddress(env, address, 50, page);
    o.transactions = o.transactions.slice(0, 50);
    const ids = [...new Set(o.transactions.map((tx) => tx.txid).filter((id) => typeof id === "string" && /^[0-9a-f]{64}$/i.test(id)))];
    const known = new Map(ids.length ? (await db.prepare(`SELECT * FROM payments WHERE txid IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results.map((p) => [p.txid, p]) : []);
    for (const tx of o.transactions) {
      if (typeof tx.txid !== "string" || !/^[0-9a-f]{64}$/i.test(tx.txid))
        continue;
      if (tx.vin.some((x) => x.addresses?.includes(address))) continue;
      const value = totalTo(tx.vout, address);
      if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      const sats = Number(value),
        confirmed = Number(tx.confirmations || 0) >= threshold;
      let payment = known.get(tx.txid);
      if (payment && (payment.order_id || payment.told_owner) && (payment.confirmed || !confirmed)) continue;
      if (budget.work >= 5) return false; // continue draining on the next check, below D1 Free's query limit
      budget.work++;
      if (!payment) {
        await db
          .prepare("INSERT OR IGNORE INTO payments (txid, sats, first_seen) VALUES (?, ?, ?)")
          .bind(tx.txid, sats, t)
          .run();
        payment = { txid: tx.txid, sats, first_seen: t, confirmed: 0, order_id: null, told_owner: 0 };
      }
      let order = payment.order_id
        ? await db
            .prepare("SELECT * FROM orders WHERE id = ?")
            .bind(payment.order_id)
            .first()
        : await db
            .prepare(
              `SELECT * FROM orders WHERE sats = ? AND status <> 'paid' AND (status = 'seen' OR created_at >= ?) AND created_at <= ? AND (txid IS NULL OR txid = ?)${before == null ? "" : " AND created_at < ?"}`,
            )
            .bind(
              sats,
              t - MATCH_FOR,
              payment.first_seen,
              tx.txid,
              ...(before == null ? [] : [before]),
            )
            .first();
      // A confirmed transaction must be newer than the tip observed at checkout.
      // Previously observed mempool payments and legacy orders use first_seen.
      if (order && !payment.order_id && tx.confirmations > 0 && order.start_height != null &&
          (!Number.isSafeInteger(tx.blockHeight) || tx.blockHeight <= order.start_height)) order = null;
      if (order) {
        // A late payment may outlive its identity. Restore Pro in the same
        // settlement transaction, without the free configuration quota.
        const result = await db.batch([
          db
            .prepare(
              `UPDATE orders SET status = ?, txid = ?, seen_at = COALESCE(seen_at, ?), paid_at = ? WHERE id = ? AND status <> 'paid'`,
            )
            .bind(
              confirmed ? "paid" : "seen",
              tx.txid,
              t,
              confirmed ? t : null,
              order.id,
            ),
          db
            .prepare(
              "UPDATE payments SET confirmed = ?, order_id = ? WHERE txid = ?",
            )
            .bind(confirmed ? 1 : 0, order.id, tx.txid),
          ...(confirmed
            ? [
                db
                  .prepare(
                    `INSERT INTO groups (gid, created_at, seen_at, pro_at, pro_src, pro_ref) VALUES (?, ?, ?, ?, 'prl', ?)
                    ON CONFLICT(gid) DO UPDATE SET pro_at = COALESCE(groups.pro_at, excluded.pro_at), pro_src = 'prl', pro_ref = excluded.pro_ref`,
                  )
                  .bind(order.gid, t, t, t, tx.txid),
              ]
            : []),
        ]);
      } else {
        await db
          .prepare("UPDATE payments SET confirmed = ? WHERE txid = ?")
          .bind(confirmed ? 1 : 0, tx.txid)
          .run();
        if (before != null) await db.prepare("UPDATE payments SET told_owner = 1 WHERE txid = ?").bind(tx.txid).run();
        else if (!tx.confirmations || (pending.height != null ? tx.blockHeight > pending.height : tx.blockTime > pending.earliest)) {
          const claim = await db
            .prepare(
              "UPDATE payments SET told_owner = 1 WHERE txid = ? AND told_owner = 0",
            )
            .bind(tx.txid)
            .run();
        } else await db.prepare("UPDATE payments SET told_owner = 1 WHERE txid = ?").bind(tx.txid).run();
      }
    }
    if (
      page >= (o.totalPages || 1) ||
      (o.transactions.length &&
        o.transactions.every(
          (tx) => pending.height != null && tx.confirmations > 0 && tx.blockHeight <= pending.height,
        ))
    )
      break;
  }
  return true;
}
export async function admin(env, method, path, body) {
  const db = env.DB,
    t = now();
  if (method === "GET" && path === "payments")
    return json({
      payments: (
        await db
          .prepare(
            "SELECT * FROM payments WHERE order_id IS NULL ORDER BY first_seen DESC LIMIT 200",
          )
          .all()
      ).results,
    });
  if (method !== "POST" || path !== "grant")
    return json({ error: "not found" }, 404);
  let gid = body?.gid,
    ref = typeof body?.note === "string" ? body.note.slice(0, 200) : "admin";
  const writes = [];
  if (body?.order_id) {
    const o = await db
      .prepare("SELECT * FROM orders WHERE id = ?")
      .bind(String(body.order_id))
      .first();
    if (!o) return json({ error: "not found" }, 404);
    gid = o.gid;
    if (body.txid != null && !/^[0-9a-f]{64}$/i.test(body.txid))
      return json({ error: "bad txid" }, 400);
    ref = body.txid || body.order_id;
    writes.push(
      db
        .prepare(
          "UPDATE orders SET status = 'paid', paid_at = ?, txid = COALESCE(?, txid) WHERE id = ?",
        )
        .bind(t, body.txid || null, o.id),
    );
    if (body.txid)
      writes.push(
        db
          .prepare("UPDATE payments SET order_id = ? WHERE txid = ?")
          .bind(o.id, body.txid),
      );
  }
  if (typeof gid !== "string" || !/^(?:[0-9a-f]{64}|u_[A-Za-z0-9_-]{16,80}|g_[0-9a-f]{64})$/.test(gid))
    return json({ error: "bad gid" }, 400);
  writes.push(
    db
      .prepare(
        `INSERT INTO groups (gid, created_at, seen_at, pro_at, pro_src, pro_ref) VALUES (?, ?, ?, ?, 'admin', ?)
    ON CONFLICT(gid) DO UPDATE SET pro_at = COALESCE(groups.pro_at, excluded.pro_at), pro_src = 'admin', pro_ref = excluded.pro_ref`,
      )
      .bind(gid, t, t, t, ref),
  );
  await db.batch(writes);
  return json({ ok: true });
}
