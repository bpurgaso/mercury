-- User-level blocks (client-driven, server-enforced)
CREATE TABLE user_blocks (
    blocker_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

-- Server-level bans
CREATE TABLE server_bans (
    server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by       UUID NOT NULL REFERENCES users(id),
    reason          TEXT,                              -- Plaintext (operator-visible only)
    expires_at      TIMESTAMPTZ,                       -- NULL = permanent
    created_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (server_id, user_id)
);

CREATE INDEX idx_bans_expiry ON server_bans (expires_at) WHERE expires_at IS NOT NULL;

-- Channel-level mutes (user cannot send in channel for duration)
CREATE TABLE channel_mutes (
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_by        UUID NOT NULL REFERENCES users(id),
    reason          TEXT,
    expires_at      TIMESTAMPTZ,                       -- NULL = permanent
    created_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

-- Content reports (user-submitted, references opaque message IDs)
CREATE TABLE reports (
    id              UUID PRIMARY KEY,
    reporter_id     UUID NOT NULL REFERENCES users(id),
    reported_user_id UUID NOT NULL REFERENCES users(id),
    server_id       UUID REFERENCES servers(id),
    channel_id      UUID REFERENCES channels(id),
    message_id      UUID,                              -- Reference to reported message
    category        VARCHAR(32) NOT NULL,              -- 'spam', 'harassment', 'illegal', 'csam', 'other'
    description     TEXT,                              -- Reporter's description (plaintext)
    evidence_blob   BYTEA,                             -- Optional: forwarded decrypted content (encrypted to server operator's public key)
    status          VARCHAR(16) DEFAULT 'pending',     -- 'pending', 'reviewed', 'actioned', 'dismissed'
    reviewed_by     UUID REFERENCES users(id),
    reviewed_at     TIMESTAMPTZ,
    action_taken    VARCHAR(32),                       -- 'none', 'warn', 'mute', 'kick', 'ban', 'escalate'
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_reports_status ON reports (status, created_at DESC);
CREATE INDEX idx_reports_server ON reports (server_id, status);
CREATE INDEX idx_reports_user ON reports (reported_user_id);

-- Moderation audit log (append-only, immutable)
CREATE TABLE mod_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    moderator_id    UUID NOT NULL REFERENCES users(id),
    action          VARCHAR(32) NOT NULL,              -- 'ban', 'unban', 'kick', 'mute', 'unmute', 'report_review', 'warn'
    target_user_id  UUID NOT NULL REFERENCES users(id),
    target_channel_id UUID REFERENCES channels(id),
    reason          TEXT,
    metadata        JSONB,                             -- Action-specific extra data
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_server ON mod_audit_log (server_id, created_at DESC);
CREATE INDEX idx_audit_target ON mod_audit_log (target_user_id, created_at DESC);

-- Metadata abuse signals (server-computed, no content access needed)
CREATE TABLE abuse_signals (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id),
    signal_type     VARCHAR(32) NOT NULL,              -- 'rapid_messaging', 'mass_dm', 'join_spam', 'report_threshold'
    severity        VARCHAR(16) DEFAULT 'low',         -- 'low', 'medium', 'high', 'critical'
    details         JSONB NOT NULL,                    -- Signal-specific metrics
    auto_action     VARCHAR(32),                       -- Action taken automatically, if any
    reviewed        BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_abuse_signals_user ON abuse_signals (user_id, created_at DESC);
CREATE INDEX idx_abuse_signals_unreviewed ON abuse_signals (reviewed, severity) WHERE NOT reviewed;
