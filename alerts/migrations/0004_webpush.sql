-- Defaults preserve every existing APNs device.
ALTER TABLE devices ADD COLUMN chan TEXT NOT NULL DEFAULT 'apns';
ALTER TABLE devices ADD COLUMN gid TEXT;
CREATE TABLE IF NOT EXISTS webpush (
  token TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL
);
