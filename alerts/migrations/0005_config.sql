-- The browser holds the encryption key; the server stores only opaque ciphertext.
ALTER TABLE groups ADD COLUMN config BLOB;
ALTER TABLE groups ADD COLUMN config_rev INTEGER NOT NULL DEFAULT 0;
