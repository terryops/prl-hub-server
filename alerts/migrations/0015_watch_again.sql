-- 2026-10-16: 掉线提醒 — a second push if a worker is still offline (src/watch.js `due`).
-- Additive: an older worker never names these columns, so its INSERTs take the defaults.
ALTER TABLE watches ADD COLUMN again INTEGER NOT NULL DEFAULT 0;     -- remind once, this long after the first push (s); 0 = never
ALTER TABLE watches ADD COLUMN again_at INTEGER NOT NULL DEFAULT 0;  -- when the reminder was switched on: only outages pushed since get one
