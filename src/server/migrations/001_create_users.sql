-- CONVENTION: All UUID primary keys are generated as UUIDv7 (time-sortable) in the
-- Rust application layer using uuid::Uuid::now_v7(). No DEFAULT gen_random_uuid() —
-- the database never auto-generates IDs. This ensures B-tree index locality (inserts
-- are always at the end of the index) and prevents page fragmentation at high volume.

CREATE TABLE users (
    id              UUID PRIMARY KEY,
    username        VARCHAR(32) UNIQUE NOT NULL,
    display_name    VARCHAR(64) NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,                    -- Argon2id hash
    avatar_url      TEXT,
    status          VARCHAR(16) DEFAULT 'offline',    -- online, idle, dnd, offline
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_users_username ON users (username);
CREATE INDEX idx_users_email ON users (email);
