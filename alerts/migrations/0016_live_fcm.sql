-- 2026-10-16: 锁屏盯盘 on Android (prl-hub-android LiveTicker.kt). An Android phone registers its ticker
-- under the token /v1/web/push files its FCM registration under (hex sha256 of "fcm:" + reg) with
-- topic 'android', and the registration itself rides here, so the ticker keeps working whether or
-- not price alerts are on. Additive: an older worker never names the column and sends APNs only.
ALTER TABLE live ADD COLUMN reg TEXT;
