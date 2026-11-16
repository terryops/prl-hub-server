-- Remember the verified account before payment; settlement must not depend on a browser callback.
ALTER TABLE orders ADD COLUMN account_id TEXT;
CREATE INDEX orders_account ON orders(account_id);
