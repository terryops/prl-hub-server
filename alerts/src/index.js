// Pearl Hub price-alert worker.
//
//   * * * * *  cron   price → D1 history → evaluate every enabled rule → APNs
//                     (on one-shot devices a rule that was pushed is switched off;
//                     one that fires in the device's quiet hours is queued in
//                     `deferred` and pushed at the next window start)
//                     then 掉线提醒: poll the pool miners that are due (each one every
//                     3 min), push the workers that have been offline long enough,
//                     and the ones a device was told about that are back online
//   GET    /v1/price/history              24h same-source price history
//          /v1/price/history?span=…       BigONE daily close (7d / 30d / 90d)
//   GET    /v1/network/history?span=…     sampled D1 history (24h / 7d / 30d / all)
//   GET    /v1/fx                         thirteen USD exchange rates
//   GET    /v1/pools                      public comparison and network yield
//   POST   /v1/pool/stats, /v1/address    read-only pool / chain queries (body identifiers)
//   POST   /v1/address/income             chain receipts excluding monitored self-transfers
//   GET    /v1/me, /v1/orders/:id        anonymous web Pro / order status
//   POST   /v1/orders                   exact-amount PRL checkout
//   GET    /v1/web/status               public feature availability (no identity creation)
//   PUT    /v1/web/push                 Pro browser subscription and alert settings
//   GET/PUT /v1/me/config               encrypted cross-device configuration
//   POST   /v1/me/apple                  link a verified StoreKit Pro receipt
//   GET    /v1/admin/payments           unmatched payments (ADMIN_TOKEN)
//   POST   /v1/admin/grant              manual Pro grants (ADMIN_TOKEN)
//   GET    /v1/price                      current price, sources, 1h/24h change
//   PUT    /v1/devices/:token             register/replace a device's rules and (1.20+,
//                                         `watches`) the pool monitors it wants offline
//                                         pushes for (watch.js)
//   GET    /v1/devices/:token             that device's rules + armed state, and its
//                                         watches + when each was last checked
//   DELETE /v1/devices/:token             forget the device
//   POST   /v1/devices/:token/test        send a test notification (1/min)
//   PUT    /v1/live/:token                register a 锁屏盯盘 Live Activity push token
//   DELETE /v1/live/:token                forget it (activity ended)
//   POST   /v1/ingest/safetrade           SafeTrade ticker from the push script
//                                         (bearer INGEST_TOKEN; see price.js)
//   POST   /v1/asn/:secret                App Store Server Notifications V2 (refund / revoke)
//
// A device is identified only by its APNs token (which only that device knows).
// Price alerts send nothing about the user's wallet. 掉线提醒 is opt-in per
// monitor and does send what the pool needs to be asked about it: the payout
// address (F2Pool: the account's read-only page key) — never keys or balances.
//
// Pro: device and live registrations may carry `pro_jws`, the StoreKit 2 signed
// transaction of the Pro purchase. It is verified against Apple's root (jws.js)
// and its originalTransactionId stored, so a refund (App Store notification)
// stops that device's pushes. Apps before 1.17 don't send it and still register
// — set REQUIRE_PRO = "1" once they are gone.
//
// Delivery is at most once: a tick first commits every rule it is about to push
// as fired, then pushes, then puts back the ones APNs didn't take for a
// transient reason. A crash or a hung request can lose one push, never repeat it.

import { fetchQuotes, combine, parseSafeTrade, ST_MAX_AGE } from "./price.js";
import { evaluate, sanitizeRule, upsertRule, pctChange, WINDOWS, sanitizeWindow, windowOpen, localHM } from "./rules.js";
import { send, apnsConfigured } from "./apns.js";
import { payloadFor, deferredPayloadFor, offlinePayloadFor, onlinePayloadFor, LANGS } from "./i18n.js";
import { fetchMiner, POOLS } from "./pools.js";
import { fold, due as outages, tell, unpack, pack, sanitizeWatch, upsertWatch, POLL_EVERY, RECHECK } from "./watch.js";
import { jwsPayload, notificationFields, PRO } from "./sales.js";
import { verifyAppleJWS } from "./jws.js";
import { poolStats } from "./poolstats.js";
import { overview } from "./overview.js";
import { address, priceHistory } from "./chain.js";
import { me } from "./groups.js";
import { createOrder, getOrder, checkPayments, admin, paymentSettings } from "./orders.js";
import { deliver, channelConfigured, accountPushAllowed } from "./push.js";
import { configured as webpushConfigured, validateSubscription } from "./webpush.js";
import { sha256, json, now, cached } from "./http.js";
import { pruneGroups, pruneEmptyGroups } from "./groupstore.js";
import { logError } from "./log.js";
import { revokeApple } from "./apple.js";
import { income } from "./income.js";
import { fx } from "./fx.js";
import { networkHistory, sampleNetwork } from "./network.js";
import { realFees, refreshRealFees } from "./realfees.js";
import { longPriceHistory } from "./pricehistory.js";
import { authRoutes, authenticate, enabled as accountsEnabled, authCleanup } from "./auth.js";
import { accountRoutes, claimPush, pushOwner, releasePush } from "./account.js";
import { purchaseRoutes, buyerContexts, buyerMe, associatePurchase, refreshPurchase, claimPurchasePush, purchaseProSQL, prunePurchases } from "./purchases.js";
// The GPU reference table (hashrate / power / price / rent per card). One file feeds the
// iOS / Mac app (bundled as its offline copy), this endpoint, and through it the web app.
import gpuCatalog from "../../Sources/PRLMonitor/gpus.json" with { type: "json" };
import { getConfig as accountConfig, putConfig as saveAccountConfig } from "./account-config.js";
import { syncPaid, bindApple } from "./entitlements.js";

const MAX_RULES = 20;
const MAX_WATCHES = 20;
const POLL_SLACK = 20;              // a miner is due this much before its turn is up (cron jitter)
const POLL_PER_TICK = 200;          // miners polled per tick, all pools together…
const POLL_PER_POOL = { default: 60, PearlHash: 30 };   // …and per pool (PearlHash allows 60 requests / min)
const POLL_PARALLEL = 6;            // Workers hold at most 6 connections open at once
const POLL_WALL_MS = 35_000;        // no new poll is started this far into a tick
const POOL_FAILS = 3;               // failed polls after which a pool is left alone until the next tick
const POOL_REST = 10 * 60;          // a pool that answered 429 is not asked again for this long
const OFFLINE_TTL = 4 * 3600;       // an offline (or back-online) push is still worth delivering hours later
const PUSHES_PER_DEVICE = 3;        // offline / back-online pushes to one device per tick; the rest go at their next poll
const WATCH_STALE = 30 * 60;        // a watched miner the pool hasn't answered for this long is reported stale
const IDLE_CHECK = 30 * 86400;      // a device with watches that hasn't checked in for this long is asked of APNs…
const IDLE_CHECKS = 20;             // …this many an hour
const BATCH = 50;                   // statements per D1 batch in the watch stage
const SENT_KEEP = 7 * 86400;        // how long a tick's push outcomes stay readable (kv 'sent:<t>')
const LIVE_PUSH_FOR = 8 * 3600;     // iOS ends a Live Activity after 8 h…
const LIVE_KEEP = 12 * 3600;        // …and removes it from the Lock Screen by 12 h
const LIVE_HEARTBEAT = 10 * 60;     // re-push an unchanged price this often (stale date)
const HISTORY_KEEP = 26 * 3600;
const DEFERRED_KEEP = 48 * 3600;    // a queued alert older than this is dropped
const DEVICE_KEEP = 90 * 86400;     // a device not seen for this long is forgotten
const SEEN_EVERY = 3600;            // record a check-in at most this often
const PREV_MAX_AGE = 3600;          // an older last price can't judge a jump (price.js)
const PRICE_STALE = 300;            // /v1/price flags a price older than this
const UNVERIFIED_PER_TICK = 20;     // pushes per tick to tokens APNs never accepted
const TOKEN_RE = /^[0-9a-f]{64,200}$/;
const LIVE_TOKEN_RE = /^[0-9a-f]{64,512}$/;   // ActivityKit push tokens run longer
// Body caps. A signed StoreKit transaction (3 certificates) is ~4 KB; an App
// Store notification nests one inside another.
const MAX_DEVICE_BODY = 16384;
const MAX_LIVE_BODY = 8192;
const MAX_INGEST_BODY = 16384;
const MAX_ASN_BODY = 65536;

const topicsOf = (env) => (env.APNS_TOPICS || "").split(",").map((s) => s.trim()).filter(Boolean);

// ── price ────────────────────────────────────────────────────────────────────

async function lastPrice(db) {
  return db.prepare("SELECT ts, usd, src FROM prices ORDER BY ts DESC LIMIT 1").first();
}

