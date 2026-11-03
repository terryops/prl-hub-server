-- 2026-10-26: Google Play purchases of Pro (the Play build of the Android app; src/play.js).
-- One row per purchase token. ref = hex sha256("play:" + token), also the ref of its
-- entitlements row (source 'google'). The token itself is kept to retry the acknowledgement Play
-- requires within three days and to match the Voided Purchases API. test = a license tester's
-- purchase (accepted only with PLAY_TEST_OK=1).
CREATE TABLE IF NOT EXISTS google_purchases (
  ref TEXT PRIMARY KEY, token TEXT NOT NULL, order_id TEXT, product TEXT NOT NULL,
  purchased_at INTEGER NOT NULL, test INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  acknowledged_at INTEGER, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS google_purchases_unacked ON google_purchases(created_at) WHERE acknowledged_at IS NULL;
