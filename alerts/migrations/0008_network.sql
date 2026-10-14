-- Public block-header samples, filled gradually by cron, never by an HTTP read.
CREATE TABLE IF NOT EXISTS network_samples (
  height INTEGER PRIMARY KEY, ts INTEGER NOT NULL, difficulty REAL NOT NULL,
  sampled_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS network_samples_ts ON network_samples (ts);