/// Stored price from the same source closest to (at or before) `at`, if it is
/// within `slack` seconds of it. Same source only: SafeTrade and the median sit
/// a cent or two apart, and a source switch must not read as a price move.
async function priceAt(db, at, slack, src) {
  const row = await db
    .prepare("SELECT ts, usd FROM prices WHERE ts <= ? AND src = ? ORDER BY ts DESC LIMIT 1")
    .bind(at, src)
    .first();
  return row && at - row.ts <= slack ? row.usd : null;
}

async function changes(db, usd, t, open24, src) {
  const out = {};
  await Promise.all(WINDOWS.map(async (w) => {
    // History is per minute; allow half the window (≤ 10 min) of slack, so the
    // 5-min change never compares against a quarter-hour-old price.
    let ref = await priceAt(db, t - w, Math.min(600, w / 2), src);
    // Fresh deployment: no 24h history yet — fall back to the exchanges' own
    // rolling 24h open.
    if (ref == null && w === 86400 && open24) ref = open24;
    out[w] = pctChange(usd, ref);
  }));
  return out;
}

const priceReply = (usd, ts, src, change) =>
  ({ usd, ts, source: src, change5m: change[300], change1h: change[3600], change24h: change[86400] });

// ── cron ─────────────────────────────────────────────────────────────────────

