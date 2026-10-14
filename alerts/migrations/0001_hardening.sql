-- 2026-09-27: Pro receipts, token proof, APNs back-off, last-seen (src/index.js).
-- Apply to the live db (before deploying the worker that reads these columns):
--   npx wrangler d1 migrations apply prl-alerts --remote
-- wrangler records it in the d1_migrations table, so running that again is a no-op.

-- The Pro purchase a device / Live Activity registered with (StoreKit 2
-- originalTransactionId); a refund or revocation of it drops the rows.
ALTER TABLE devices ADD COLUMN original_transaction_id TEXT;
ALTER TABLE live ADD COLUMN original_transaction_id TEXT;
CREATE INDEX IF NOT EXISTS devices_otid ON devices (original_transaction_id);
CREATE INDEX IF NOT EXISTS live_otid ON live (original_transaction_id);

-- When APNs first accepted a push to this token (NULL = never proven real).
ALTER TABLE devices ADD COLUMN verified_at INTEGER;
-- No pushes to this device before this time (APNs answered 429).
ALTER TABLE devices ADD COLUMN retry_after INTEGER;
-- Last time the app checked in (GET or PUT); devices unseen for 90 days are dropped.
ALTER TABLE devices ADD COLUMN seen_at INTEGER;

-- Every device registered before token proof existed came from a real install.
UPDATE devices SET verified_at = updated_at WHERE verified_at IS NULL;
