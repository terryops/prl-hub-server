-- 2026-10-09: 掉线提醒 — worker-offline pushes for pool monitors (src/watch.js, src/pools.js).
-- Apply to the live db (before deploying the worker that reads these tables):
--   npx wrangler d1 migrations apply prl-alerts --remote

-- A pool monitor a device wants offline pushes for.
CREATE TABLE IF NOT EXISTS watches (
  token  TEXT NOT NULL,                  -- the device (devices.token)
  id     TEXT NOT NULL,                  -- the app's id for the monitor
  pool   TEXT NOT NULL,                  -- 'AlphaPool' | 'Kryptex' | 'F2Pool' | … (pools.js POOLS)
  addr   TEXT NOT NULL,                  -- payout address; F2Pool: read-only key[/account]
  label  TEXT NOT NULL DEFAULT '',       -- the monitor's name in the app, for the push text
  after  INTEGER NOT NULL DEFAULT 600,   -- push once a worker has been offline this long (s)
  told   TEXT NOT NULL DEFAULT '{}',     -- JSON { worker: [offline since, pushed at] }
  base   INTEGER NOT NULL DEFAULT 0,     -- 1 once it has had its first look (see watch.js due)
  PRIMARY KEY (token, id)
);
CREATE INDEX IF NOT EXISTS watches_miner ON watches (pool, addr);

-- One row per distinct (pool, addr) anyone watches: what its last poll showed.
CREATE TABLE IF NOT EXISTS miners (
  pool       TEXT NOT NULL,
  addr       TEXT NOT NULL,
  workers    TEXT NOT NULL DEFAULT '{}', -- JSON { worker: 0 online | offline since (unix s) }
  tried_at   INTEGER,                    -- last poll, answered or not
  checked_at INTEGER,                    -- last poll the pool answered
  missing    INTEGER NOT NULL DEFAULT 0, -- 1 = the pool says it has no such miner
  PRIMARY KEY (pool, addr)
);
-- Deliberately no index on tried_at / checked_at, although the cron filters on both
-- every minute: every poll rewrites those two columns, D1 bills each index entry it
-- touches as a row written, and a written row costs 1000× a read one. Scanning a few
-- thousand miners a minute is the cheap side of that trade.
