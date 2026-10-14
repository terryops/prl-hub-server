-- Anonymous web identities and exact-amount PRL payments.
CREATE TABLE IF NOT EXISTS groups (
  gid TEXT PRIMARY KEY, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
  pro_at INTEGER, pro_src TEXT, pro_ref TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, gid TEXT NOT NULL, usd REAL NOT NULL, rate REAL NOT NULL,
  sats INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', txid TEXT, seen_at INTEGER, paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_gid ON orders (gid);
CREATE TABLE IF NOT EXISTS payments (
  txid TEXT PRIMARY KEY, sats INTEGER NOT NULL, first_seen INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0, order_id TEXT, told_owner INTEGER NOT NULL DEFAULT 0
);
