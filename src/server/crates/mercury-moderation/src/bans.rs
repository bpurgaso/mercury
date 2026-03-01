use chrono::{DateTime, Utc};
use fred::prelude::*;
use mercury_core::ids::{ServerId, UserId};
use mercury_core::models::ServerBan;
use sqlx::PgPool;

/// Ban a user from a server.
pub async fn ban_user(
    pool: &PgPool,
    redis: &RedisClient,
    server_id: ServerId,
    user_id: UserId,
    banned_by: UserId,
    reason: Option<&str>,
    expires_at: Option<DateTime<Utc>>,
) -> Result<ServerBan, sqlx::Error> {
    let ban = sqlx::query_as::<_, ServerBan>(
        r#"
        INSERT INTO server_bans (server_id, user_id, banned_by, reason, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (server_id, user_id) DO UPDATE
            SET banned_by = $3, reason = $4, expires_at = $5, created_at = now()
        RETURNING *
        "#,
    )
    .bind(server_id)
    .bind(user_id)
    .bind(banned_by)
    .bind(reason)
    .bind(expires_at)
    .fetch_one(pool)
    .await?;

    // Remove from server_members
    sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2")
        .bind(server_id)
        .bind(user_id)
        .execute(pool)
        .await?;

    // Set Redis cache
    cache_ban(redis, server_id, user_id, expires_at).await;

    Ok(ban)
}

/// Unban a user from a server.
pub async fn unban_user(
    pool: &PgPool,
    redis: &RedisClient,
    server_id: ServerId,
    user_id: UserId,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM server_bans WHERE server_id = $1 AND user_id = $2")
        .bind(server_id)
        .bind(user_id)
        .execute(pool)
        .await?;

    // Remove from Redis
    let key = format!("banned:{}:{}", server_id, user_id);
    let _: () = redis.del(&key).await.unwrap_or(());

    Ok(result.rows_affected() > 0)
}

/// List bans for a server (paginated).
pub async fn list_bans(
    pool: &PgPool,
    server_id: ServerId,
    limit: i64,
    offset: i64,
) -> Result<Vec<ServerBan>, sqlx::Error> {
    sqlx::query_as::<_, ServerBan>(
        "SELECT * FROM server_bans WHERE server_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(server_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

/// Short TTL for negative cache entries (not banned / not muted).
const NEGATIVE_CACHE_TTL_SECS: i64 = 30;

/// Sentinel value stored in Redis to indicate "checked DB, user is NOT banned".
const NOT_BANNED_SENTINEL: &str = "__not_banned__";

/// Check if a user is banned from a server (Redis fast path, DB fallback).
pub async fn is_banned(
    pool: &PgPool,
    redis: &RedisClient,
    server_id: ServerId,
    user_id: UserId,
) -> bool {
    let key = format!("banned:{}:{}", server_id, user_id);

    // Check Redis first
    match redis.get::<Option<String>, _>(&key).await {
        Ok(Some(val)) => {
            if val == NOT_BANNED_SENTINEL {
                return false; // Negative cache hit
            }
            return true; // Positive cache hit
        }
        Ok(None) => {} // Cache miss — fall through to DB
        Err(_) => {}
    }

    // Fallback to DB
    let row: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1 as n FROM server_bans
        WHERE server_id = $1 AND user_id = $2
        AND (expires_at IS NULL OR expires_at > now())
        "#,
    )
    .bind(server_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    if row.is_some() {
        // Re-cache positive result in Redis
        let ban: Option<ServerBan> = sqlx::query_as::<_, ServerBan>(
            "SELECT * FROM server_bans WHERE server_id = $1 AND user_id = $2",
        )
        .bind(server_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        if let Some(ban) = ban {
            cache_ban(redis, server_id, user_id, ban.expires_at).await;
        }
        true
    } else {
        // Cache negative result with short TTL
        let _: () = redis
            .set(
                &key,
                NOT_BANNED_SENTINEL,
                Some(Expiration::EX(NEGATIVE_CACHE_TTL_SECS)),
                None,
                false,
            )
            .await
            .unwrap_or(());
        false
    }
}

/// Clean up expired bans (called periodically).
pub async fn cleanup_expired_bans(pool: &PgPool, redis: &RedisClient) -> Result<u64, sqlx::Error> {
    let expired: Vec<ServerBan> = sqlx::query_as::<_, ServerBan>(
        "DELETE FROM server_bans WHERE expires_at IS NOT NULL AND expires_at < now() RETURNING *",
    )
    .fetch_all(pool)
    .await?;

    let count = expired.len() as u64;
    for ban in &expired {
        let key = format!("banned:{}:{}", ban.server_id, ban.user_id);
        let _: () = redis.del(&key).await.unwrap_or(());
    }

    if count > 0 {
        tracing::info!("cleaned up {count} expired bans");
    }

    Ok(count)
}

/// Set ban entry in Redis cache with appropriate TTL.
async fn cache_ban(
    redis: &RedisClient,
    server_id: ServerId,
    user_id: UserId,
    expires_at: Option<DateTime<Utc>>,
) {
    let key = format!("banned:{}:{}", server_id, user_id);
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
        // Permanent ban — no TTL
        let _: () = redis.set(&key, &value, None, None, false).await.unwrap_or(());
    }
}
