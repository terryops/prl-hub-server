-- Block height anchors checkout without trusting miner-set block timestamps.
ALTER TABLE orders ADD COLUMN start_height INTEGER;
CREATE INDEX IF NOT EXISTS groups_free_seen ON groups (seen_at) WHERE pro_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_status_created ON orders (status, created_at);
