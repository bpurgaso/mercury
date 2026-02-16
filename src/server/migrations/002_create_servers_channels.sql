CREATE TABLE servers (
    id              UUID PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    icon_url        TEXT,
    owner_id        UUID NOT NULL REFERENCES users(id),
    invite_code     VARCHAR(16) UNIQUE NOT NULL,
    max_members     INT DEFAULT 5000,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE channels (
    id              UUID PRIMARY KEY,
    server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    channel_type    VARCHAR(16) NOT NULL,              -- 'text', 'voice', 'video'
    encryption_mode VARCHAR(16) NOT NULL DEFAULT 'standard',  -- 'standard', 'private', 'e2e_dm'
    -- standard: server-readable, full history, searchable
    -- private:  E2E encrypted (Sender Keys), max 100 members, history from join only
    -- e2e_dm:   E2E encrypted (Double Ratchet), for DM channels only
    sender_key_epoch BIGINT NOT NULL DEFAULT 0,        -- Incremented on member leave/kick; triggers lazy re-key
    max_members     INT,                               -- NULL = server default; private channels enforced <= 100
    topic           TEXT,
    position        INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(server_id, name),
    CHECK (encryption_mode != 'private' OR max_members <= 100)
);

CREATE TABLE server_members (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    nickname        VARCHAR(64),
    is_moderator    BOOLEAN NOT NULL DEFAULT FALSE,      -- MVP moderator delegation (owner can promote)
    joined_at       TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, server_id)
);
