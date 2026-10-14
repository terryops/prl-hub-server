-- Device-only purchase credentials do not grant access to email account data.
CREATE TABLE purchase_visitors (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE purchase_licenses (
  visitor_id TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL,
  granted_at INTEGER NOT NULL, PRIMARY KEY(visitor_id, source, ref)
);
CREATE INDEX purchase_license_receipt ON purchase_licenses(source, ref);
ALTER TABLE devices ADD COLUMN sync_gid TEXT;
ALTER TABLE devices ADD COLUMN sync_device_id TEXT;
CREATE INDEX devices_sync_owner ON devices(sync_gid, sync_device_id);
