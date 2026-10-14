-- D1 schema for the price-alert worker.  Apply with:
--   npx wrangler d1 execute prl-alerts --remote --file=schema.sql
--   npx wrangler d1 migrations apply prl-alerts --remote    # later columns: migrations/

CREATE TABLE IF NOT EXISTS devices (
  token      TEXT PRIMARY KEY,           -- APNs device token (lowercase hex)
  env        TEXT NOT NULL,              -- 'production' | 'sandbox'
  topic      TEXT NOT NULL,              -- app bundle id
  lang       TEXT NOT NULL DEFAULT 'en', -- notification language
  oneshot    INTEGER NOT NULL DEFAULT 0, -- app switches fired alerts off (1.15 b116+)
  win_start  INTEGER,                    -- push window, minutes after local midnight (1.16+);
  win_end    INTEGER,                    --   NULL = all day; end < start wraps midnight
  tz         TEXT,                       -- IANA time zone of that window
  updated_at INTEGER NOT NULL
);
-- win_start / win_end / tz added 2026-09-23 on the live db with:
--   ALTER TABLE devices ADD COLUMN win_start INTEGER;
--   ALTER TABLE devices ADD COLUMN win_end INTEGER;
--   ALTER TABLE devices ADD COLUMN tz TEXT;
-- oneshot added 2026-09-23 on the live db with:
--   ALTER TABLE devices ADD COLUMN oneshot INTEGER NOT NULL DEFAULT 0;
-- original_transaction_id / verified_at / retry_after / seen_at:
--   migrations/0001_hardening.sql

CREATE TABLE IF NOT EXISTS rules (
  token      TEXT NOT NULL,
  id         TEXT NOT NULL,              -- client-generated
  kind       TEXT NOT NULL,              -- 'above' | 'below' | 'move'
  value      REAL NOT NULL,              -- USD for above/below, % for move
  window     INTEGER NOT NULL DEFAULT 0, -- move: 3600 | 86400 seconds
  enabled    INTEGER NOT NULL DEFAULT 1,
  armed      INTEGER NOT NULL DEFAULT 1,
  last_fired INTEGER,
  PRIMARY KEY (token, id)
);
CREATE INDEX IF NOT EXISTS rules_enabled ON rules (enabled);

-- Alerts that fired during a device's quiet hours, pushed at its next window
-- start (then deleted); dropped unsent after 48 h. Added 2026-09-23.
CREATE TABLE IF NOT EXISTS deferred (
  token    TEXT NOT NULL,
  rule_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  value    REAL NOT NULL,
  window   INTEGER NOT NULL DEFAULT 0,
  change   REAL,                         -- move: the % change when it fired
  fired_at INTEGER NOT NULL,
  PRIMARY KEY (token, rule_id)
);

-- 锁屏盯盘: Live Activities to push the live price to, keyed by the activity's
-- push token. iOS ends an activity after 8 h, so rows stop getting pushes then
-- and are pruned at 12 h. Added 2026-09-23.
CREATE TABLE IF NOT EXISTS live (
  token      TEXT PRIMARY KEY,           -- ActivityKit push token (lowercase hex)
  env        TEXT NOT NULL,              -- 'production' | 'sandbox'
  topic      TEXT NOT NULL,              -- app bundle id
  started_at INTEGER NOT NULL,
  last_usd   REAL,                       -- price in the last push
  last_push  INTEGER
);
-- original_transaction_id: migrations/0001_hardening.sql

-- One price per minute, pruned to the last 26 h (5m/1h/24h change).
-- src: 'safetrade' (pushed ticker) or 'median' (fallback); changes compare
-- within one source only.  Added 2026-09-18 on the live db with:
--   ALTER TABLE prices ADD COLUMN src TEXT NOT NULL DEFAULT 'median';
CREATE TABLE IF NOT EXISTS prices (
  ts  INTEGER PRIMARY KEY,
  usd REAL NOT NULL,
  src TEXT NOT NULL DEFAULT 'median'
);


-- 掉线提醒 (worker-offline pushes for pool monitors): tables `watches` and `miners`
-- are created by migrations/0002_watches.sql.

-- Account sessions / refresh_history are created by migrations/0009_accounts.sql.
-- migrations/0013_refresh_recovery.sql adds sessions.generation_used_at (INTEGER),
-- refresh_history.successor_hash (TEXT) and recovery_nonce (TEXT): a previous
-- refresh token can recover its unused successor without storing plaintext tokens.

-- Small shared state: the APNs provider JWT, per-device test-push throttle,
-- the latest pushed SafeTrade quote (k = 'safetrade'), the /v1/price reply
-- the last tick built (k = 'price'), pools resting after a 429 (k = 'rest:<pool>',
-- ts = until), what APNs made of a tick's 掉线提醒 pushes (k = 'sent:<t>', a week).
CREATE TABLE IF NOT EXISTS kv (
  k  TEXT PRIMARY KEY,
  v  TEXT NOT NULL,
  ts INTEGER NOT NULL
);
