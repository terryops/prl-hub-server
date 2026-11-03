-- 2026-10-30: 到账提醒 — a push when a device's one PRL address is paid (src/income-watch.js).
-- Apply to the live db before deploying the worker that reads it:
--   npx wrangler d1 migrations apply prl-alerts --remote

CREATE TABLE IF NOT EXISTS income_watches (
  token   TEXT PRIMARY KEY,              -- the device (devices.token): one address each
  addr    TEXT NOT NULL,                 -- prl1… address
  label   TEXT NOT NULL DEFAULT '',      -- its name in the app, for the push text
  since   INTEGER NOT NULL,              -- when this address was set: payments before are not news
  told    TEXT NOT NULL DEFAULT '[]',    -- JSON [txid] pushed already, newest first (TOLD_KEEP)
  pending TEXT NOT NULL DEFAULT '[]'     -- JSON [[txid, sats, found at]] not pushed yet (quiet hours, back-off)
);
CREATE INDEX IF NOT EXISTS income_watches_addr ON income_watches (addr);
-- The cron looks for news held back every minute: only those rows are in this index.
CREATE INDEX IF NOT EXISTS income_watches_pending ON income_watches (token) WHERE pending <> '[]';
