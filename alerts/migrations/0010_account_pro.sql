-- Account Pro can authorize native push without a local Apple receipt.
-- Keep legacy receipt authorization distinguishable during delivery and refunds.
ALTER TABLE devices ADD COLUMN account_pro INTEGER NOT NULL DEFAULT 0 CHECK(account_pro IN (0,1));
ALTER TABLE live ADD COLUMN account_pro INTEGER NOT NULL DEFAULT 0 CHECK(account_pro IN (0,1));
