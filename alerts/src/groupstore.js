import { ORDER_TTL } from "./orders.js";

// New free config identities are bounded independently of IPs or bearers.
// Paid identities keep their entitlement and configuration indefinitely.
export const GROUP_KEEP = 30 * 86400;
export async function ensureGroup(env, gid, t) {
  const db = env.DB;
  if (await db.prepare("SELECT gid FROM groups WHERE gid = ?").bind(gid).first()) return true;
  const configured = Number(env.GROUP_LIMIT);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 1000;
  const row = await db.prepare(`INSERT OR IGNORE INTO groups (gid, created_at, seen_at)
    SELECT ?, ?, ? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
    OR (SELECT COUNT(*) FROM groups WHERE pro_at IS NULL AND NOT EXISTS(SELECT 1 FROM users WHERE id=groups.gid)) < ? RETURNING gid`)
    .bind(gid, t, t, gid, limit).first();
  // Another request may have created this same identity while we were waiting.
  return !!row || !!await db.prepare("SELECT gid FROM groups WHERE gid = ?").bind(gid).first();
}
export const pruneGroups = (db, t) => db.prepare(`DELETE FROM groups
  WHERE pro_at IS NULL AND seen_at < ?
    AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = groups.gid)
    AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.gid = groups.gid)
    AND NOT EXISTS (SELECT 1 FROM devices WHERE devices.gid = groups.gid)`)
  .bind(t - GROUP_KEEP);

/// Retain orders for late payment matching; only discard empty identities.
/// Seen payments and saved state survive quote expiry without using seen_at.
export const pruneEmptyGroups = (db, t) => db.prepare(`DELETE FROM groups
  WHERE pro_at IS NULL AND config IS NULL AND created_at < ?
    AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = groups.gid)
    AND NOT EXISTS (SELECT 1 FROM devices WHERE devices.gid = groups.gid)
    AND NOT EXISTS (SELECT 1 FROM apple_links WHERE apple_links.gid = groups.gid)
    AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.gid = groups.gid
      AND (orders.status = 'seen' OR (orders.status = 'pending' AND orders.expires_at > ?)))`)
  .bind(t - ORDER_TTL, t);
