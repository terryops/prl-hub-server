-- NULL preserves the device-level setting used by older clients. New clients
-- explicitly choose one-shot (0, the default in the editor) or repeating (1).
ALTER TABLE rules ADD COLUMN repeating INTEGER CHECK (repeating IN (0, 1));
