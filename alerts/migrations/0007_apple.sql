-- Keep links after a refund so an old signed receipt cannot restore Pro.
CREATE TABLE IF NOT EXISTS apple_purchases (
  original_tx TEXT PRIMARY KEY, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS apple_links (
  original_tx TEXT NOT NULL, gid TEXT NOT NULL, linked_at INTEGER NOT NULL,
  PRIMARY KEY (original_tx, gid)
);
