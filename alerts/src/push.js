import { send as apns, apnsConfigured } from "./apns.js";
import { send as webpush, configured } from "./webpush.js";
import { purchaseProSQL } from "./purchases.js";
export const channelConfigured = (env, device) =>
  device.chan === "webpush" ? configured(env) : apnsConfigured(env);
export async function accountPushAllowed(db, token) {
  const claim = await db.prepare(`SELECT p.token, p.revoked_at, a.id, a.revoked_at AS device_revoked, u.id AS user_id, u.deleted_at,
    (COALESCE(d.account_pro,0)=1 OR COALESCE(l.account_pro,0)=1) AS needs_pro, g.pro_at,
    v.id AS visitor_id,v.revoked_at AS visitor_revoked,${purchaseProSQL("v.id")} AS visitor_pro,
    d.sync_gid,sa.id AS sync_device,sa.revoked_at AS sync_revoked,su.id AS sync_user,su.deleted_at AS sync_deleted
    FROM account_push_claims p LEFT JOIN account_devices a ON a.user_id=p.user_id AND a.id=p.device_id
    LEFT JOIN users u ON u.id=p.user_id LEFT JOIN groups g ON g.gid=p.user_id
    LEFT JOIN devices d ON d.token=p.token LEFT JOIN live l ON l.token=p.token
    LEFT JOIN purchase_visitors v ON v.id=p.user_id
    LEFT JOIN account_devices sa ON sa.user_id=d.sync_gid AND sa.id=d.sync_device_id
    LEFT JOIN users su ON su.id=d.sync_gid WHERE p.token=?`).bind(token).first();
  if (!claim) return true;
  if(claim.visitor_id) return claim.revoked_at==null&&claim.visitor_revoked==null&&!!claim.visitor_pro&&
    (!claim.sync_gid||!!(claim.sync_user&&claim.sync_device&&claim.sync_revoked==null&&claim.sync_deleted==null));
  if (!(claim.id && claim.user_id && claim.revoked_at == null && claim.device_revoked == null && claim.deleted_at == null)) return false;
  return !claim.needs_pro || claim.pro_at != null;
}
export async function deliver(env, db, device, payload, opts) {
  if (!await accountPushAllowed(db, device.token))
    return { ok: false, drop: true, reason: "account device revoked" };
  if (device.chan !== "webpush") return apns(env, db, device, payload, opts);
  const sub = await db
    .prepare("SELECT endpoint, p256dh, auth FROM webpush WHERE token = ?")
    .bind(device.token)
    .first();
  return sub
    ? webpush(env, sub, payload, opts)
    : { ok: false, drop: true, reason: "subscription gone" };
}
