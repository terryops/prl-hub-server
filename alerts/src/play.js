// Google Play one-time purchase of Pro, for the Play build of the Android app (prl-hub-android
// Billing.kt). iOS buys through the App Store (entitlements.js bindApple); the website and the
// website APK pay in PRL (orders.js).
//
// The app sends the purchase token Play gave it to POST /v1/purchase/google. The Worker:
//   1. Asks the Google Play Developer API about the token.
//   2. Acknowledges the purchase. Play refunds one that is not acknowledged within three days.
//   3. Grants Pro the way a PRL order does:
//      - Signed-in account: an `entitlements` row ('google', ref) for the account.
//      - Not signed in: a `purchase_licenses` row for the device's purchase credential. The
//        entitlement is then owned by the credential; associatePurchase moves it to the account
//        when the person signs in.
//
// A purchase token belongs to the Google account that bought it, so presenting it again from a new
// install (restore) licenses that device too. A token already bound to another Pearl Hub account
// answers 409, as an App Store receipt does.
//
// Refunds and chargebacks: hourly, the Voided Purchases API → revokeGoogle.
//
// PLAY_SERVICE_ACCOUNT: a Google service-account key (JSON), added in Play Console → Users and
// permissions with "View app information", "View financial data" and "Manage orders and
// subscriptions". Without it the route answers 503 play_off and /v1/web/status says play: false.
// PLAY_TEST_OK = "1" also accepts license testers' test purchases (purchaseType 0).

import { now, sha256, webJson as json } from "./http.js";
import { recalculate, syncPaid } from "./entitlements.js";
import { refreshPurchase, buyerMe } from "./purchases.js";
import { googleToken, resetTokenCache } from "./fcm.js";

export const PLAY_PRODUCT = "com.prl.wizard.pro";
const PACKAGE = "com.prl.wizard";
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const PLAY_TIMEOUT_MS = 10000;
/// Play refunds a purchase nobody acknowledged in three days; retries stop after that.
const ACK_WINDOW = 3 * 86400;
/// The Voided Purchases API reaches back 30 days at most.
const VOIDED_REACH = 30 * 86400;
const PURCHASE_TOKEN = /^[A-Za-z0-9._:-]{20,4096}$/;

let playParsed = null; // { raw, sa }

function playAccount(env) {
  const raw = env.PLAY_SERVICE_ACCOUNT;
  if (typeof raw !== "string") return null;
  if (playParsed?.raw !== raw) {
    let sa = null;
    try { sa = JSON.parse(raw); } catch { /* not JSON */ }
    const ok = sa && ["client_email", "private_key"].every((k) => typeof sa[k] === "string" && sa[k]);
    playParsed = { raw, sa: ok ? sa : null };
  }
  return playParsed.sa;
}

export const playConfigured = (env) => !!playAccount(env);

/// Tests: forget the cached access token.
export function resetPlayToken() {
  resetTokenCache(SCOPE);
  playParsed = null;
}

/// Signed in as the service account, through fcm.js's googleToken (the same JWT-bearer grant
/// FCM uses, its own scope and cache entry). Throws when Google won't give a token.
async function playToken(env) {
  const sa = playAccount(env);
  if (!sa) return null;
  const got = await googleToken(env.PLAY_SERVICE_ACCOUNT, sa, SCOPE);
  if (!got.token) throw new Error(`play auth ${got.status ?? got.reason}`);
  return got.token;
}

