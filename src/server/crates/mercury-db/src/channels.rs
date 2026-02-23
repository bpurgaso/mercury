use mercury_core::ids::{ChannelId, ServerId, UserId};
use mercury_core::models::Channel;
use sqlx::PgPool;

pub async fn create_channel(
    pool: &PgPool,
    id: ChannelId,
    server_id: ServerId,
    name: &str,
    channel_type: &str,
    encryption_mode: &str,
) -> Result<Channel, sqlx::Error> {
    sqlx::query_as::<_, Channel>(
        r#"
        INSERT INTO channels (id, server_id, name, channel_type, encryption_mode)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(server_id)
    .bind(name)
    .bind(channel_type)
    .bind(encryption_mode)
    .fetch_one(pool)
    .await
}

pub async fn get_channel_by_id(
    pool: &PgPool,
    id: ChannelId,
) -> Result<Option<Channel>, sqlx::Error> {
    sqlx::query_as::<_, Channel>("SELECT * FROM channels WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn list_channels_for_server(
    pool: &PgPool,
    server_id: ServerId,
) -> Result<Vec<Channel>, sqlx::Error> {
    sqlx::query_as::<_, Channel>(
        r#"
        SELECT * FROM channels
        WHERE server_id = $1
        ORDER BY position ASC, created_at ASC
        "#,
    )
    .bind(server_id)
    .fetch_all(pool)
    .await
}

pub async fn update_channel_name(
    pool: &PgPool,
    id: ChannelId,
    name: &str,
) -> Result<Option<Channel>, sqlx::Error> {
    sqlx::query_as::<_, Channel>(
        r#"
        UPDATE channels SET name = $2
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(name)
    .fetch_optional(pool)
    .await
}

pub async fn delete_channel(pool: &PgPool, id: ChannelId) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// List all channels across all servers a user is a member of.
pub async fn list_channels_for_user(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Vec<Channel>, sqlx::Error> {
    sqlx::query_as::<_, Channel>(
        r#"
        SELECT c.* FROM channels c
        INNER JOIN server_members sm ON c.server_id = sm.server_id
        WHERE sm.user_id = $1
        ORDER BY c.server_id, c.position ASC, c.created_at ASC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

// ── Channel Membership (private channels) ──────────────────

/// Add a user as a member of a private channel.
pub async fn add_channel_member(
    pool: &PgPool,
    channel_id: ChannelId,
    user_id: UserId,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO channel_members (channel_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(channel_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Add all current server members to a channel (used when creating a private channel).
pub async fn add_all_server_members_to_channel(
    pool: &PgPool,
    channel_id: ChannelId,
    server_id: ServerId,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO channel_members (channel_id, user_id)
        SELECT $1, user_id FROM server_members WHERE server_id = $2
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(channel_id)
    .bind(server_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Add a user to all private channels in a server (used when a new member joins).
pub async fn add_member_to_server_private_channels(
    pool: &PgPool,
    user_id: UserId,
    server_id: ServerId,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO channel_members (channel_id, user_id)
        SELECT id, $1 FROM channels WHERE server_id = $2 AND encryption_mode = 'private'
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(user_id)
    .bind(server_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove a user from all channels in a server (used when leaving a server).
pub async fn remove_member_from_server_channels(
    pool: &PgPool,
    user_id: UserId,
    server_id: ServerId,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        DELETE FROM channel_members
        WHERE user_id = $1
          AND channel_id IN (SELECT id FROM channels WHERE server_id = $2)
        "#,
    )
    .bind(user_id)
    .bind(server_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Check if a user is a member of a specific channel.
pub async fn is_channel_member(
    pool: &PgPool,
    user_id: UserId,
    channel_id: ChannelId,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 as n FROM channel_members WHERE user_id = $1 AND channel_id = $2",
    )
    .bind(user_id)
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Get all user IDs that are members of a specific channel.
pub async fn get_channel_member_user_ids(
    pool: &PgPool,
    channel_id: ChannelId,
) -> Result<Vec<UserId>, sqlx::Error> {
    let rows: Vec<(UserId,)> =
        sqlx::query_as("SELECT user_id FROM channel_members WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Increment sender_key_epoch for all private channels in a server.
/// Called when a member leaves/is kicked to trigger lazy re-keying.
pub async fn increment_epoch_for_server_private_channels(
    pool: &PgPool,
    server_id: ServerId,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        UPDATE channels
        SET sender_key_epoch = sender_key_epoch + 1
        WHERE server_id = $1 AND encryption_mode = 'private'
        "#,
    )
    .bind(server_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}
