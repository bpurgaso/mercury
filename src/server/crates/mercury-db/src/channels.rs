use mercury_core::ids::{ChannelId, ServerId};
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
    user_id: mercury_core::ids::UserId,
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
