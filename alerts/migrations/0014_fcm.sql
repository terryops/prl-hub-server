-- Android devices (devices.chan = 'fcm', topic 'android'): their FCM registration
-- token, keyed like webpush by the device token (hex sha256 of "fcm:" + reg).
CREATE TABLE IF NOT EXISTS fcm (token TEXT PRIMARY KEY, reg TEXT NOT NULL);
