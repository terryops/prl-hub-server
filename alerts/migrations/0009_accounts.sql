-- Verified accounts coexist with the purchase ledger and older native devices.
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE account_devices (
  id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL,
  created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
  client TEXT NOT NULL, access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL, access_expires INTEGER NOT NULL,
  email_verified_at INTEGER NOT NULL DEFAULT 0,
  idle_expires INTEGER NOT NULL, max_expires INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX sessions_user_device ON sessions(user_id, device_id);
CREATE TABLE refresh_history (
  hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, purpose TEXT NOT NULL, user_id TEXT,
  code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, consumed_at INTEGER, delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX auth_email_recent ON auth_challenges(email, created_at);
CREATE TABLE auth_budgets (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE account_configs (
  user_id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0,
  data TEXT, commit_id TEXT, updated_at INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE devices ADD COLUMN account_device_id TEXT;
-- Claims survive deletion of a push subscription, closing legacy-token routes.
CREATE TABLE account_push_claims (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
  revoked_at INTEGER, kind TEXT NOT NULL DEFAULT 'notification'
);
CREATE INDEX account_push_owner ON account_push_claims(user_id, device_id);
CREATE INDEX devices_account ON devices(gid, account_device_id);
CREATE TABLE entitlements (
  source TEXT NOT NULL, ref TEXT NOT NULL, user_id TEXT NOT NULL,
  product TEXT NOT NULL, platform TEXT NOT NULL, granted_at INTEGER NOT NULL,
  revoked_at INTEGER, PRIMARY KEY(source, ref)
);
CREATE INDEX entitlement_user ON entitlements(user_id, revoked_at);
CREATE TABLE auth_codes (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
  platform TEXT NOT NULL, name TEXT NOT NULL, challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, email_verified_at INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT NOT NULL DEFAULT ''
);