/// One Play Developer API call → { status, body }. Throws on a network failure or a refused key.
async function play(env, path, init = {}) {
  const token = await playToken(env);
  const r = await fetch(API + path, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(PLAY_TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* empty (acknowledge answers 204 / {}) */ }
  return { status: r.status, body };
}

const tokenPath = (token) => `/purchases/products/${PLAY_PRODUCT}/tokens/${encodeURIComponent(token)}`;

async function acknowledge(env, ref, token) {
  try {
    const r = await play(env, `${tokenPath(token)}:acknowledge`, { method: "POST", body: "{}" });
    // 400 "already acknowledged" also means done.
    const done = r.status >= 200 && r.status < 300 || r.status === 400 && /acknowledg/i.test(JSON.stringify(r.body || ""));
    if (done) await env.DB.prepare("UPDATE google_purchases SET acknowledged_at=? WHERE ref=? AND acknowledged_at IS NULL").bind(now(), ref).run();
    else console.warn("play acknowledge", r.status, ref.slice(0, 8));
    return done;
  } catch (e) {
    console.warn("play acknowledge failed", ref.slice(0, 8), String(e?.message || e));
    return false;
  }
}

/// Asks Play about a token not seen before (or not yet acknowledged) and records it.
/// → { ok: true } | { pending: true } | { error, status }
async function verify(env, ref, token) {
  let r;
  try { r = await play(env, tokenPath(token)); }
  catch (e) {
    console.error("play verify unavailable", String(e?.message || e));
    return { error: "play_unavailable", status: 503 };
  }
  if (r.status === 404 || r.status === 400 || r.status === 410) return { error: "bad_receipt", status: 400 };
  if (r.status === 401 || r.status === 403) {
    // The service account lacks the Play Console permissions: an owner's fix, not the buyer's.
    console.error("play verify refused", r.status, JSON.stringify(r.body?.error?.message || "").slice(0, 200));
    return { error: "play_unavailable", status: 503 };
  }
  if (r.status !== 200 || !r.body) return { error: "play_unavailable", status: 503 };
  const p = r.body;
  if (p.purchaseState === 2) return { pending: true };
  if (p.purchaseState !== 0) return { error: "bad_receipt", status: 400 };
  const test = p.purchaseType === 0;
  if (test && env.PLAY_TEST_OK !== "1") return { error: "bad_receipt", status: 400 };
  const t = now();
  const bought = Math.floor(Number(p.purchaseTimeMillis) / 1000) || t;
  await env.DB.prepare(`INSERT INTO google_purchases(ref,token,order_id,product,purchased_at,test,created_at,acknowledged_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO NOTHING`)
    .bind(ref, token, typeof p.orderId === "string" ? p.orderId.slice(0, 64) : null, PLAY_PRODUCT, bought, test ? 1 : 0, t,
      p.acknowledgementState === 1 ? t : null).run();
  if (p.acknowledgementState !== 1) await acknowledge(env, ref, token);
  return { ok: true };
}


/// POST /v1/purchase/google { product_id, purchase_token } with an account session, the device's
/// purchase credential, or both.
export async function playPurchase(env, contexts, body) {
  if (!playConfigured(env)) return json({ error: "play_off" }, 503);
  const token = body?.purchase_token;
  if (body?.product_id !== PLAY_PRODUCT || typeof token !== "string" || !PURCHASE_TOKEN.test(token)) return json({ error: "bad_receipt" }, 400);
  const { account, purchase } = contexts;
  if (!account && !purchase) return json({ error: "unauthorized" }, 401);
  const db = env.DB, ref = await sha256(`play:${token}`);
  let row = await db.prepare("SELECT revoked_at FROM google_purchases WHERE ref=?").bind(ref).first();
  if (!row) {
    const v = await verify(env, ref, token);
    if (v.pending) return json({ pending: true }, 202);
    if (v.error) return json({ error: v.error }, v.status);
    row = await db.prepare("SELECT revoked_at FROM google_purchases WHERE ref=?").bind(ref).first();
  } else if (!row.revoked_at) {
    const unacked = await db.prepare("SELECT 1 FROM google_purchases WHERE ref=? AND acknowledged_at IS NULL").bind(ref).first();
    if (unacked) await acknowledge(env, ref, token);
  }
  if (!row || row.revoked_at) return json({ error: "bad_receipt" }, 400);
  const t = now(), owner = await db.prepare("SELECT user_id, revoked_at FROM entitlements WHERE source='google' AND ref=?").bind(ref).first();
  if (owner?.revoked_at) return json({ error: "bad_receipt" }, 400);
  if (account) {
    const uid = account.user_id;
    if (owner && owner.user_id !== uid && !owner.user_id.startsWith("g_")) return json({ error: "purchase_already_linked" }, 409);
    await db.batch([
      // A purchase first made on this device without an account becomes the account's.
      db.prepare("UPDATE entitlements SET user_id=? WHERE source='google' AND ref=? AND user_id LIKE 'g\\_%' ESCAPE '\\'").bind(uid, ref),
      db.prepare(`INSERT OR IGNORE INTO entitlements(source, ref, user_id, product, platform, granted_at)
        SELECT 'google', ?, ?, 'pro', 'web', ? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)`).bind(ref, uid, t, uid),
      recalculate(db, uid),
    ]);
    await syncPaid(env, uid);
  }
  if (purchase) {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO entitlements(source, ref, user_id, product, platform, granted_at)
        SELECT 'google', ?, ?, 'pro', 'web', ? WHERE EXISTS(SELECT 1 FROM purchase_visitors WHERE id=? AND revoked_at IS NULL)`).bind(ref, purchase.user_id, t, purchase.user_id),
      db.prepare(`INSERT OR IGNORE INTO purchase_licenses(visitor_id, source, ref, granted_at)
        SELECT ?, 'google', ?, ? WHERE EXISTS(SELECT 1 FROM purchase_visitors WHERE id=? AND revoked_at IS NULL)`).bind(purchase.user_id, ref, t, purchase.user_id),
    ]);
    await refreshPurchase(env, purchase);
  }
  const granted = await db.prepare("SELECT user_id FROM entitlements WHERE source='google' AND ref=? AND revoked_at IS NULL").bind(ref).first();
  if (!granted) return json({ error: "bad_receipt" }, 400);
  return buyerMe(env, contexts);
}

/// A refunded or charged-back purchase: Pro ends for the account and every device it licensed,
/// and their Android / web push registrations go, as revokeAccountApple does for the App Store.
export async function revokeGoogle(env, ref) {
  const db = env.DB, t = now();
  const owner = await db.prepare("SELECT user_id FROM entitlements WHERE source='google' AND ref=?").bind(ref).first();
  const visitors = (await db.prepare("SELECT visitor_id FROM purchase_licenses WHERE source='google' AND ref=?").bind(ref).all()).results.map((r) => r.visitor_id);
  await db.batch([
    db.prepare("UPDATE google_purchases SET revoked_at=? WHERE ref=? AND revoked_at IS NULL").bind(t, ref),
    db.prepare("UPDATE entitlements SET revoked_at=? WHERE source='google' AND ref=? AND revoked_at IS NULL").bind(t, ref),
  ]);
  const gone = (gid) => [
    ...["rules", "deferred", "watches", "income_watches", "webpush", "fcm", "devices"].map((table) => db.prepare(`DELETE FROM ${table} WHERE token IN
      (SELECT token FROM devices WHERE gid=? AND (chan IN ('webpush','fcm') OR account_pro=1)) AND EXISTS(SELECT 1 FROM groups WHERE gid=? AND pro_at IS NULL)`).bind(gid, gid)),
    db.prepare(`DELETE FROM live WHERE token IN(SELECT token FROM account_push_claims WHERE user_id=?)
      AND EXISTS(SELECT 1 FROM groups WHERE gid=? AND pro_at IS NULL)`).bind(gid, gid),
  ];
  if (owner && !owner.user_id.startsWith("g_")) {
    await syncPaid(env, owner.user_id);
    await db.batch([recalculate(db, owner.user_id), ...gone(owner.user_id)]);
  }
  for (const id of new Set([...visitors, ...(owner?.user_id.startsWith("g_") ? [owner.user_id] : [])])) {
    await refreshPurchase(env, { user_id: id });
    await db.batch(gone(id));
  }
  console.log("play revoked", ref.slice(0, 8), "visitors", visitors.length);
}

/// Hourly: purchases Play voided (refund, chargeback, revoked) since the last look, and
/// acknowledgements that failed when the purchase came in.
export async function playHousekeeping(env) {
  if (!playConfigured(env)) return;
  const db = env.DB, t = now();
  const since = Number((await db.prepare("SELECT v FROM kv WHERE k='play:voided'").first())?.v) || 0;
  // An hour of overlap: a void is acted on once (revoked_at), so seeing it twice is harmless.
  const start = Math.max(since - 3600, t - VOIDED_REACH + 60);
  let page = null, n = 0;
  do {
    const q = new URLSearchParams({ startTime: String(start * 1000), type: "0", maxResults: "1000" });
    if (page) q.set("token", page);
    const r = await play(env, `/purchases/voidedpurchases?${q}`);
    if (r.status !== 200) throw new Error(`play voided ${r.status}`);
    for (const v of r.body?.voidedPurchases || []) {
      if (typeof v.purchaseToken !== "string") continue;
      const ref = await sha256(`play:${v.purchaseToken}`);
      const known = await db.prepare("SELECT revoked_at FROM google_purchases WHERE ref=?").bind(ref).first();
      if (known && !known.revoked_at) { await revokeGoogle(env, ref); n++; }
    }
    page = r.body?.tokenPagination?.nextPageToken || null;
  } while (page);
  await db.prepare("INSERT INTO kv(k,v,ts) VALUES('play:voided',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, ts=excluded.ts").bind(String(t), t).run();
  const { results } = await db.prepare(`SELECT ref, token FROM google_purchases
    WHERE acknowledged_at IS NULL AND revoked_at IS NULL AND created_at > ?`).bind(t - ACK_WINDOW).all();
  for (const r of results) await acknowledge(env, r.ref, r.token);
  if (n || results.length) console.log(`play voided=${n} ack_retry=${results.length}`);
}
