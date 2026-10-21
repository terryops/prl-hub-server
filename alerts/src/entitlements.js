import { now, webJson as json } from "./http.js";
import { verifyAppleJWS } from "./jws.js";
import { consumeChallenge } from "./auth.js";

// Historical platform='web' rows now grant account Pro on Web and native apps.
// Retain the storage value so existing ledgers and rollback code stay compatible.

export function recalculate(db, uid) {
  return db.prepare(`UPDATE groups SET
    pro_at=(SELECT MIN(granted_at) FROM entitlements WHERE user_id=? AND revoked_at IS NULL AND platform='web'),
    pro_src=(SELECT source FROM entitlements WHERE user_id=? AND revoked_at IS NULL AND platform='web' ORDER BY granted_at, source LIMIT 1),
    pro_ref=(SELECT ref FROM entitlements WHERE user_id=? AND revoked_at IS NULL AND platform='web' ORDER BY granted_at, source LIMIT 1)
    WHERE gid=? AND (pro_at IS NOT (SELECT MIN(granted_at) FROM entitlements WHERE user_id=? AND revoked_at IS NULL AND platform='web')
      OR pro_src IS NOT (SELECT source FROM entitlements WHERE user_id=? AND revoked_at IS NULL AND platform='web' ORDER BY granted_at, source LIMIT 1)
      OR pro_ref IS NOT (SELECT ref FROM entitlements WHERE user_id=? AND revoked_at IS NULL AND platform='web' ORDER BY granted_at, source LIMIT 1))`).bind(uid, uid, uid, uid, uid, uid, uid);
}
export async function syncPaid(env, uid) {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO entitlements(source, ref, user_id, product, platform, granted_at)
      SELECT 'prl', txid, gid, 'pro', 'web', paid_at FROM orders WHERE gid=? AND status='paid' AND txid IS NOT NULL
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)`).bind(uid, uid),
    env.DB.prepare(`INSERT OR IGNORE INTO entitlements(source, ref, user_id, product, platform, granted_at)
      SELECT 'admin', gid, gid, 'pro', 'web', pro_at FROM groups WHERE gid=? AND pro_src='admin' AND pro_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)`).bind(uid, uid),
    recalculate(env.DB, uid),
  ]);
}
export const accountProSQL = (id) => `EXISTS(SELECT 1 FROM entitlements e WHERE e.user_id=${id}
  AND e.product='pro' AND e.platform='web' AND e.revoked_at IS NULL)`;
export async function accountPro(env, uid) {
  await syncPaid(env, uid);
  return !!(await env.DB.prepare(`SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL AND ${accountProSQL("users.id")}`).bind(uid).first());
}
export async function listEntitlements(env, uid) {
  await syncPaid(env, uid);
  const { results } = await env.DB.prepare("SELECT source, product, platform, granted_at, revoked_at FROM entitlements WHERE user_id=? ORDER BY granted_at DESC").bind(uid).all();
  return json({ entitlements: results, pro: results.some((e) => e.platform === "web" && e.revoked_at == null) });
}
export async function bindApple(env, uid, body, session) {
  const p = await verifyAppleJWS(body.jws, { rootSHA256: env.APPLE_ROOT_SHA256 || undefined });
  if (!p || p.bundleId !== "com.prl.wizard" || p.productId !== "com.prl.wizard.pro" || p.revocationDate != null ||
      !["Production", "Sandbox"].includes(p.environment) || p.environment === "Sandbox" && env.APPLE_SANDBOX_OK !== "1" ||
      typeof p.originalTransactionId !== "string" || !/^\d{1,128}$/.test(p.originalTransactionId)) return json({ error: "bad_receipt" }, 400);
  const db = env.DB, ref = p.originalTransactionId, t = now();
  const existing = await db.prepare("SELECT user_id FROM entitlements WHERE source='apple' AND ref=?").bind(ref).first();
  if (!existing && (!session || session.email_verified_at < t - 300)) {
    const proof = await consumeChallenge(env, body.proof || {}, "purchase", uid);
    if (!proof || proof.email !== session?.email) return json({ error: "verification_required" }, 403);
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO apple_purchases(original_tx) VALUES (?)").bind(ref),
    db.prepare(`INSERT OR IGNORE INTO entitlements(source, ref, user_id, product, platform, granted_at)
      SELECT 'apple', ?, ?, 'pro', 'web', ? WHERE EXISTS(SELECT 1 FROM apple_purchases WHERE original_tx=? AND revoked_at IS NULL)
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)`).bind(ref, uid, t, ref, uid),
    recalculate(db, uid),
  ]);
  const grant = await db.prepare("SELECT user_id, revoked_at FROM entitlements WHERE source='apple' AND ref=?").bind(ref).first();
  if (!grant || grant.revoked_at != null) return json({ error: "bad_receipt" }, 400);
  if (grant.user_id !== uid) return json({ error: "purchase_already_linked" }, 409);
  return listEntitlements(env, uid);
}
export async function revokeAccountApple(env, ref) {
  const db = env.DB;
  const owners = (await db.prepare("SELECT user_id FROM entitlements WHERE source='apple' AND ref=?").bind(ref).all()).results;
  for (const { user_id: uid } of owners) {
    await syncPaid(env, uid);
    await db.batch([
      db.prepare("UPDATE entitlements SET revoked_at=? WHERE source='apple' AND ref=?").bind(now(), ref),
      recalculate(db, uid),
      ...["rules", "deferred", "watches", "webpush", "fcm", "devices"].map((table) => db.prepare(`DELETE FROM ${table} WHERE token IN
        (SELECT token FROM devices WHERE gid=? AND (chan IN ('webpush','fcm') OR account_pro=1)) AND EXISTS(SELECT 1 FROM groups WHERE gid=? AND pro_at IS NULL)`).bind(uid, uid)),
      db.prepare(`DELETE FROM live WHERE account_pro=1 AND token IN(SELECT token FROM account_push_claims WHERE user_id=?)
        AND EXISTS(SELECT 1 FROM groups WHERE gid=? AND pro_at IS NULL)`).bind(uid, uid),
    ]);
  }
}
