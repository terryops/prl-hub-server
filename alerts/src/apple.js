import { now } from "./http.js";
import { revokeAccountApple } from "./entitlements.js";

/// Called only after the outer Apple notification has passed verification.
export async function revokeApple(env, ref) {
  const db = env.DB;
  await db.prepare("INSERT INTO apple_purchases(original_tx, revoked_at) VALUES(?,?) ON CONFLICT(original_tx) DO UPDATE SET revoked_at=excluded.revoked_at").bind(ref,now()).run();
  await revokeAccountApple(env, ref);
  const owned = "SELECT token FROM devices WHERE chan = 'webpush' AND gid IN (SELECT gid FROM groups WHERE pro_src = 'apple' AND pro_ref = ?)";
  await db.batch([
    db.prepare("INSERT INTO apple_purchases (original_tx, revoked_at) VALUES (?, ?) ON CONFLICT(original_tx) DO UPDATE SET revoked_at = excluded.revoked_at").bind(ref, now()),
    ...["rules", "deferred", "watches", "webpush", "devices"].map((table) => db.prepare(`DELETE FROM ${table} WHERE token IN (${owned})`).bind(ref)),
    db.prepare("UPDATE groups SET pro_at = NULL, pro_src = NULL, pro_ref = NULL WHERE pro_src = 'apple' AND pro_ref = ?").bind(ref),
  ]);
  // A refunded receipt must not delete devices authorized by another account
  // purchase. Legacy devices authorized solely by this receipt are removed.
  const retained = (table) => `EXISTS(SELECT 1 FROM account_push_claims p JOIN account_devices a ON a.user_id=p.user_id AND a.id=p.device_id
    JOIN users u ON u.id=p.user_id JOIN groups g ON g.gid=p.user_id WHERE p.token=${table}.token
    AND p.revoked_at IS NULL AND a.revoked_at IS NULL AND u.deleted_at IS NULL AND g.pro_at IS NOT NULL)`;
  const receiptDevices = `SELECT token FROM devices WHERE original_transaction_id=? AND NOT ${retained("devices")}`;
  await db.batch([
    ...["rules", "deferred", "watches", "devices"].map((table) => db.prepare(`DELETE FROM ${table} WHERE token IN (${receiptDevices})`).bind(ref)),
    db.prepare(`DELETE FROM live WHERE original_transaction_id=? AND NOT ${retained("live")}`).bind(ref),
    db.prepare(`UPDATE devices SET account_pro=1 WHERE original_transaction_id=? AND ${retained("devices")}`).bind(ref),
    db.prepare(`UPDATE live SET account_pro=1 WHERE original_transaction_id=? AND ${retained("live")}`).bind(ref),
  ]);
  console.log("apple revoked", String(ref).slice(0, 8));
}
