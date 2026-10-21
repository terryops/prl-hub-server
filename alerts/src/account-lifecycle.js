import { now } from "./http.js";
export function revokeDevice(db, uid, id, t = now()) {
  const tokens = "SELECT token FROM account_push_claims WHERE user_id=? AND device_id=? UNION SELECT token FROM devices WHERE sync_gid=? AND sync_device_id=?";
  return [
    db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND device_id=?").bind(t, uid, id),
    db.prepare("UPDATE account_devices SET revoked_at=? WHERE user_id=? AND id=?").bind(t, uid, id),
    db.prepare(`UPDATE account_push_claims SET revoked_at=? WHERE token IN(${tokens})`).bind(t,uid,id,uid,id),
    ...["rules", "deferred", "watches", "webpush", "fcm", "devices", "live"].map((table) => db.prepare(`DELETE FROM ${table} WHERE token IN (${tokens})`).bind(uid, id,uid,id)),
  ];
}
