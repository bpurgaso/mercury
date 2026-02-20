-- Phase 6b: Add signed_prekey_id so the server can track which SPK version is active.
-- The client sends this with key bundle uploads and expects it back on fetches.
ALTER TABLE device_identity_keys ADD COLUMN signed_prekey_id INT NOT NULL DEFAULT 0;
