-- 2026-10-17: sign in once, on every device. A signed-in iOS / macOS app keeps a ticket in the
-- user's iCloud Keychain (end-to-end encrypted); their other devices trade it for sessions of
-- their own (POST /v1/auth/ticket). A ticket hangs on the session that issued it: when that
-- session ends (sign-out, device removed, account deleted) the ticket is dead too.
-- Only the SHA-256 of a ticket is stored. Additive: an older worker never names this table.
CREATE TABLE device_tickets (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX device_tickets_session ON device_tickets(source_session_id);
CREATE INDEX device_tickets_user ON device_tickets(user_id);
