-- Registered devices per user account
CREATE TABLE devices (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name     VARCHAR(64) NOT NULL,             -- "MacBook Pro", "Work Desktop"
    created_at      TIMESTAMPTZ DEFAULT now(),
    last_seen_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_devices_user ON devices (user_id);

-- Now that devices table exists, add FK constraint to message_recipients
ALTER TABLE message_recipients
    ADD CONSTRAINT fk_message_recipients_device
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;

-- X3DH key bundles — per DEVICE, not per user
-- Each device has its own identity key and pre-keys
CREATE TABLE device_identity_keys (
    device_id       UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_key    BYTEA NOT NULL,                   -- Device's public identity key (Ed25519/X25519)
    signed_prekey   BYTEA NOT NULL,                   -- Signed pre-key (public)
    prekey_signature BYTEA NOT NULL,                  -- Signature over signed_prekey by identity_key
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_device_ik_user ON device_identity_keys (user_id);

CREATE TABLE one_time_prekeys (
    id              BIGSERIAL PRIMARY KEY,
    device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_id          INT NOT NULL,
    prekey          BYTEA NOT NULL,                   -- One-time pre-key (public)
    used            BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(device_id, key_id)
);

CREATE INDEX idx_otp_available ON one_time_prekeys (device_id, used) WHERE NOT used;

-- Signed device list: user signs a list of their active device IDs + identity keys
-- Other users verify this signature to trust the device set
CREATE TABLE device_lists (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    signed_list     BYTEA NOT NULL,                   -- Signed JSON: { devices: [{ device_id, identity_key }], timestamp }
    master_verify_key BYTEA NOT NULL,                 -- Public master verification key (signs device lists)
    signature       BYTEA NOT NULL,                   -- Signature over signed_list by master_verify_key
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Encrypted key backup (for account recovery)
CREATE TABLE key_backups (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_backup BYTEA NOT NULL,                  -- Identity keys + ratchet state, encrypted with recovery key
    backup_version  INT NOT NULL DEFAULT 1,           -- Incremented on each backup update
    key_derivation_salt BYTEA NOT NULL,               -- Salt for HKDF (recovery key -> backup encryption key)
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);
