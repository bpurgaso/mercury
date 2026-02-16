-- DM channels must be created before messages (messages FK references dm_channels)
CREATE TABLE dm_channels (
    id              UUID PRIMARY KEY,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE dm_members (
    dm_channel_id   UUID NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (dm_channel_id, user_id)
);

-- Messages table stores metadata for ALL messages and plaintext for standard channels.
-- E2E ciphertexts are stored in message_recipients (per-device for DMs, broadcast for Sender Keys).
-- This prevents clients from downloading N ciphertexts when only 1 is decryptable by their device.
CREATE TABLE messages (
    id              UUID PRIMARY KEY,
    channel_id      UUID REFERENCES channels(id) ON DELETE CASCADE,
    dm_channel_id   UUID REFERENCES dm_channels(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id),
    content         TEXT,                                -- Plaintext (standard channels only, NULL for E2E)
    message_type    VARCHAR(16) DEFAULT 'text',          -- 'text', 'system'
    created_at      TIMESTAMPTZ DEFAULT now(),
    edited_at       TIMESTAMPTZ,
    CHECK (
        (channel_id IS NOT NULL AND dm_channel_id IS NULL) OR
        (channel_id IS NULL AND dm_channel_id IS NOT NULL)
    )
);

CREATE INDEX idx_messages_channel ON messages (channel_id, created_at DESC);
CREATE INDEX idx_messages_dm ON messages (dm_channel_id, created_at DESC);

-- Per-device ciphertexts for E2E messages (DMs and private channels)
-- For DMs (Double Ratchet): one row per recipient device (per-device fan-out)
-- For private channels (Sender Keys): one row with device_id = NULL (any member can decrypt)
-- NOTE: FK to devices(id) is added in 004_create_devices_and_keys.sql after devices table exists
CREATE TABLE message_recipients (
    id              BIGSERIAL PRIMARY KEY,
    message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    device_id       UUID,                                -- NULL = broadcast (Sender Key)
    ciphertext      BYTEA NOT NULL,                      -- E2E encrypted payload for this device
    UNIQUE(message_id, device_id)
);

-- Critical index: history fetch only downloads ciphertexts for the requesting device
-- Query: WHERE message_id IN (...) AND (device_id = $current_device OR device_id IS NULL)
CREATE INDEX idx_msg_recipients_device ON message_recipients (device_id, message_id);
CREATE INDEX idx_msg_recipients_message ON message_recipients (message_id);
