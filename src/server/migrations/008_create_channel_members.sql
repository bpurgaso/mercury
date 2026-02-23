-- Channel-level membership for private channels.
-- Standard channels use server membership; private channels require explicit channel membership.
CREATE TABLE IF NOT EXISTS channel_members (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);
