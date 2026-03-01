use chrono::{DateTime, Utc};
use fred::prelude::*;
use mercury_core::ids::{ChannelId, UserId};
use mercury_core::models::ChannelMute;
use sqlx::PgPool;

/// Mute a user in a channel.
pub async fn mute_user(
    pool: &PgPool,
    redis: &RedisClient,
    channel_id: ChannelId,
    user_id: UserId,
    muted_by: UserId,
    reason: Option<&str>,
    expires_at: Option<DateTime<Utc>>,
) -> Result<ChannelMute, sqlx::Error> {
    let mute = sqlx::query_as::<_, ChannelMute>(
        r#"
        INSERT INTO channel_mutes (channel_id, user_id, muted_by, reason, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (channel_id, user_id) DO UPDATE
            SET muted_by = $3, reason = $4, expires_at = $5, created_at = now()
        RETURNING *
        "#,
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(muted_by)
    .bind(reason)
    .bind(expires_at)
    .fetch_one(pool)
    .await?;

    // Set Redis cache
    cache_mute(redis, channel_id, user_id, expires_at).await;

    Ok(mute)
}

/// Unmute a user in a channel.
pub async fn unmute_user(
    pool: &PgPool,
    redis: &RedisClient,
    channel_id: ChannelId,
    user_id: UserId,
) -> Result<bool, sqlx::Error> {
    let result =
        sqlx::query("DELETE FROM channel_mutes WHERE channel_id = $1 AND user_id = $2")
            .bind(channel_id)
            .bind(user_id)
            .execute(pool)
            .await?;

    let key = format!("muted:{}:{}", channel_id, user_id);
    let _: () = redis.del(&key).await.unwrap_or(());

    Ok(result.rows_affected() > 0)
}

/// Check if a user is muted in a channel (Redis fast path).
pub async fn is_muted(
    pool: &PgPool,
    redis: &RedisClient,
    channel_id: ChannelId,
    user_id: UserId,
) -> bool {
    let key = format!("muted:{}:{}", channel_id, user_id);

    // Check Redis first
    match redis.exists::<bool, _>(&key).await {
        Ok(true) => return true,
        Ok(false) => {}
        Err(_) => {}
    }

    // Fallback to DB
    let row: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1 as n FROM channel_mutes
        WHERE channel_id = $1 AND user_id = $2
        AND (expires_at IS NULL OR expires_at > now())
        "#,
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    if row.is_some() {
        // Re-cache
        let mute: Option<ChannelMute> = sqlx::query_as::<_, ChannelMute>(
            "SELECT * FROM channel_mutes WHERE channel_id = $1 AND user_id = $2",
        )
        .bind(channel_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        if let Some(mute) = mute {
            cache_mute(redis, channel_id, user_id, mute.expires_at).await;
        }
        true
    } else {
        false
    }
}

/// Set mute entry in Redis cache with appropriate TTL.
async fn cache_mute(
    redis: &RedisClient,
    channel_id: ChannelId,
    user_id: UserId,
    expires_at: Option<DateTime<Utc>>,
) {
    let key = format!("muted:{}:{}", channel_id, user_id);
    let value = serde_json::json!({
        "expires_at": expires_at.map(|t| t.to_rfc3339()),
    })
    .to_string();

    if let Some(expires) = expires_at {
        let ttl = (expires - Utc::now()).num_seconds().max(1) as i64;
        let _: () = redis
            .set(&key, &value, Some(Expiration::EX(ttl)), None, false)
            .await
            .unwrap_or(());
    } else {
        let _: () = redis.set(&key, &value, None, None, false).await.unwrap_or(());
    }
}
