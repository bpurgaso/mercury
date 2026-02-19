use mercury_core::ids::{ChannelId, MessageId, UserId};
use mercury_core::models::Message;
use sqlx::PgPool;

pub async fn create_message(
    pool: &PgPool,
    id: MessageId,
    channel_id: ChannelId,
    sender_id: UserId,
    content: Option<&str>,
) -> Result<Message, sqlx::Error> {
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
    .fetch_one(pool)
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
