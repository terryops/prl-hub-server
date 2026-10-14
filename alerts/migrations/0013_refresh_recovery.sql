-- Recover a lost rotation response only until the successor generation is used.
-- Store hashes and a random derivation nonce, never plaintext bearer credentials.
ALTER TABLE sessions ADD COLUMN generation_used_at INTEGER;
ALTER TABLE refresh_history ADD COLUMN successor_hash TEXT;
ALTER TABLE refresh_history ADD COLUMN recovery_nonce TEXT;