async function tick(env) {
  const db = env.DB;
  const t = now();
  const prev = await lastPrice(db);
  const [quotes, st] = await Promise.all([fetchQuotes(), pushedSafeTrade(db, t)]);
  const px = combine(quotes, prev && t - prev.ts <= PREV_MAX_AGE ? prev.usd : null, st);
  if (!px) {
    console.log("no price", JSON.stringify({ ...quotes, safetrade: st }));
    return;
  }
  const minute = t - (t % 60);
  // History up to the previous minute: this minute's row isn't a reference for any window.
  const change = await changes(db, px.usd, t, px.open24, px.src);
  const writes = [
    db.prepare("INSERT OR REPLACE INTO prices (ts, usd, src) VALUES (?, ?, ?)").bind(minute, px.usd, px.src),
    db.prepare("DELETE FROM prices WHERE ts < ?").bind(t - HISTORY_KEEP),
    // GET /v1/price serves this row as is: one read instead of four per request.
    db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('price', ?, ?)")
      .bind(JSON.stringify(priceReply(px.usd, minute, px.src, change)), t),
  ];
  // The exchanges' rolling 24h open, so GET /v1/price can show a 24h change
  // before the worker has a day of its own history.
  if (px.open24) writes.push(db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('open24', ?, ?)").bind(String(px.open24), t));
  await db.batch(writes);

  const dead = new Set();
  const alerts = await pushAlerts(env, db, t, px.usd, change, dead);
  // Each stage stands alone: a failure in one must never stop the others.
  let delivered = 0;
  if (apnsConfigured(env) || webpushConfigured(env)) {
    try { delivered = await pushDeferred(env, db, t, px.usd, dead); }
    catch (e) { console.error("deferred", e && e.stack ? e.stack : String(e)); }
  }
  try { await pushLive(env, db, t, px.usd, change); } catch (e) { console.error("live", e && e.stack ? e.stack : String(e)); }
  if (dead.size) await db.batch([...dead].flatMap((token) => forget(db, token)));
  if (minute % 3600 === 0) {
    try { await checkIdle(env, db, t); } catch (e) { console.error("idle", e && e.stack ? e.stack : String(e)); }
    try { await prune(db, t); } catch (e) { console.error("prune", e && e.stack ? e.stack : String(e)); }
  }
  console.log(`tick usd=${px.usd.toFixed(5)} src=${px.src} n=${px.n} rules=${alerts.rules} fired=${alerts.pushed} queued=${alerts.queued} delivered=${delivered} dead=${dead.size}`);
}

/// Evaluate every enabled rule; queue what fires in quiet hours, push the rest.
async function pushAlerts(env, db, t, usd, change, dead) {
  const { results: rules } = await db
    .prepare(
      `SELECT r.token, r.id, r.kind, r.value, r.window, r.enabled, r.armed, r.last_fired, r.repeating,
              d.chan, d.env, d.topic, d.lang, COALESCE(1 - r.repeating, d.oneshot) AS oneshot,
              d.win_start, d.win_end, d.tz, d.verified_at, d.retry_after
         FROM rules r JOIN devices d ON d.token = r.token
        WHERE r.enabled = 1`
    )
    .all();

  const ctx = { usd, now: t, change };
  const rearm = [];
  let fired = [];
  for (const r of rules) {
    const res = evaluate(r, ctx);
    if (res.fire) fired.push({ r, change: res.change });
    else if (!!res.armed !== !!r.armed) {
      // Only the rule as evaluated: not one a PUT has since replaced, nor one another tick fired.
      rearm.push(db.prepare("UPDATE rules SET armed = ? WHERE token = ? AND id = ? AND kind = ? AND value = ? AND window = ? AND armed = ? AND repeating IS ?")
        .bind(res.armed ? 1 : 0, r.token, r.id, r.kind, r.value, r.window, r.armed ? 1 : 0, r.repeating));
    }
  }
  fired = fired.filter(({ r }) => channelConfigured(env, r));

  // Quiet hours: queue the alert instead of pushing it. The rule counts as fired
  // now (disarmed, and switched off on one-shot devices) — only delivery waits.
  const quiet = [];
  const now_ = [];
  // At most one push per device per tick (the rest stay armed and go next
  // minute); a device APNs asked to back off waits; tokens APNs has never
  // accepted share a small budget — so fake registrations can't multiply into
  // APNs traffic, and a busy tick can't trip APNs' per-device limit.
  const busy = new Set();
  let unproven = 0;
  for (const f of fired) {
    const { r } = f;
    if (!windowOpen({ start: r.win_start, end: r.win_end, tz: r.tz }, t)) { quiet.push(f); continue; }
    if (busy.has(r.token) || r.retry_after > t) continue;
    if (!r.verified_at && ++unproven > UNVERIFIED_PER_TICK) continue;
    busy.add(r.token);
    now_.push(f);
  }

  // Commit the firings first. The claim matches the rule exactly as evaluated,
  // so it loses to a PUT that changed the rule and to a tick that already fired it.
  const claim = ({ r }) =>
    db.prepare(`UPDATE rules SET armed = 0, enabled = CASE WHEN ? THEN 0 ELSE enabled END, last_fired = ?
                 WHERE token = ? AND id = ? AND kind = ? AND value = ? AND window = ? AND enabled = 1 AND armed = 1 AND repeating IS ?`)
      .bind(r.oneshot ? 1 : 0, t, r.token, r.id, r.kind, r.value, r.window, r.repeating);
  const queue = ({ r, change: ch }) =>
    db.prepare(`INSERT OR REPLACE INTO deferred (token, rule_id, kind, value, window, change, fired_at)
                SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rules WHERE token = ? AND id = ? AND last_fired = ? AND armed = 0)`)
      .bind(r.token, r.id, r.kind, r.value, r.window, ch ?? null, t, r.token, r.id, t);
  const stmts = [...rearm, ...now_.map(claim), ...quiet.flatMap((f) => [claim(f), queue(f)])];
  const res = stmts.length ? await db.batch(stmts) : [];
  const mine = now_.filter((_, i) => changed(res[rearm.length + i]));

  const sent = await Promise.allSettled(mine.map(({ r, change: ch }) =>
    deliver(env, db, r, payloadFor(r.lang, r, usd, ch), { collapseId: r.id })));
  const writes = [];
  let pushed = 0;
  sent.forEach((s, i) => {
    const { r } = mine[i];
    const out = s.status === "fulfilled" ? s.value : { ok: false, retry: true, reason: String(s.reason) };
    if (out.ok) {
      pushed++;
      if (out.env !== r.env || !r.verified_at) {
        writes.push(db.prepare("UPDATE devices SET env = ?, verified_at = COALESCE(verified_at, ?) WHERE token = ?").bind(out.env, t, r.token));
      }
    } else if (out.drop) {
      dead.add(r.token);
    } else if (out.retry) {
      // Not delivered: undo this tick's claim (still ours if last_fired is this
      // tick's) so the rule fires again next tick.
      writes.push(db.prepare(`UPDATE rules SET armed = 1, enabled = CASE WHEN ? THEN 1 ELSE enabled END, last_fired = ?
                               WHERE token = ? AND id = ? AND last_fired = ? AND repeating IS ?`)
        .bind(r.oneshot ? 1 : 0, r.last_fired ?? null, r.token, r.id, t, r.repeating));
      if (out.backoff) writes.push(db.prepare("UPDATE devices SET retry_after = ? WHERE token = ?").bind(t + out.backoff, r.token));
      console.log("apns retry", r.token.slice(0, 8), out.status, out.reason);
    } else {
      console.error("apns refused", r.token.slice(0, 8), out.status, out.reason);
    }
  });
  if (writes.length) await db.batch(writes);
  return { rules: rules.length, pushed, queued: quiet.length };
}

/// Push every queued alert whose device is inside its window again — i.e. at
/// the first minute of the next window. Title = what fired, body = when + the
/// price now. Rows are removed before the push (one per device per tick) and
/// put back if APNs didn't take it for a transient reason; dropped unsent after
/// DEFERRED_KEEP.
async function pushDeferred(env, db, t, usd, dead) {
  const { results } = await db
    .prepare(`SELECT q.token, q.rule_id, q.kind, q.value, q.window, q.change, q.fired_at,
                     d.chan, d.env, d.topic, d.lang, d.win_start, d.win_end, d.tz, d.retry_after
                FROM deferred q JOIN devices d ON d.token = q.token`)
    .all();
  const busy = new Set();
  const due = results.filter((q) => {
    if (!channelConfigured(env, q) || q.fired_at < t - DEFERRED_KEEP || q.retry_after > t || busy.has(q.token)) return false;
    if (!windowOpen({ start: q.win_start, end: q.win_end, tz: q.tz }, t)) return false;
    busy.add(q.token);
    return true;
  });
  const res = await db.batch([
    db.prepare("DELETE FROM deferred WHERE fired_at < ?").bind(t - DEFERRED_KEEP),
    ...due.map((q) => db.prepare("DELETE FROM deferred WHERE token = ? AND rule_id = ? AND fired_at = ?").bind(q.token, q.rule_id, q.fired_at)),
  ]);
  const mine = due.filter((_, i) => changed(res[i + 1]));
  const sent = await Promise.allSettled(mine.map((q) => {
    const payload = deferredPayloadFor(q.lang, q, usd, localHM(q.fired_at, q.tz || "UTC"));
    return deliver(env, db, q, payload, { collapseId: q.rule_id });
  }));
  const writes = [];
  let n = 0;
  sent.forEach((s, i) => {
    const q = mine[i];
    const out = s.status === "fulfilled" ? s.value : { ok: false, retry: true, reason: String(s.reason) };
    if (out.ok) n++;
    else if (out.drop) dead.add(q.token);
    else if (out.retry) {
      writes.push(db.prepare(`INSERT OR IGNORE INTO deferred (token, rule_id, kind, value, window, change, fired_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(q.token, q.rule_id, q.kind, q.value, q.window, q.change, q.fired_at));
      if (out.backoff) writes.push(db.prepare("UPDATE devices SET retry_after = ? WHERE token = ?").bind(t + out.backoff, q.token));
      console.log("deferred retry", q.token.slice(0, 8), out.status, out.reason);
    } else console.error("deferred refused", q.token.slice(0, 8), out.status, out.reason);
  });
  if (writes.length) await db.batch(writes);
  return n;
}

/// 锁屏盯盘: push the new price to every running Live Activity — only when it
/// moved, or every LIVE_HEARTBEAT so the activity doesn't turn stale. The
/// heartbeat goes at low priority: nothing changed on screen, so it needn't
/// spend the activity's high-priority update budget.
async function pushLive(env, db, t, usd, change) {
  if (!apnsConfigured(env)) return;
  const { results } = await db
    .prepare("SELECT token, env, topic, last_usd, last_push FROM live WHERE started_at > ?")
    .bind(t - LIVE_PUSH_FOR)
    .all();
  const due = results.filter((r) => r.last_usd !== usd || !r.last_push || t - r.last_push >= LIVE_HEARTBEAT);
  const state = { usd, change1h: change[3600], change24h: change[86400], at: t };
  const payload = { aps: { timestamp: t, event: "update", "content-state": state, "stale-date": t + 15 * 60 } };
  const sent = await Promise.allSettled(due.map(async (r) =>
    await accountPushAllowed(db, r.token) ? send(env, db, { token: r.token, env: r.env, topic: r.topic }, payload,
         { pushType: "liveactivity", priority: r.last_usd === usd ? 5 : 10, ttl: 300 }) : { ok:false, drop:true, reason:"account device revoked" }));
  const writes = [db.prepare("DELETE FROM live WHERE started_at < ?").bind(t - LIVE_KEEP)];
  sent.forEach((s, i) => {
    const r = due[i];
    const out = s.status === "fulfilled" ? s.value : { ok: false, retry: true, reason: String(s.reason) };
    if (out.ok) writes.push(db.prepare("UPDATE live SET last_usd = ?, last_push = ?, env = ? WHERE token = ?").bind(usd, t, out.env, r.token));
    else if (out.drop) writes.push(db.prepare("DELETE FROM live WHERE token = ?").bind(r.token));
    else console.log("live retry", r.token.slice(0, 8), out.status, out.reason);
  });
  await db.batch(writes);
  if (results.length) console.log(`live n=${results.length} pushed=${due.length}`);
}

/// Hourly, before the prune: 掉线提醒 is for people who do NOT open the app, so "not
/// seen for 90 days" can't be what forgets them. A device with watches that hasn't
/// checked in for IDLE_CHECK gets a silent push instead: if APNs takes it the token
/// is alive and counts as seen; if APNs says the token is gone, so is the device.
async function checkIdle(env, db, t) {
  if (!apnsConfigured(env)) return;
  const { results } = await db
    .prepare(`SELECT d.token, d.env, d.topic FROM devices d
               WHERE d.chan = 'apns' AND COALESCE(d.seen_at, d.updated_at) < ? AND EXISTS (SELECT 1 FROM watches w WHERE w.token = d.token)
               ORDER BY COALESCE(d.seen_at, d.updated_at) LIMIT ?`)
    .bind(t - IDLE_CHECK, IDLE_CHECKS)
    .all();
  const sent = await Promise.allSettled(results.map((d) =>
    send(env, db, d, { aps: { "content-available": 1 } }, { pushType: "background", priority: 5, ttl: 60 })));
  const writes = [];
  sent.forEach((r, i) => {
    const out = r.status === "fulfilled" ? r.value : { ok: false, retry: true };
    if (out.ok) writes.push(db.prepare("UPDATE devices SET seen_at = ?, env = ? WHERE token = ?").bind(t, out.env, results[i].token));
    else if (out.drop) writes.push(...forget(db, results[i].token));
  });
  if (writes.length) await db.batch(writes);
  if (results.length) console.log(`idle checked=${results.length} alive=${sent.filter((r) => r.status === "fulfilled" && r.value.ok).length}`);
}

/// Hourly: forget devices the app hasn't checked in from for DEVICE_KEEP
/// (uninstalled, or a token nobody will ever use again), and old test-push throttles.
async function prune(db, t) {
  const gone = "SELECT token FROM devices WHERE COALESCE(seen_at, updated_at) < ?";
  await db.batch([
    db.prepare(`DELETE FROM rules WHERE token IN (${gone})`).bind(t - DEVICE_KEEP),
    db.prepare(`DELETE FROM deferred WHERE token IN (${gone})`).bind(t - DEVICE_KEEP),
    db.prepare(`DELETE FROM watches WHERE token IN (${gone})`).bind(t - DEVICE_KEEP),
    db.prepare(`DELETE FROM webpush WHERE token IN (${gone})`).bind(t - DEVICE_KEEP),
    db.prepare("DELETE FROM devices WHERE COALESCE(seen_at, updated_at) < ?").bind(t - DEVICE_KEEP),
    db.prepare("DELETE FROM kv WHERE k LIKE 'test:%' AND ts < ?").bind(t - 3600),
    db.prepare("DELETE FROM kv WHERE k LIKE 'rest:%' AND ts < ?").bind(t),
    db.prepare("DELETE FROM kv WHERE k LIKE 'sent:%' AND ts < ?").bind(t - SENT_KEEP),
    db.prepare(UNWATCHED),
  ]);
}

const forget = (db, token) => [
  db.prepare("DELETE FROM webpush WHERE token = ?").bind(token),
  db.prepare("DELETE FROM rules WHERE token = ?").bind(token),
  db.prepare("DELETE FROM devices WHERE token = ?").bind(token),
  db.prepare("DELETE FROM deferred WHERE token = ?").bind(token),
  db.prepare("DELETE FROM watches WHERE token = ?").bind(token),
  // …and the miners only it watched: their address and worker names go with it now,
  // not at the next hourly prune. (Forgetting a device is rare; the scan is fine here.)
  db.prepare(UNWATCHED),
];

/// Did this batch statement change a row? (D1 reports meta.changes per statement.)
const changed = (r) => !!(r && r.meta && r.meta.changes > 0);

const PUSH_ACTIVE = `EXISTS(SELECT 1 FROM sessions s
  JOIN users u ON u.id=s.user_id
  JOIN account_devices a ON a.user_id=s.user_id AND a.id=s.device_id
  JOIN account_push_claims p ON p.user_id=s.user_id AND p.device_id=s.device_id
  WHERE s.id=? AND p.token=? AND s.revoked_at IS NULL AND u.deleted_at IS NULL
    AND a.revoked_at IS NULL AND p.revoked_at IS NULL)`;
const pushActive = (session) => session?.client === "purchase" ? `EXISTS(SELECT 1 FROM purchase_visitors v
  JOIN account_push_claims p ON p.user_id=v.id AND p.device_id=v.device_id WHERE v.id=? AND p.token=?
  AND v.revoked_at IS NULL AND p.revoked_at IS NULL AND ${purchaseProSQL("v.id")})${session.sync_account ? ` AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    JOIN account_devices a ON a.user_id=s.user_id AND a.id=s.device_id WHERE s.id=?
    AND s.revoked_at IS NULL AND u.deleted_at IS NULL AND a.revoked_at IS NULL)` : ""}` : PUSH_ACTIVE;
const pushActiveArgs = (session, token) => [session.id, token, ...(session.client === "purchase" && session.sync_account ? [session.sync_account.id] : [])];

async function putLive(env, token, body, session = null) {
  if (session?.client === "purchase") return json({ error: "not pro" }, 403);
  if (!body || !topicsOf(env).includes(body.topic)) return json({ error: "bad topic" }, 400);
  if (body.env !== "production" && body.env !== "sandbox") return json({ error: "bad env" }, 400);
  const pro = await registrationPro(env, body.pro_jws, session);
  if (!pro) return json({ error: "not pro" }, 403);
  if (!session) await releasePush(env, token);
  if (session && !await claimPush(env, session, token, "live")) return json({ error: "device_conflict" }, 409);
  const t = now();
  // The activity's own start (1.17+), so a push token that rotates mid-activity
  // doesn't restart the 8 h clock; clamped to what could be true.
  const started = Number.isFinite(body.started_at) && body.started_at > t - LIVE_KEEP && body.started_at <= t + 300
    ? Math.floor(body.started_at) : t;
  // A token re-registered (app relaunch) keeps its start time: the 8 h limit is the activity's.
  const statement = env.DB.prepare(
    `INSERT INTO live (token, env, topic, started_at, original_transaction_id, account_pro) SELECT ?, ?, ?, ?, ?, ?
     WHERE ${session ? PUSH_ACTIVE : "1"}${pro.account ? " AND EXISTS(SELECT 1 FROM groups g JOIN sessions s ON s.user_id=g.gid WHERE s.id=? AND g.pro_at IS NOT NULL)" : ""}
     ON CONFLICT(token) DO UPDATE SET env = excluded.env, topic = excluded.topic,
                                      started_at = MIN(live.started_at, excluded.started_at),
                                      original_transaction_id = COALESCE(excluded.original_transaction_id, live.original_transaction_id),
                                      account_pro = excluded.account_pro`
  );
  const written = await statement.bind(token, body.env, body.topic, started, pro.otid ?? null, pro.account ? 1 : 0,
    ...(session ? [session.id, token] : []), ...(pro.account ? [session.id] : [])).run();
  if (session && !written.meta.changes) return json({ error: "unauthorized" }, 401);
  return json({ ok: true });
}

/// The last SafeTrade quote the push script delivered, if still fresh — by
/// SafeTrade's own timestamp, not when it reached us.
async function pushedSafeTrade(db, t) {
  const row = await db.prepare("SELECT v, ts FROM kv WHERE k = 'safetrade'").first();
  if (!row) return null;
  let q;
  try { q = JSON.parse(row.v); } catch { return null; }
  return q && t - (Number(q.at) || row.ts) <= ST_MAX_AGE ? q : null;
}

// ── Pro ──────────────────────────────────────────────────────────────────────

/// What a registration proves about Pro: { otid } for a valid signed Pro
/// transaction, {} when none was sent (apps before 1.17 — let in unless
/// REQUIRE_PRO = "1"), null when it's forged, revoked or not this app's Pro.
async function proFrom(env, jws) {
  if (jws == null) return env.REQUIRE_PRO === "1" ? null : {};
  if (typeof jws !== "string") return null;
  const p = await verifyAppleJWS(jws, { rootSHA256: env.APPLE_ROOT_SHA256 || undefined });
  if (!p) {
    // Xcode's local StoreKit testing signs with its own certificate. Counts as
    // not sent — which anyone can already do by leaving the field out.
    const raw = jwsPayload(jws);
    return raw && raw.environment === "Xcode" && env.REQUIRE_PRO !== "1" ? {} : null;
  }
  if (!topicsOf(env).includes(p.bundleId) || p.productId !== PRO || p.revocationDate) return null;
  if (!p.originalTransactionId) return null;
  const otid = String(p.originalTransactionId);
  if ((await env.DB.prepare("SELECT revoked_at FROM apple_purchases WHERE original_tx=?").bind(otid).first())?.revoked_at != null) return null;
  return { otid };
}

/// A native registration may use a verified account purchase, including PRL.
/// No client-provided flag participates in this decision.
async function registrationPro(env, jws, session) {
  if (session) {
    await syncPaid(env, session.user_id);
    if ((await env.DB.prepare("SELECT pro_at FROM groups WHERE gid=?").bind(session.user_id).first())?.pro_at != null)
      return { account: true };
    const apple = await proFrom(env, jws);
    // Legacy unsigned compatibility is for apps predating accounts, never for
    // authenticated account registrations.
    return apple?.otid ? apple : null;
  }
  return proFrom(env, jws);
}

// ── 掉线提醒 ─────────────────────────────────────────────────────────────────

/// Poll the miners that are due, fold each pool's answer into the miner's state
/// (watch.js), then tell every subscription the outages that have now lasted its
/// threshold — one push per monitor, naming the workers — and, in a push of their
/// own, the workers it was told about that are back and have stayed online. A miner
/// with a worker just back is polled again in a minute rather than in 3, to see
/// whether it stays.
///
/// A poll that fails says nothing: the miner keeps its state and is tried again in
/// 3 min, so a pool that is down or rate-limiting can never read as "offline".
/// Each pool has its own cap per tick (the backlog just takes longer to get round);
/// one that keeps failing is left alone for the rest of the tick, and one that
/// answers 429 for POOL_REST.
///
/// As with price alerts, delivery is at most once: what is about to be pushed is
/// committed as told first, and put back only if APNs didn't take the push for a
/// transient reason.
async function pollWatches(env) {
  const db = env.DB;
  const t = now();
  const started = Date.now();
  const dueBefore = t - POLL_EVERY + POLL_SLACK;
  const { results: backlog } = await db
    .prepare("SELECT pool, COUNT(*) AS n FROM miners WHERE tried_at IS NULL OR tried_at <= ? GROUP BY pool")
    .bind(dueBefore)
    .all();
  if (!backlog.length) return;
  const { results: rests } = await db.prepare("SELECT k FROM kv WHERE k LIKE 'rest:%' AND ts > ?").bind(t).all();
  const resting = new Set(rests.map((r) => r.k.slice(5)));
  // Each pool's oldest due miners, up to that pool's cap: a pool that is resting,
  // failing or simply large never takes another pool's turn.
  const perPool = await Promise.all(backlog
    .filter((b) => POOLS.includes(b.pool) && !resting.has(b.pool))
    .map((b) => db
      .prepare("SELECT pool, addr, workers, tried_at FROM miners WHERE pool = ? AND (tried_at IS NULL OR tried_at <= ?) ORDER BY tried_at LIMIT ?")
      .bind(b.pool, dueBefore, POLL_PER_POOL[b.pool] || POLL_PER_POOL.default)
      .all()));
  const queue = perPool.flatMap((r) => r.results)
    .sort((a, b) => (a.tried_at ?? 0) - (b.tried_at ?? 0))
    .slice(0, POLL_PER_TICK);
  const due = backlog.reduce((n, b) => n + b.n, 0);
  const fails = {};
  const limited = new Set();
  const polled = [];
  const runner = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      if (Date.now() - started > POLL_WALL_MS) return;
      if ((fails[m.pool] || 0) >= POOL_FAILS) continue;
      const res = await fetchMiner(m.pool, m.addr, t);
      if (!res.ok) fails[m.pool] = (fails[m.pool] || 0) + 1;
      // 429: the pool wants fewer requests — stop asking, and give it a rest.
      if (res.status === 429) { fails[m.pool] = POOL_FAILS; limited.add(m.pool); }
      polled.push({ m, res });
    }
  };
  await Promise.all(Array.from({ length: POLL_PARALLEL }, runner));

  let failed = 0, missing = 0;
  const writes = polled.map(({ m, res }) => {
    if (!res.ok) {
      failed++;
      return db.prepare("UPDATE miners SET tried_at = ? WHERE pool = ? AND addr = ?").bind(t, m.pool, m.addr);
    }
    if (res.missing) {
      missing++;
      return db.prepare("UPDATE miners SET tried_at = ?, missing = 1 WHERE pool = ? AND addr = ?").bind(t, m.pool, m.addr);
    }
    return db.prepare("UPDATE miners SET tried_at = ?, checked_at = ?, missing = 0, workers = ? WHERE pool = ? AND addr = ?")
      .bind(t, t, JSON.stringify(fold(unpack(m.workers), res.workers, t, res.partial)), m.pool, m.addr);
  });
  for (const pool of limited) writes.push(db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES (?, '', ?)").bind(`rest:${pool}`, t + POOL_REST));
  for (let i = 0; i < writes.length; i += BATCH) await db.batch(writes.slice(i, i + BATCH));
  for (const [pool, n] of Object.entries(fails)) {
    console.log(`watch pool=${pool} failed=${n}${limited.has(pool) ? " (429: resting)" : n >= POOL_FAILS ? " (left alone this tick)" : ""}`);
  }

  // Every subscription of a miner that answered just now.
  const { results: subs } = await db
    .prepare(
      `SELECT w.token, w.id, w.pool, w.addr, w.label, w.after, w.told, w.base, m.workers,
              d.chan, d.env, d.topic, d.lang, d.win_start, d.win_end, d.tz, d.retry_after, d.verified_at
         FROM watches w JOIN miners m ON m.pool = w.pool AND m.addr = w.addr
                        JOIN devices d ON d.token = w.token
        WHERE m.checked_at = ?`
    )
    .bind(t)
    .all();
  const jobs = [];
  const soon = new Map();
  const pushes = {};
  let unproven = 0;
  // Quiet hours, a device APNs asked to back off, or one that already gets its share
  // of pushes this tick (a site-wide outage hits every monitor at once, and APNs
  // throttles a burst to one device): the news stays untold, so it is pushed at the
  // first poll after — if it still holds then.
  const admit = (s) => {
    if (!channelConfigured(env, s) || s.retry_after > t || (pushes[s.token] || 0) >= PUSHES_PER_DEVICE) return false;
    if (!windowOpen({ start: s.win_start, end: s.win_end, tz: s.tz }, t)) return false;
    // As for price alerts: tokens APNs has never accepted share a small budget per tick.
    if (!s.verified_at && ++unproven > UNVERIFIED_PER_TICK) return false;
    pushes[s.token] = (pushes[s.token] || 0) + 1;
    return true;
  };
  const oldestFirst = (a, b) => a.since - b.since || (a.name < b.name ? -1 : 1);
  for (const s of subs) {
    const res = outages(unpack(s.workers), unpack(s.told), s.after, t, !s.base);
    if (res.wait) soon.set(`${s.pool}\n${s.addr}`, s);
    const down = res.push.length && admit(s) ? res.push.sort(oldestFirst) : [];
    const back = res.back.length && admit(s) ? res.back.sort(oldestFirst) : [];
    const claimed = pack(tell(res.told, down, back, t));
    if (claimed !== s.told || !s.base) jobs.push({ s, told: res.told, down, back, claimed });
  }
  // The claim matches the row exactly as read: it loses to a PUT that re-pointed
  // the watch and to another tick that already told it.
  const claims = jobs.map(({ s, claimed }) =>
    db.prepare("UPDATE watches SET told = ?, base = 1 WHERE token = ? AND id = ? AND pool = ? AND addr = ? AND told = ?")
      .bind(claimed, s.token, s.id, s.pool, s.addr, s.told));
  // A worker just back: its miner's turn comes round again in RECHECK, not POLL_EVERY.
  for (const m of soon.values()) {
    claims.push(db.prepare("UPDATE miners SET tried_at = ? WHERE pool = ? AND addr = ? AND tried_at = ?")
      .bind(t - POLL_EVERY + RECHECK, m.pool, m.addr, t));
  }
  const res = [];
  for (let i = 0; i < claims.length; i += BATCH) res.push(...await db.batch(claims.slice(i, i + BATCH)));
  const wanted = jobs.filter((j) => j.down.length + j.back.length);
  const mine = wanted.filter((j) => changed(res[jobs.indexOf(j)]));
  // One push per monitor for what went down, another for what came back.
  const mail = mine.flatMap((job) => [
    job.down.length ? { job, n: job.down.length, payload: offlinePayloadFor(job.s.lang, job.s, job.down, t) } : null,
    job.back.length ? { job, n: job.back.length, back: true, payload: onlinePayloadFor(job.s.lang, job.s, job.back) } : null,
  ].filter(Boolean));

  const sent = await Promise.allSettled(mail.map(({ job: { s }, payload }) =>
    deliver(env, db, s, payload, { ttl: OFFLINE_TTL })));
  const after = [];
  const dead = new Set();
  // What APNs made of each push, kept where it can be read back (kv 'sent:<t>'): "the
  // app says it was told, the phone never rang" needs an answer, and this worker's
  // logs can't always be tailed.
  const outcomes = [];
  let pushed = 0;
  sent.forEach((r, i) => {
    const { job, n, back } = mail[i];
    const { s } = job;
    const out = r.status === "fulfilled" ? r.value : { ok: false, retry: true, reason: String(r.reason) };
    outcomes.push({
      tok: s.token.slice(0, 8), watch: s.id.slice(0, 8), n, ...(back ? { back: true } : {}),
      ...(out.ok ? { ok: true, env: out.env }
                 : { ok: false, status: out.status ?? null, reason: out.reason ?? null,
                     verdict: out.drop ? "drop" : out.retry ? "retry" : "refused" }),
    });
    if (out.ok) {
      pushed++;
      if (out.env !== s.env || !s.verified_at) {
        after.push(db.prepare("UPDATE devices SET env = ?, verified_at = COALESCE(verified_at, ?) WHERE token = ?").bind(out.env, t, s.token));
      }
    } else if (out.drop) {
      dead.add(s.token);
    } else if (out.retry) {
      // Not delivered: this push's part of the claim is taken back below, for the next poll.
      (job.undone ||= {})[back ? "back" : "down"] = true;
      if (out.backoff) after.push(db.prepare("UPDATE devices SET retry_after = ? WHERE token = ?").bind(t + out.backoff, s.token));
      console.log("watch apns retry", s.token.slice(0, 8), out.status, out.reason);
    } else {
      console.error("watch apns refused", s.token.slice(0, 8), out.status, out.reason);
    }
  });
  // …if the claim is still ours: `told` as it stands with only what did go out.
  for (const { s, told, down, back, claimed, undone } of mine) {
    if (!undone) continue;
    after.push(db.prepare("UPDATE watches SET told = ? WHERE token = ? AND id = ? AND told = ?")
      .bind(pack(tell(told, undone.down ? [] : down, undone.back ? [] : back, t)), s.token, s.id, claimed));
  }
  for (const token of dead) after.push(...forget(db, token));
  // Claimed here but not ours to send: another tick's claim got there first.
  const lost = wanted.length - mine.length;
  if (outcomes.length || lost) {
    after.push(db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES (?, ?, ?)")
      .bind(`sent:${t}`, JSON.stringify({ pushes: outcomes.slice(0, 50), lost }), t));
  }
  for (let i = 0; i < after.length; i += BATCH) await db.batch(after.slice(i, i + BATCH));
  console.log(`watch due=${due} polled=${polled.length} failed=${failed} missing=${missing} subs=${subs.length} pushed=${pushed} dead=${dead.size} recheck=${soon.size}`);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/// The request body parsed as JSON, reading at most `max` bytes — a
/// Content-Length header can lie, or be missing on a chunked upload.
/// → [body] or [undefined, error response]
async function readJSON(req, max) {
  const chunks = [];
  let n = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        reader.cancel().catch(() => {});
        return [undefined, json({ error: "too large" }, 413)];
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  try { return [JSON.parse(new TextDecoder().decode(buf))]; } catch { return [undefined, json({ error: "bad json" }, 400)]; }
}

async function bearerOK(req, secret) {
  return secretOK((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), secret);
}

async function secretOK(got, secret) {
  if (!secret) return false;
  const enc = new TextEncoder();
  // Compare digests: equal length, and timingSafeEqual needs equal lengths.
  const [a, b] = await Promise.all([got, secret].map((x) => crypto.subtle.digest("SHA-256", enc.encode(x))));
  return crypto.subtle.timingSafeEqual(a, b);
}

async function ingestSafeTrade(req, env) {
  if (!(await bearerOK(req, env.INGEST_TOKEN))) return json({ error: "unauthorized" }, 401);
  const [body, bad] = await readJSON(req, MAX_INGEST_BODY);
  if (bad) return bad;
  const t = now();
  const q = parseSafeTrade(body, t);
  if (!q) return json({ error: "bad ticker" }, 400);
  await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES ('safetrade', ?, ?)").bind(JSON.stringify(q), t).run();
  return json({ ok: true, last: q.last });
}

/// App Store Server Notification (V2). With ASN_STRICT="1" only a notification Apple
/// signed gets past the signature check; either way only a verified refund /
/// revocation drops the devices registered with that purchase (a forged one must
/// not cut off a paying user).
async function appStoreNotification(req, env, secret) {
  if (!(await secretOK(secret, env.ASN_SECRET))) return json({ error: "not found" }, 404);
  const [body, bad] = await readJSON(req, MAX_ASN_BODY);
  if (bad) return bad;
  const signed = await verifyAppleJWS(body && body.signedPayload, { rootSHA256: env.APPLE_ROOT_SHA256 || undefined });
  if (signed) {
    console.log("asn: signature verified");
  } else if (env.ASN_STRICT === "1") {
    console.error("asn: signature check failed");
    return json({ error: "bad signature" }, 401);
  } else {
    console.error("asn: signature check FAILED — accepted unverified (ASN_STRICT off); a refund is not acted on");
  }
  const n = notificationFields(signed || jwsPayload(body && body.signedPayload));
  if (!n) return json({ error: "bad payload" }, 400);
  const topics = topicsOf(env);
  if (n.bundleId && !topics.includes(n.bundleId)) return json({ ok: true, ignored: "bundle" });
  const db = env.DB;
  if (signed && (n.type === "REFUND" || n.type === "REVOKE") && n.originalTx) {
    await revokeApple(env, n.originalTx);
  }
  return json({ ok: true });
}

function sanitizeSettings(body) {
  if (!Array.isArray(body.rules) || body.rules.length > MAX_RULES) return { bad: json({ error: "bad rules" }, 400) };
  const rules = body.rules.map(sanitizeRule);
  if (rules.some((r) => !r) || new Set(rules.map((r) => r.id)).size !== rules.length) {
    return { bad: json({ error: "bad rules" }, 400) };
  }
  // 1.20+: `watches`, the pool monitors this device wants offline pushes for. An app
  // that doesn't know them sends no such key, and whatever is stored then stays.
  let watches = null;
  if (body.watches !== undefined) {
    if (!Array.isArray(body.watches) || body.watches.length > MAX_WATCHES) return { bad: json({ error: "bad watches" }, 400) };
    watches = body.watches.map(sanitizeWatch);
    if (watches.some((x) => !x) || new Set(watches.map((x) => x.id)).size !== watches.length) {
      return { bad: json({ error: "bad watches" }, 400) };
    }
  }
  return { rules, watches };
}

async function putDevice(env, token, body, ip, web = null, session = null) {
  const db = env.DB;
  if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
  const topics = topicsOf(env);
  const topic = body.topic;
  let apnsEnv = body.env;
  const lang = LANGS.includes(body.lang) ? body.lang : "en";
  // Apps from 1.15 (116) on send oneshot: true — they show a fired alert as off
  // and send seen_fired, so the worker may switch fired alerts off for them.
  const oneshot = body.oneshot === true ? 1 : 0;
  // 1.16+: optional push window { start, end, tz }; absent = all day.
  const w = sanitizeWindow(body.window);
  if (!web && !topics.includes(topic)) return json({ error: "bad topic" }, 400);
  if (apnsEnv !== "production" && apnsEnv !== "sandbox") return json({ error: "bad env" }, 400);
  const settings = sanitizeSettings(body);
  if (settings.bad) return settings.bad;
  const { rules, watches } = settings;
  const empty = !web && !rules.length && !(watches && watches.length);
  // Validate and claim once, including an empty first sync after guest login.
  const pro = empty || web ? {} : await registrationPro(env, body.pro_jws, session);
  if (!pro || (!web && !empty && watches && watches.length && !pro.otid && !pro.account)) return json({ error: "not pro" }, 403);
  if (session) {
    if (!(session.client === "purchase" ? await claimPurchasePush(env, session, token) : await claimPush(env, session, token)))
      return json({ error: "device_conflict" }, 409);
  } else await releasePush(env, token);
  // Each write carries a bound guard evaluated inside the atomic batch. A
  // revocation or entitlement change during admission cannot resurrect rows.
  const active = session ? pushActive(session) + (pro.account ? " AND EXISTS(SELECT 1 FROM groups g JOIN sessions s ON s.user_id=g.gid WHERE s.id=? AND g.pro_at IS NOT NULL)" : "")
    : "NOT EXISTS(SELECT 1 FROM account_push_claims WHERE token=?)";
  const guardArgs = session ? [...pushActiveArgs(session, token), ...(pro.account ? [session.id] : [])] : [token];
  // What this token watched until now: the miners it stops watching are looked at
  // one by one afterwards, instead of scanning every miner on every registration
  // (an app with only price alerts has none, and costs nothing here).
  const before = watches
    ? (await db.prepare("SELECT DISTINCT pool, addr FROM watches WHERE token = ?").bind(token).all()).results
    : [];
  const kept = new Set((watches || []).map((x) => `${x.pool}\n${x.addr}`));
  const unwatch = before.filter((m) => !kept.has(`${m.pool}\n${m.addr}`)).map((m) =>
    db.prepare(`DELETE FROM miners WHERE pool = ? AND addr = ?
                   AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.pool = miners.pool AND w.addr = miners.addr)
                   AND ${active}`).bind(m.pool, m.addr, ...guardArgs));
  const dropWatches = watches ? [db.prepare(`DELETE FROM watches WHERE token = ? AND ${active}`).bind(token, ...guardArgs), ...unwatch] : [];

  if (empty) {
    // Nothing left to push for. (From an app that doesn't know watches, the device
    // itself stays while it still has some.)
    const written = await db.batch([
      // Even an already-empty token must verify that its session still owns it.
      ...(session ? [db.prepare(`UPDATE account_push_claims SET kind=kind WHERE token=? AND ${active}`).bind(token, ...guardArgs)] : []),
      db.prepare(`DELETE FROM rules WHERE token = ? AND ${active}`).bind(token, ...guardArgs),
      db.prepare(`DELETE FROM deferred WHERE token = ? AND ${active}`).bind(token, ...guardArgs),
      ...dropWatches,
      db.prepare(`DELETE FROM devices WHERE token = ? AND NOT EXISTS (SELECT 1 FROM watches WHERE token = ?) AND ${active}`).bind(token, token, ...guardArgs),
    ]);
    if (session && !written[0].meta.changes) return json({ error: "unauthorized" }, 401);
    return json({ ok: true, rules: [], ...(watches ? { watches: [] } : {}) });
  }
  const t = now();
  const admitted = web ? { verified: t, env: "production" } : await admitToken(env, db, token, apnsEnv, topic, ip, t);
  if (admitted.bad) return admitted.bad;
  const verified = admitted.verified;
  apnsEnv = admitted.env;

  // One atomic batch; every merge reads the rows as they are at write time
  // (UPSERT_RULE), so a tick firing a rule meanwhile can't be undone by this PUT.
  const ids = rules.map((r) => r.id);
  const notIn = (list) => (list.length ? ` AND id NOT IN (${list.map(() => "?").join(",")})` : "");
  const stmts = [
    db.prepare(
      `INSERT INTO devices (token, env, topic, lang, oneshot, win_start, win_end, tz, updated_at,
                            original_transaction_id, verified_at, seen_at, chan, gid, account_pro)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${active}
       ON CONFLICT(token) DO UPDATE SET env = excluded.env, topic = excluded.topic, lang = excluded.lang,
                                         oneshot = excluded.oneshot, win_start = excluded.win_start,
                                         win_end = excluded.win_end, tz = excluded.tz,
                                         updated_at = excluded.updated_at, seen_at = excluded.seen_at,
                                         original_transaction_id = COALESCE(excluded.original_transaction_id, devices.original_transaction_id),
                                         account_pro = excluded.account_pro,
                                         verified_at = COALESCE(devices.verified_at, excluded.verified_at)`
    ).bind(token, apnsEnv, topic, lang, oneshot, w ? w.start : null, w ? w.end : null, w ? w.tz : null, t,
           pro.otid ?? null, verified, t, web ? "webpush" : "apns", web?.gid ?? null, pro.account ? 1 : 0, ...guardArgs),
    db.prepare(`DELETE FROM rules WHERE token = ?${notIn(ids)} AND ${active}`).bind(token, ...ids, ...guardArgs),
    ...rules.map((r) => db.prepare(upsertRule(active)).bind(token, r.id, r.kind, r.value, r.window, r.enabled, oneshot, r.seen_fired, r.repeating, ...guardArgs)),
    // A queued alert survives only while its rule is still there, unchanged.
    db.prepare(`DELETE FROM deferred WHERE token = ? AND NOT EXISTS (
                  SELECT 1 FROM rules r WHERE r.token = deferred.token AND r.id = deferred.rule_id
                     AND r.kind = deferred.kind AND r.value = deferred.value AND r.window = deferred.window) AND ${active}`).bind(token, ...guardArgs),
  ];
  if (watches) {
    const wids = watches.map((x) => x.id);
    stmts.push(
      db.prepare(`DELETE FROM watches WHERE token = ?${notIn(wids)} AND ${active}`).bind(token, ...wids, ...guardArgs),
      ...watches.map((x) => db.prepare(upsertWatch(active)).bind(token, x.id, x.pool, x.addr, x.label, x.after, ...guardArgs)),
      // A miner someone newly watches is due at once (tried_at NULL)…
      ...watches.map((x) => db.prepare(`INSERT OR IGNORE INTO miners (pool, addr) SELECT ?, ? WHERE ${active}`).bind(x.pool, x.addr, ...guardArgs)),
      // …and one this PUT stopped watching is no longer polled: a device can keep at
      // most MAX_WATCHES miners in the queue, however often it rewrites its list.
      ...unwatch,
    );
  }
  if (session) stmts.push(db.prepare(`UPDATE devices SET gid=?, account_device_id=? WHERE token=? AND ${active}`).bind(session.user_id, session.device_id, token, ...guardArgs));
  const written = await db.batch(stmts);
  if (!written[0].meta.changes) return json({ error: "unauthorized" }, 401);
  return getDevice(env, token);
}

/// Subscription storage claims the device slot atomically, before sharing APNs settings writes.
async function putWebPush(env, gid, body, ip, session, account = null) {
  const db = env.DB, t = now();
  const g = await db.prepare("SELECT pro_at FROM groups WHERE gid = ?").bind(gid).first();
  if (g?.pro_at == null) return json({ error: "not_pro" }, 403);
  if (!webpushConfigured(env)) return json({ error: "push_off" }, 503);
  if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
  const settings = sanitizeSettings(body);
  if (settings.bad) return settings.bad;
  const sub = await validateSubscription(body.subscription);
  if (!sub) return json({ error: "bad subscription" }, 400);
  const token = await sha256(sub.endpoint);
  if (!session || !(session.client === "purchase" ? await claimPurchasePush(env,session,token,account) : await claimPush(env,session,token))) return json({ error: "device_conflict" }, 409);
  const old = await db.prepare("SELECT gid, chan FROM devices WHERE token = ?").bind(token).first();
  if (old && (old.gid !== gid || old.chan !== "webpush")) return json({ error: "device conflict" }, 409);
  const scope = account?.user_id || gid;
  const slot = await db.prepare(`INSERT INTO devices (token, env, topic, updated_at, chan, gid, verified_at, seen_at, sync_gid, sync_device_id)
    SELECT ?, 'production', 'web', ?, 'webpush', ?, ?, ?, ?, ? WHERE
      ((SELECT COUNT(*) FROM account_push_claims p LEFT JOIN devices d ON d.token=p.token
        WHERE COALESCE(d.sync_gid,p.user_id)=? AND p.token<>? AND p.kind='notification' AND p.revoked_at IS NULL) < 10 OR
       EXISTS (SELECT 1 FROM devices WHERE token = ? AND COALESCE(sync_gid,gid) = ? AND chan = 'webpush')) AND ${pushActive(session)}
    ON CONFLICT(token) DO UPDATE SET seen_at = excluded.seen_at, sync_gid=excluded.sync_gid, sync_device_id=excluded.sync_device_id WHERE devices.gid = excluded.gid
    RETURNING token`).bind(token, t, gid, t, t, account?.user_id||null, account?.device_id||null, scope, token, token, scope, ...pushActiveArgs(session, token)).first();
  if (!slot) return json({ error: "too_many_devices" }, 409);
  await db.prepare(`INSERT INTO webpush (token, endpoint, p256dh, auth) SELECT ?, ?, ?, ? WHERE ${pushActive(session)}
    ON CONFLICT(token) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth`)
    .bind(token, sub.endpoint, sub.p256dh, sub.auth, ...pushActiveArgs(session, token)).run();
  const r = await putDevice(env, token, { ...body, topic: "web", env: "production", oneshot: true }, ip, { gid }, session);
  if (r.ok) await db.prepare(`UPDATE devices SET sync_gid=?,sync_device_id=? WHERE token=? AND ${pushActive(session)}`)
    .bind(account?.user_id||null,account?.device_id||null,token,...pushActiveArgs(session, token)).run();
  const result = await r.json();
  return json({ ...result, token }, r.status);
}

/// Miners nobody watches any more.
const UNWATCHED = "DELETE FROM miners WHERE NOT EXISTS (SELECT 1 FROM watches w WHERE w.pool = miners.pool AND w.addr = miners.addr)";

/// A token new to us: a tighter rate limit, and APNs must recognize it (a silent
/// push) before it may hold rules or watches — a made-up token is refused here.
/// → { bad: Response } | { verified: unix s | null, env: the APNs environment that took it }
async function admitToken(env, db, token, apnsEnv, topic, ip, t) {
  if (await db.prepare("SELECT 1 FROM devices WHERE token = ?").bind(token).first()) return { verified: null, env: apnsEnv };
  if (env.RL_NEW) {
    const { success } = await env.RL_NEW.limit({ key: ip });
    if (!success) return { bad: json({ error: "rate limited" }, 429) };
  }
  if (apnsConfigured(env)) {
    const res = await send(env, db, { token, env: apnsEnv, topic }, { aps: { "content-available": 1 } },
                           { pushType: "background", priority: 5, ttl: 60 });
    if (res.drop) return { bad: json({ error: "bad token" }, 400) };
    if (res.ok) return { verified: t, env: res.env };
  }
  return { verified: null, env: apnsEnv };
}

/// The device's record as registered. Rules: `deferred` = fired in quiet hours, push
/// still queued for the next window start. Watches: `checked_at` = when the pool last
/// answered for that miner; `missing` = the pool says it has no such miner (a mistyped
/// address, a revoked F2Pool link); `stale` = the pool hasn't answered for a while
/// (down, or refusing us), so nothing can be noticed until it does. A watch's address
/// is not echoed back.
async function getDevice(env, token) {
  const t = now();
  const [{ results: rules }, { results: watches }] = await Promise.all([
    env.DB
      .prepare(`SELECT id, kind, value, window, enabled, armed, last_fired,
                       COALESCE(repeating, (SELECT 1 - oneshot FROM devices d WHERE d.token = r.token)) AS repeat,
                       EXISTS (SELECT 1 FROM deferred q WHERE q.token = r.token AND q.rule_id = r.id) AS deferred
                  FROM rules r WHERE token = ? ORDER BY rowid`)
      .bind(token)
      .all(),
    env.DB
      .prepare(`SELECT w.id, w.pool, w.after, m.checked_at, m.tried_at, m.missing
                  FROM watches w LEFT JOIN miners m ON m.pool = w.pool AND m.addr = w.addr
                 WHERE w.token = ? ORDER BY w.rowid`)
      .bind(token)
      .all(),
  ]);
  return json({
    ok: true,
    rules: rules.map((r) => ({ ...r, enabled: !!r.enabled, armed: !!r.armed, deferred: !!r.deferred, repeat: !!r.repeat })),
    watches: watches.map((r) => ({
      id: r.id, pool: r.pool, after: r.after, checked_at: r.checked_at ?? null, missing: !!r.missing,
      // Never answered counts once it has been tried; a miner not polled yet is just new.
      stale: !r.missing && (r.checked_at == null ? r.tried_at != null : t - r.checked_at > WATCH_STALE),
    })),
  });
}

/// The app reads its rules back on every foreground: that doubles as the
/// check-in that keeps an installed device from being pruned (written hourly at most).
async function seen(env, token) {
  const t = now();
  await env.DB.prepare("UPDATE devices SET seen_at = ? WHERE token = ? AND (seen_at IS NULL OR seen_at < ?)")
    .bind(t, token, t - SEEN_EVERY).run();
}

async function testPush(env, token) {
  const db = env.DB;
  const d = await db.prepare("SELECT token, chan, env, topic, lang FROM devices WHERE token = ?").bind(token).first();
  if (!d) return json({ error: "unknown device" }, 404);
  if (!channelConfigured(env, d)) return json({ error: d.chan === "webpush" ? "webpush not configured" : "apns not configured" }, 503);
  const t = now();
  const last = await db.prepare("SELECT ts FROM kv WHERE k = ?").bind(`test:${token}`).first();
  if (last && t - last.ts < 60) return json({ error: "too many" }, 429);
  await db.prepare("INSERT OR REPLACE INTO kv (k, v, ts) VALUES (?, '', ?)").bind(`test:${token}`, t).run();
  const p = await lastPrice(db);
  const res = await deliver(env, db, d, payloadFor(d.lang, null, p ? p.usd : 0));
  if (res.ok && res.env !== d.env) await db.prepare("UPDATE devices SET env = ? WHERE token = ?").bind(res.env, token).run();
  if (res.drop && d.chan === "webpush") await db.batch(forget(db, token));
  return json(res, res.ok ? 200 : 502);
}

async function getPrice(env, req, ctx) {
  // Preserve the native price key, 15 s edge TTL and client no-store headers.
  return cached(req, 15, ctx, async () => {
    const db = env.DB;
    let o = null;
    const row = await db.prepare("SELECT v FROM kv WHERE k = 'price'").first();
    try { o = row ? JSON.parse(row.v) : null; } catch { o = null; }
    if (!o) {
      // Before the first tick of this version wrote the reply: build it.
      const p = await lastPrice(db);
      if (!p) return json({ error: "no price yet" }, 503);
      const open = await db.prepare("SELECT v FROM kv WHERE k = 'open24'").first();
      o = priceReply(p.usd, p.ts, p.src, await changes(db, p.usd, p.ts, open ? Number(open.v) : null, p.src));
    }
    // stale: no tick has priced PRL for a while (every source down) — the number is old.
    return { ...o, stale: now() - o.ts > PRICE_STALE };
  });
}

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") return env.ASSETS ? env.ASSETS.fetch(req) : json({ error: "not found" }, 404);
  const ip = req.headers.get("cf-connecting-ip") || "?";

  const path = url.pathname;
  if (path === "/v1/web/status" && req.method === "GET") return Response.json({ pay: paymentSettings(env), vapid_key: webpushConfigured(env) ? env.VAPID_PUBLIC : null,
    auth: { enabled: accountsEnabled(env), site_key: env.TURNSTILE_SITE_KEY || null } }, { headers: { "cache-control": "no-store" } });
  if (path === "/v1/gpus" && req.method === "GET") return json(gpuCatalog, 200, { "cache-control": "public, max-age=3600" });
  const authReply = await authRoutes(req, env);
  if (authReply) return authReply;
  const purchaseReply = await purchaseRoutes(req,env);
  if (purchaseReply) return purchaseReply;
  const accountReply = await accountRoutes(req, env);
  if (accountReply) return accountReply;
  if ((["/v1/price/history", "/v1/pools", "/v1/pool-fees", "/v1/fx", "/v1/network/history"].includes(path) && req.method === "GET") || (["/v1/pool/stats", "/v1/address", "/v1/address/income"].includes(path) && req.method === "POST")) {
    if (env.RL_READ && !(await env.RL_READ.limit({ key: ip })).success) return json({ ok: false, error: "rate limited" }, 429);
    if (path === "/v1/fx") return fx(env);
    if (path === "/v1/price/history") return url.searchParams.has("span") ? longPriceHistory(env, url.searchParams.get("span")) : priceHistory(env, ctx);
    if (path === "/v1/network/history") return networkHistory(env, url.searchParams.get("span") || "7d");
    if (path === "/v1/pools") return overview(env, ctx);
    if (path === "/v1/pool-fees") return realFees(env);
    const [body, bad] = await readJSON(req, MAX_DEVICE_BODY);
    return bad || (path === "/v1/address/income" ? income(env, body, ctx) : path === "/v1/address" ? address(env, body, ctx) : poolStats(env, body, ctx, ip));
  }
  if (parts[1] === "admin") {
    if (!env.ADMIN_TOKEN || !(await bearerOK(req, env.ADMIN_TOKEN))) return json({ error: "not found" }, 404);
    const [body, bad] = req.method === "POST" ? await readJSON(req, MAX_DEVICE_BODY) : [null];
    return bad || admin(env, req.method, parts.length === 3 ? parts[2] : "", body);
  }
  if (parts[1] === "me" || parts[1] === "orders" || path === "/v1/web/push") {
    const contexts = await buyerContexts(req,env);
    let session=contexts.account||contexts.purchase, gid=session?.user_id;
    if (!gid) return json({ error: "unauthorized" }, 401);
    if (contexts.account) await syncPaid(env,contexts.account.user_id);
    if (path === "/v1/me" && req.method === "GET") return buyerMe(env,contexts);
    if (path === "/v1/me/apple" && req.method === "POST") {
      if (!contexts.account) return json({error:"unauthorized"},401);
      if (env.RL_NEW && !(await env.RL_NEW.limit({ key: ip })).success) return json({ error: "rate limited" }, 429);
      const [body, bad] = await readJSON(req, MAX_DEVICE_BODY);
      return bad || bindApple(env, gid, body, session);
    }
    if (path === "/v1/orders" && req.method === "POST") {
      const effective=await (await buyerMe(env,contexts)).json();
      if(effective.pro) return json({error:"already_pro"},409);
      return createOrder(env,contexts.purchase?.user_id||gid,ip);
    }
    if (parts[1] === "orders" && parts.length === 3 && req.method === "GET") {
      const owned=await env.DB.prepare("SELECT gid FROM orders WHERE id=? AND gid IN (?,?)").bind(parts[2],contexts.account?.user_id||"",contexts.purchase?.user_id||"").first();
      return owned?getOrder(env,owned.gid,parts[2]):json({error:"not found"},404);
    }
    if (path === "/v1/me/config" && ["GET", "PUT"].includes(req.method)) {
      if(!contexts.account) return json({error:"unauthorized"},401);
      if (req.method === "GET") return accountConfig(env, gid);
      if (env.RL && !(await env.RL.limit({ key: ip })).success) return json({ error: "rate limited" }, 429);
      const [body, bad] = await readJSON(req, 70000);
      return bad || saveAccountConfig(env, gid, body, session);
    }
    if (path === "/v1/web/push" && req.method === "PUT") {
      if(contexts.purchase) {
        if(contexts.account) await associatePurchase(env,contexts.account,contexts.purchase);
        await refreshPurchase(env,contexts.purchase);
        session={...contexts.purchase,sync_account:contexts.account};gid=session.user_id;
      }
      if (env.RL && !(await env.RL.limit({ key: ip })).success) return json({ error: "rate limited" }, 429);
      const [body, bad] = await readJSON(req, MAX_DEVICE_BODY);
      return bad || putWebPush(env, gid, body, ip, session, contexts.account);
    }
  }

  if (parts[1] === "price" && parts.length === 2 && req.method === "GET") return getPrice(env, req, ctx);
  if (parts[1] === "ingest" && parts[2] === "safetrade" && parts.length === 3 && req.method === "POST") {
    return ingestSafeTrade(req, env);
  }
  if (parts[1] === "asn" && parts.length === 3 && req.method === "POST") return appStoreNotification(req, env, parts[2]);

  if (parts[1] === "live" && parts.length === 3) {
    const token = parts[2].toLowerCase();
    if (!LIVE_TOKEN_RE.test(token)) return json({ error: "bad token" }, 400);
    const owner = await pushOwner(req, env, token);
    if (!owner) return json({ error: "unauthorized" }, 401);
    if (env.RL) {
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "rate limited" }, 429);
    }
    if (req.method === "PUT") {
      const [body, bad] = await readJSON(req, MAX_LIVE_BODY);
      if (bad) return bad;
      const session = owner.session || await authenticate(req, env);
      return putLive(env, token, body, session);
    }
    if (req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM live WHERE token = ?").bind(token).run();
      return json({ ok: true });
    }
  }

  if (parts[1] === "devices" && parts.length >= 3) {
    const token = parts[2].toLowerCase();
    if (!TOKEN_RE.test(token)) return json({ error: "bad token" }, 400);
    const owner = await pushOwner(req, env, token);
    if (!owner) return json({ error: "unauthorized" }, 401);
    if (req.method !== "GET" && env.RL) {
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "rate limited" }, 429);
    }
    if (parts.length === 3) {
      if (req.method === "PUT") {
        const [body, bad] = await readJSON(req, MAX_DEVICE_BODY);
        if ((await env.DB.prepare("SELECT chan FROM devices WHERE token = ?").bind(token).first())?.chan === "webpush") return json({ error: "web device" }, 409);
        if (bad) return bad;
        const session = owner.session || await authenticate(req, env);
        const reply = await putDevice(env, token, body, ip, null, session);
        return reply;
      }
      if (req.method === "GET") {
        await seen(env, token);
        return getDevice(env, token);
      }
      if (req.method === "DELETE") {
        await env.DB.batch(forget(env.DB, token));
        return json({ ok: true });
      }
    }
    if (parts.length === 4 && parts[3] === "test" && req.method === "POST") return testPush(env, token);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      logError("request failed", e, env, req);
      return json({ error: "internal" }, 500);
    }
  },
  async scheduled(_event, env) {
    try {
      await tick(env);
    } finally {
      // 掉线提醒 runs after the price work and whatever became of it: a tick with
      // no price, or one that threw, still checks the pools.
      try { await pollWatches(env); } catch (e) { console.error("watch", e && e.stack ? e.stack : String(e)); }
      try { await checkPayments(env); } catch (e) { logError("payment check failed", e, env); }
      try { await sampleNetwork(env); } catch (e) { logError("network sampling failed", e, env); }
      try { await refreshRealFees(env); } catch { console.error("real-fee refresh unavailable"); }
      // Public PPLNS windows grow continuously even when no client opens the pool page.
      if (Math.floor(now() / 60) % 5 === 0) {
        try { await overview(env, { waitUntil(p) { p.catch(() => {}); } }); }
        catch { console.warn("public PPLNS overview unavailable"); }
      }
      // Web housekeeping also runs when every price source is down.
      const t = now();
      try { await pruneEmptyGroups(env.DB, t).run(); }
      catch (e) { logError("empty group prune failed", e, env); }
      if (Math.floor(t / 60) % 60 === 0) {
        try { await env.DB.batch([
          env.DB.prepare("DELETE FROM orders WHERE status = 'pending' AND created_at < ?").bind(t - 30 * 86400),
          env.DB.prepare("DELETE FROM kv WHERE k LIKE 'pb:%' AND ts < ?").bind(t - 3600),
          pruneGroups(env.DB, t),
          prunePurchases(env.DB,t),
          ...authCleanup(env.DB, t),
        ]); } catch (e) { logError("web prune failed", e, env); }
      }
    }
  },
};
