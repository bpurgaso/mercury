-- Add x3dh_header column for storing X3DH key exchange headers alongside DM ciphertexts.
-- NULL for non-DM messages and for DM messages after the first in a session.
ALTER TABLE message_recipients ADD COLUMN x3dh_header BYTEA;
