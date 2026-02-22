use mercury_core::ids::{ChannelId, DeviceId, DmChannelId, MessageId, UserId};
use mercury_core::models::{Message, MessageRecipient};
use sqlx::PgPool;

pub async fn create_message<'e, E>(
    executor: E,
    id: MessageId,
    channel_id: ChannelId,
    sender_id: UserId,
    content: Option<&str>,
) -> Result<Message, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query_as::<_, Message>(
        r#"
        INSERT INTO messages (id, channel_id, sender_id, content)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(channel_id)
    .bind(sender_id)
    .bind(content)
    .fetch_one(executor)
    .await
}

/// Cursor-based pagination for channel messages.
///
/// - `before`: fetch messages older than this ID (scrolling up)
/// - `after`: fetch messages newer than this ID (scrolling down)
/// - `limit`: max messages to return (capped at 100)
///
/// Returns messages ordered by created_at DESC (newest first) when using `before` or no cursor,
/// and by created_at ASC (oldest first) when using `after`.
pub async fn get_messages_paginated(
    pool: &PgPool,
    channel_id: ChannelId,
    before: Option<MessageId>,
    after: Option<MessageId>,
    limit: i64,
) -> Result<Vec<Message>, sqlx::Error> {
    let limit = limit.min(100);

    match (before, after) {
        (Some(before_id), _) => {
            sqlx::query_as::<_, Message>(
                r#"
                SELECT m.* FROM messages m
                WHERE m.channel_id = $1
                  AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
                ORDER BY m.created_at DESC
                LIMIT $3
                "#,
            )
            .bind(channel_id)
            .bind(before_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        (None, Some(after_id)) => {
            sqlx::query_as::<_, Message>(
                r#"
                SELECT m.* FROM messages m
                WHERE m.channel_id = $1
                  AND m.created_at > (SELECT created_at FROM messages WHERE id = $2)
                ORDER BY m.created_at ASC
                LIMIT $3
                "#,
            )
            .bind(channel_id)
            .bind(after_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        (None, None) => {
            // No cursor — return most recent messages
            sqlx::query_as::<_, Message>(
                r#"
                SELECT m.* FROM messages m
                WHERE m.channel_id = $1
                ORDER BY m.created_at DESC
                LIMIT $2
                "#,
            )
            .bind(channel_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
    }
}

/// Create a message in a DM channel (content is NULL for E2E DMs).
pub async fn create_dm_message<'e, E>(
    executor: E,
    id: MessageId,
    dm_channel_id: DmChannelId,
    sender_id: UserId,
) -> Result<Message, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query_as::<_, Message>(
        r#"
        INSERT INTO messages (id, dm_channel_id, sender_id)
        VALUES ($1, $2, $3)
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(dm_channel_id)
    .bind(sender_id)
    .fetch_one(executor)
    .await
}

/// Insert a per-device ciphertext row for an E2E message.
pub async fn create_message_recipient<'e, E>(
    executor: E,
    message_id: MessageId,
    device_id: Option<DeviceId>,
    ciphertext: &[u8],
    x3dh_header: Option<&[u8]>,
) -> Result<MessageRecipient, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query_as::<_, MessageRecipient>(
        r#"
        INSERT INTO message_recipients (message_id, device_id, ciphertext, x3dh_header)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        "#,
    )
    .bind(message_id)
    .bind(device_id)
    .bind(ciphertext)
    .bind(x3dh_header)
    .fetch_one(executor)
    .await
}

/// Message with its associated ciphertext for a specific device (E2E DMs).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DmMessageRow {
    pub id: MessageId,
    pub dm_channel_id: Option<DmChannelId>,
    pub sender_id: UserId,
    pub message_type: Option<String>,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
    pub edited_at: Option<chrono::DateTime<chrono::Utc>>,
    pub ciphertext: Vec<u8>,
    pub x3dh_header: Option<Vec<u8>>,
}

/// Fetch DM message history filtered by device_id.
/// Returns messages with the ciphertext row for the requesting device only.
pub async fn get_dm_messages_paginated(
    pool: &PgPool,
    dm_channel_id: DmChannelId,
    device_id: DeviceId,
    before: Option<MessageId>,
    after: Option<MessageId>,
    limit: i64,
) -> Result<Vec<DmMessageRow>, sqlx::Error> {
    let limit = limit.min(100);

    match (before, after) {
        (Some(before_id), _) => {
            sqlx::query_as::<_, DmMessageRow>(
                r#"
                SELECT m.id, m.dm_channel_id, m.sender_id, m.message_type,
                       m.created_at, m.edited_at,
                       mr.ciphertext, mr.x3dh_header
                FROM messages m
                INNER JOIN message_recipients mr ON mr.message_id = m.id AND mr.device_id = $2
                WHERE m.dm_channel_id = $1
                  AND m.created_at < (SELECT created_at FROM messages WHERE id = $3)
                ORDER BY m.created_at DESC
                LIMIT $4
                "#,
            )
            .bind(dm_channel_id)
            .bind(device_id)
            .bind(before_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        (None, Some(after_id)) => {
            sqlx::query_as::<_, DmMessageRow>(
                r#"
                SELECT m.id, m.dm_channel_id, m.sender_id, m.message_type,
                       m.created_at, m.edited_at,
                       mr.ciphertext, mr.x3dh_header
                FROM messages m
                INNER JOIN message_recipients mr ON mr.message_id = m.id AND mr.device_id = $2
                WHERE m.dm_channel_id = $1
                  AND m.created_at > (SELECT created_at FROM messages WHERE id = $3)
                ORDER BY m.created_at ASC
                LIMIT $4
                "#,
            )
            .bind(dm_channel_id)
            .bind(device_id)
            .bind(after_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        (None, None) => {
            sqlx::query_as::<_, DmMessageRow>(
                r#"
                SELECT m.id, m.dm_channel_id, m.sender_id, m.message_type,
                       m.created_at, m.edited_at,
                       mr.ciphertext, mr.x3dh_header
                FROM messages m
                INNER JOIN message_recipients mr ON mr.message_id = m.id AND mr.device_id = $2
                WHERE m.dm_channel_id = $1
                ORDER BY m.created_at DESC
                LIMIT $3
                "#,
            )
            .bind(dm_channel_id)
            .bind(device_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
    }
}

/// Create a sender key distribution message (message_type = 'sender_key_dist').
/// Used for offline delivery of SenderKey distributions to target devices.
pub async fn create_sender_key_distribution_message<'e, E>(
    executor: E,
    id: MessageId,
    channel_id: ChannelId,
    sender_id: UserId,
) -> Result<Message, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query_as::<_, Message>(
        r#"
        INSERT INTO messages (id, channel_id, sender_id, message_type)
        VALUES ($1, $2, $3, 'sender_key_dist')
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(channel_id)
    .bind(sender_id)
    .fetch_one(executor)
    .await
}

/// Row returned by pending sender key distribution queries.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PendingSenderKeyRow {
    pub message_id: MessageId,
    pub channel_id: Option<ChannelId>,
    pub sender_id: UserId,
    pub ciphertext: Vec<u8>,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Fetch pending sender key distributions for a specific device.
/// Returns distributions from message_recipients where the message has
/// message_type = 'sender_key_dist' and the recipient device_id matches.
pub async fn get_pending_sender_key_distributions(
    pool: &PgPool,
    device_id: DeviceId,
) -> Result<Vec<PendingSenderKeyRow>, sqlx::Error> {
    sqlx::query_as::<_, PendingSenderKeyRow>(
        r#"
        SELECT m.id AS message_id, m.channel_id, m.sender_id,
               mr.ciphertext, m.created_at
        FROM messages m
        INNER JOIN message_recipients mr ON mr.message_id = m.id AND mr.device_id = $1
        WHERE m.message_type = 'sender_key_dist'
        ORDER BY m.created_at ASC
        "#,
    )
    .bind(device_id)
    .fetch_all(pool)
    .await
}

/// Delete sender key distribution messages by their IDs.
/// Uses CASCADE to also remove the message_recipients rows.
pub async fn delete_sender_key_distributions(
    pool: &PgPool,
    message_ids: &[MessageId],
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM messages
        WHERE id = ANY($1) AND message_type = 'sender_key_dist'
        "#,
    )
    .bind(message_ids)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Message with broadcast ciphertext for private channels (Sender Keys).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PrivateChannelMessageRow {
    pub id: MessageId,
    pub channel_id: Option<ChannelId>,
    pub sender_id: UserId,
    pub message_type: Option<String>,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
    pub edited_at: Option<chrono::DateTime<chrono::Utc>>,
    pub ciphertext: Vec<u8>,
}

/// Fetch private channel message history (broadcast ciphertexts, device_id IS NULL).
pub async fn get_private_channel_messages_paginated(
    pool: &PgPool,
    channel_id: ChannelId,
    before: Option<MessageId>,
    after: Option<MessageId>,
    limit: i64,
) -> Result<Vec<PrivateChannelMessageRow>, sqlx::Error> {
    let limit = limit.min(100);

    match (before, after) {
        (Some(before_id), _) => {
            sqlx::query_as::<_, PrivateChannelMessageRow>(
                r#"
                SELECT m.id, m.channel_id, m.sender_id, m.message_type,
                       m.created_at, m.edited_at,
                       mr.ciphertext
                FROM messages m
                INNER JOIN message_recipients mr ON mr.message_id = m.id AND mr.device_id IS NULL
                WHERE m.channel_id = $1
                  AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
                ORDER BY m.created_at DESC
                LIMIT $3
                "#,
            )
            .bind(channel_id)
            .bind(before_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        (None, Some(after_id)) => {
            sqlx::query_as::<_, PrivateChannelMessageRow>(
                r#"
                SELECT m.id, m.channel_id, m.sender_id, m.message_type,
                       m.created_at, m.edited_at,
                       mr.ciphertext
                FROM messages m
                INNER JOIN message_recipients mr ON mr.message_id = m.id AND mr.device_id IS NULL
                WHERE m.channel_id = $1
                  AND m.created_at > (SELECT created_at FROM messages WHERE id = $2)
                ORDER BY m.created_at ASC
                LIMIT $3
                "#,
            )
            .bind(channel_id)
            .bind(after_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        (None, None) => {
            sqlx::query_as::<_, PrivateChannelMessageRow>(
                r#"
                SELECT m.id, m.channel_id, m.sender_id, m.message_type,
                       m.created_at, m.edited_at,
                       mr.ciphertext
                FROM messages m
                INNER JOIN message_recipients mr ON mr.message_id = m.id AND mr.device_id IS NULL
                WHERE m.channel_id = $1
                ORDER BY m.created_at DESC
                LIMIT $2
                "#,
            )
            .bind(channel_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
    }
}
