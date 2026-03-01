-- Add DM policy column to users table
ALTER TABLE users ADD COLUMN dm_policy VARCHAR(16) DEFAULT 'anyone';
