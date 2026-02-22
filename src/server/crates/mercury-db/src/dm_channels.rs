use mercury_core::ids::{DmChannelId, UserId};
use mercury_core::models::{DmChannel, DmMember};
use sqlx::PgPool;

/// A DM channel with info about the other participant.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DmChannelWithRecipient {
    pub id: DmChannelId,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
    pub recipient_id: UserId,
    pub recipient_username: String,
    pub recipient_display_name: String,
    pub recipient_avatar_url: Option<String>,
}

/// Get or create a DM channel between two users.
/// Returns the existing channel if one exists, otherwise creates a new one.
pub async fn get_or_create_dm_channel(
    pool: &PgPool,
    user_a: UserId,
    user_b: UserId,
) -> Result<DmChannel, sqlx::Error> {
    // Check if a DM channel already exists between these two users
    let existing: Option<(DmChannelId,)> = sqlx::query_as(
        r#"
        SELECT dm.dm_channel_id
        FROM dm_members dm
        WHERE dm.user_id = $1
          AND dm.dm_channel_id IN (
            SELECT dm2.dm_channel_id FROM dm_members dm2 WHERE dm2.user_id = $2
          )
        LIMIT 1
        "#,
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_optional(pool)
    .await?;

    if let Some((dm_channel_id,)) = existing {
        let channel = sqlx::query_as::<_, DmChannel>(
            "SELECT * FROM dm_channels WHERE id = $1",
        )
        .bind(dm_channel_id)
        .fetch_one(pool)
        .await?;
        return Ok(channel);
    }

    // Create new DM channel in a transaction
    let mut tx = pool.begin().await?;

    let channel_id = DmChannelId::new();
    let channel = sqlx::query_as::<_, DmChannel>(
        "INSERT INTO dm_channels (id) VALUES ($1) RETURNING *",
    )
    .bind(channel_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO dm_members (dm_channel_id, user_id) VALUES ($1, $2)")
        .bind(channel_id)
        .bind(user_a)
        .execute(&mut *tx)
        .await?;

    sqlx::query("INSERT INTO dm_members (dm_channel_id, user_id) VALUES ($1, $2)")
        .bind(channel_id)
        .bind(user_b)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(channel)
}

/// List all DM channels for a user, including the other participant's info.
pub async fn list_dm_channels_for_user(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Vec<DmChannelWithRecipient>, sqlx::Error> {
    sqlx::query_as::<_, DmChannelWithRecipient>(
        r#"
        SELECT
            dc.id,
            dc.created_at,
            u.id AS recipient_id,
            u.username AS recipient_username,
            u.display_name AS recipient_display_name,
            u.avatar_url AS recipient_avatar_url
        FROM dm_channels dc
        INNER JOIN dm_members dm1 ON dc.id = dm1.dm_channel_id AND dm1.user_id = $1
        INNER JOIN dm_members dm2 ON dc.id = dm2.dm_channel_id AND dm2.user_id != $1
        INNER JOIN users u ON dm2.user_id = u.id
        ORDER BY dc.created_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

/// Check if a user is a member of a DM channel.
pub async fn is_dm_member(
    pool: &PgPool,
    user_id: UserId,
    dm_channel_id: DmChannelId,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 as n FROM dm_members WHERE user_id = $1 AND dm_channel_id = $2",
    )
    .bind(user_id)
    .bind(dm_channel_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Get a DM channel by ID.
pub async fn get_dm_channel_by_id(
    pool: &PgPool,
    id: DmChannelId,
) -> Result<Option<DmChannel>, sqlx::Error> {
    sqlx::query_as::<_, DmChannel>("SELECT * FROM dm_channels WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Get the members of a DM channel.
pub async fn get_dm_members(
    pool: &PgPool,
    dm_channel_id: DmChannelId,
) -> Result<Vec<DmMember>, sqlx::Error> {
    sqlx::query_as::<_, DmMember>(
        "SELECT * FROM dm_members WHERE dm_channel_id = $1",
    )
    .bind(dm_channel_id)
    .fetch_all(pool)
    .await
}
