import { now, webJson as json } from "./http.js";
import { authenticate, readBody, consumeChallenge, clearCookie, enabled } from "./auth.js";
import { getConfig, putConfig } from "./account-config.js";
import { listEntitlements, bindApple, accountPro } from "./entitlements.js";
import { buyerContexts, associatePurchase } from "./purchases.js";

export { revokeDevice } from "./account-lifecycle.js";
import { revokeDevice } from "./account-lifecycle.js";
// Rotation tombstones stay protected while their installation is active. A
// revoked/deleted installation has no remaining ownership of its push token.
export const RELEASED_PUSH = `(account_push_claims.revoked_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM account_devices a JOIN users u ON u.id=a.user_id
    WHERE a.user_id=account_push_claims.user_id AND a.id=account_push_claims.device_id
    AND a.revoked_at IS NULL AND u.deleted_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM purchase_visitors v WHERE v.id=account_push_claims.user_id
    AND v.device_id=account_push_claims.device_id AND v.revoked_at IS NULL))`;
export async function releasePush(env, token) {
  await env.DB.prepare(`DELETE FROM account_push_claims WHERE token=? AND ${RELEASED_PUSH}`).bind(token).run();
}
export async function claimPush(env, session, token, kind = "notification") {
  const db = env.DB;
  const statement = db.prepare(`INSERT INTO account_push_claims(token, user_id, device_id, kind) SELECT ?, ?, ?, ?
    WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM account_devices WHERE user_id=? AND id=? AND revoked_at IS NULL)
    AND (?='live' OR (SELECT COUNT(*) FROM account_push_claims p LEFT JOIN devices d ON d.token=p.token
      WHERE COALESCE(d.sync_gid,p.user_id)=? AND p.revoked_at IS NULL AND p.kind='notification')<10
      OR EXISTS(SELECT 1 FROM account_push_claims WHERE token=? AND user_id=? AND revoked_at IS NULL AND kind='notification')
      OR EXISTS(SELECT 1 FROM account_push_claims WHERE user_id=? AND device_id=? AND revoked_at IS NULL AND kind='notification'))
    ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, device_id=excluded.device_id, revoked_at=NULL,
      kind=CASE WHEN ${RELEASED_PUSH} THEN excluded.kind
        WHEN account_push_claims.kind='notification' THEN 'notification' ELSE excluded.kind END
      WHERE ${RELEASED_PUSH} OR (account_push_claims.user_id=excluded.user_id AND account_push_claims.device_id=excluded.device_id
        AND (excluded.kind<>'live' OR account_push_claims.kind<>'notification' OR account_push_claims.revoked_at IS NULL))
    ${kind === "live" ? "RETURNING token" : ""}`).bind(token, session.user_id, session.device_id, kind, session.id, session.user_id, session.device_id, kind, session.user_id, token, session.user_id, session.user_id, session.device_id);
  if (kind === "live") return !!await statement.first();
  // A rotated token replaces the ordinary notification channel on this installation.
  // Keep rotation tombstones protected until the installation is revoked.
  const others = "SELECT token FROM account_push_claims WHERE user_id=? AND device_id=? AND kind='notification' AND token<>?";
  const active = "EXISTS(SELECT 1 FROM account_push_claims p JOIN sessions s ON s.user_id=p.user_id AND s.device_id=p.device_id WHERE p.token=? AND s.id=? AND p.user_id=? AND p.device_id=? AND p.revoked_at IS NULL AND s.revoked_at IS NULL)";
  const args = [session.user_id, session.device_id, token, token, session.id, session.user_id, session.device_id];
  const result = await db.batch([
    statement,
    db.prepare(`UPDATE account_push_claims SET revoked_at=? WHERE token IN (${others}) AND ${active}`).bind(now(), ...args),
    ...["rules", "deferred", "watches", "webpush", "devices"].map((table) => db.prepare(`DELETE FROM ${table} WHERE token IN (${others}) AND ${active}`).bind(...args)),
  ]);
  return !!result[0].meta.changes;
}
export async function pushOwner(req, env, token) {
  const {account,purchase}=await buyerContexts(req,env);
  // Invalid/revoked credentials must never fall back to the guest route.
  const proof = req.headers.has("authorization") || req.headers.has("x-account-id") ||
    req.headers.get("cookie")?.split(";").some(c => c.trim().startsWith("__Host-prl_session="));
  if (proof && !account && !purchase) return null;
  const claim = await env.DB.prepare(`SELECT *, ${RELEASED_PUSH} AS released FROM account_push_claims WHERE token=?`).bind(token).first();
  if (!claim || claim.released) return { legacy: true };
  const s=[account,purchase].find(s=>s && claim.user_id===s.user_id && claim.device_id===s.device_id);
  if(!s)return null;
  const scope=await env.DB.prepare("SELECT sync_gid,sync_device_id FROM devices WHERE token=?").bind(token).first();
  if(scope?.sync_gid && (!account || account.user_id!==scope.sync_gid || account.device_id!==scope.sync_device_id)) return null;
  return {session:s};
}
export async function accountRoutes(req, env) {
  const url = new URL(req.url), path = url.pathname;
  if (!path.startsWith("/v1/account") && path !== "/v1/auth/logout") return null;
  const session = await authenticate(req, env);
  if (!session) return json({ error: "unauthorized" }, 401);
  const uid = session.user_id, db = env.DB;
  const limiter = ["GET", "HEAD"].includes(req.method) ? env.RL_READ : env.RL;
  if (limiter && !(await limiter.limit({ key: `account:${uid}` })).success) return json({ error: "rate_limited" }, 429);
  let body = {};
  if (!["GET", "HEAD"].includes(req.method)) {
    try { body = await readBody(req, path === "/v1/account/config" ? 70000 : 20000); }
    catch { return json({ error: "bad_body" }, 400); }
  }
  if (path === "/v1/account" && req.method === "GET") return json({ user_id: uid, email: session.email, device_id: session.device_id, accounts_enabled: enabled(env), pro: await accountPro(env, uid) });
  if (path === "/v1/account/config" && req.method === "GET") return getConfig(env, uid);
  if (path === "/v1/account/config" && req.method === "PUT") return putConfig(env, uid, body, session);
  if (path === "/v1/account/export" && req.method === "GET") return getConfig(env, uid);
  if (path === "/v1/account/entitlements" && req.method === "GET") return listEntitlements(env, uid);
  if (path === "/v1/account/entitlements/apple" && req.method === "POST") return bindApple(env, uid, body, session);
  if (path === "/v1/auth/logout" && req.method === "POST") {
    const {purchase}=await buyerContexts(req,env);
    if(purchase)await associatePurchase(env,session,purchase);
    await db.batch(revokeDevice(db, uid, session.device_id));
    return clearCookie(json({ ok: true }));
  }
  if (path === "/v1/account/devices" && req.method === "GET") {
    const { results } = await db.prepare(`SELECT a.id, a.name, a.platform, a.created_at, a.seen_at,
      EXISTS(SELECT 1 FROM devices d JOIN account_push_claims p ON p.token=d.token
        WHERE ((d.gid=a.user_id AND d.account_device_id=a.id) OR (d.sync_gid=a.user_id AND d.sync_device_id=a.id)) AND p.revoked_at IS NULL) AS notifications
      FROM account_devices a WHERE a.user_id=? AND a.revoked_at IS NULL ORDER BY a.seen_at DESC`).bind(uid).all();
    return json({ devices: results.map((d) => ({ ...d, current: d.id === session.device_id, notifications: !!d.notifications })) });
  }
  const device = path.match(/^\/v1\/account\/devices\/([A-Za-z0-9_-]{16,80})$/)?.[1];
  if (device) {
    if (req.method === "DELETE") {
      await db.batch(revokeDevice(db, uid, device));
      const res = json({ ok: true }); return device === session.device_id ? clearCookie(res) : res;
    }
    if (req.method === "PATCH") {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) return json({ error: "bad_name" }, 400);
      const r = await db.prepare("UPDATE account_devices SET name=? WHERE user_id=? AND id=? AND revoked_at IS NULL").bind(body.name.trim(), uid, device).run();
      return json(r.meta.changes ? { ok: true } : { error: "not_found" }, r.meta.changes ? 200 : 404);
    }
  }
  if (path === "/v1/account/email" && req.method === "POST") {
    const old = await consumeChallenge(env, body.old, "change_old", uid);
    const next = await consumeChallenge(env, body.next, "change_new", uid);
    if (!old || !next || old.email !== session.email) return json({ error: "invalid_code" }, 401);
    const ownedByOthers = "SELECT token FROM account_push_claims WHERE user_id=? AND device_id<>? UNION SELECT token FROM devices WHERE sync_gid=? AND sync_device_id<>?";
    const guard = "EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.email=? AND s.id=? AND s.revoked_at IS NULL)";
    const guarded = (sql, ...params) => db.prepare(`${sql} AND ${guard}`).bind(...params, uid, next.email, session.id);
    try {
      const out = await db.batch([
        db.prepare("UPDATE users SET email=? WHERE id=? AND email=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND revoked_at IS NULL)").bind(next.email, uid, old.email, session.id),
        guarded("UPDATE account_devices SET revoked_at=? WHERE user_id=? AND id<>?", now(), uid, session.device_id),
        guarded("UPDATE account_push_claims SET revoked_at=? WHERE user_id=? AND device_id<>?", now(), uid, session.device_id),
        guarded(`UPDATE account_push_claims SET revoked_at=? WHERE token IN(${ownedByOthers})`,now(),uid,session.device_id,uid,session.device_id),
        ...["rules", "deferred", "watches", "webpush", "devices", "live"].map((table) => guarded(`DELETE FROM ${table} WHERE token IN (${ownedByOthers})`, uid, session.device_id,uid,session.device_id)),
        guarded("UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>?", now(), uid, session.id),
      ]);
      return out[0].meta.changes ? json({ ok: true, email: next.email }) : json({ error: "conflict" }, 409);
    } catch (e) {
      if (String(e).includes("UNIQUE")) return json({ error: "email_already_used" }, 409);
      throw e;
    }
  }
  if (path === "/v1/account" && req.method === "DELETE") {
    const proof = await consumeChallenge(env, body, "delete", uid);
    if (!proof || proof.email !== session.email) return json({ error: "invalid_code" }, 401);
    const owned = "SELECT token FROM account_push_claims WHERE user_id=? UNION SELECT token FROM devices WHERE sync_gid=?";
    await db.batch([
      db.prepare("UPDATE users SET email=NULL, deleted_at=? WHERE id=?").bind(now(), uid),
      db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=?").bind(now(), uid),
      db.prepare("UPDATE account_push_claims SET revoked_at=? WHERE user_id=?").bind(now(), uid),
      db.prepare(`UPDATE account_push_claims SET revoked_at=? WHERE token IN(${owned})`).bind(now(),uid,uid),
      ...["rules", "deferred", "watches", "webpush", "devices", "live"].map((table) => db.prepare(`DELETE FROM ${table} WHERE token IN (${owned})`).bind(uid,uid)),
      db.prepare("DELETE FROM account_configs WHERE user_id=?").bind(uid),
      db.prepare("DELETE FROM auth_codes WHERE user_id=?").bind(uid),
      db.prepare("DELETE FROM auth_challenges WHERE user_id=? OR email=?").bind(uid, session.email),
      db.prepare("DELETE FROM account_devices WHERE user_id=?").bind(uid),
      db.prepare("UPDATE groups SET config=NULL, pro_at=NULL, pro_src=NULL, pro_ref=NULL WHERE gid=?").bind(uid),
    ]);
    return clearCookie(json({ ok: true }));
  }
  return json({ error: "not_found" }, 404);
}
