use fred::prelude::*;
use mercury_core::ids::UserId;
use mercury_core::models::UserBlock;
use sqlx::PgPool;

/// Add a user block.
pub async fn block_user(
    pool: &PgPool,
    redis: &RedisClient,
    blocker_id: UserId,
    blocked_id: UserId,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(blocker_id)
    .bind(blocked_id)
    .execute(pool)
    .await?;

    // Update Redis cache
    let key = format!("blocked:{}", blocker_id);
    let _: () = redis.sadd(&key, blocked_id.0.to_string()).await.unwrap_or(());

    Ok(())
}

/// Remove a user block.
pub async fn unblock_user(
    pool: &PgPool,
    redis: &RedisClient,
    blocker_id: UserId,
    blocked_id: UserId,
) -> Result<bool, sqlx::Error> {
    let result =
        sqlx::query("DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2")
            .bind(blocker_id)
            .bind(blocked_id)
            .execute(pool)
            .await?;

    // Update Redis cache
    let key = format!("blocked:{}", blocker_id);
    let _: () = redis.srem(&key, blocked_id.0.to_string()).await.unwrap_or(());

    Ok(result.rows_affected() > 0)
}

/// List blocked user IDs (from DB, paginated).
pub async fn list_blocked_users(
    pool: &PgPool,
    blocker_id: UserId,
    limit: i64,
    offset: i64,
) -> Result<Vec<UserBlock>, sqlx::Error> {
    sqlx::query_as::<_, UserBlock>(
        "SELECT * FROM user_blocks WHERE blocker_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(blocker_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

/// Check if blocker has blocked the target (Redis fast path).
pub async fn is_blocked(redis: &RedisClient, blocker_id: UserId, target_id: UserId) -> bool {
    let key = format!("blocked:{}", blocker_id);
    redis
        .sismember::<bool, _, _>(&key, target_id.0.to_string())
        .await
        .unwrap_or(false)
}

/// Load the full block list into Redis (called on WebSocket identify).
pub async fn cache_block_list(
    pool: &PgPool,
    redis: &RedisClient,
    user_id: UserId,
) -> Result<(), sqlx::Error> {
    let blocks: Vec<(uuid::Uuid,)> = sqlx::query_as(
        "SELECT blocked_id FROM user_blocks WHERE blocker_id = $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let key = format!("blocked:{}", user_id);
    // Clear existing cache and repopulate
    let _: () = redis.del(&key).await.unwrap_or(());
    if !blocks.is_empty() {
        let ids: Vec<String> = blocks.iter().map(|(id,)| id.to_string()).collect();
        let _: () = redis.sadd(&key, ids).await.unwrap_or(());
    }

    Ok(())
}

/// Get DM policy for a user.
pub async fn get_dm_policy(pool: &PgPool, user_id: UserId) -> Result<String, sqlx::Error> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT dm_policy FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(row
        .and_then(|(p,)| p)
        .unwrap_or_else(|| "anyone".to_string()))
}

/// Set DM policy for a user.
pub async fn set_dm_policy(
    pool: &PgPool,
    user_id: UserId,
    policy: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE users SET dm_policy = $2 WHERE id = $1")
        .bind(user_id)
        .bind(policy)
        .execute(pool)
        .await?;
    Ok(())
}

/// Check if a DM is allowed based on recipient's policy.
/// Returns true if the DM should be allowed.
pub async fn check_dm_policy(
    pool: &PgPool,
    sender_id: UserId,
    recipient_id: UserId,
) -> Result<bool, sqlx::Error> {
    let policy = get_dm_policy(pool, recipient_id).await?;
    match policy.as_str() {
        "anyone" => Ok(true),
        "nobody" => Ok(false),
        "mutual_servers" => {
            // Check if they share at least one server
            let shared: Option<(i32,)> = sqlx::query_as(
                r#"
                SELECT 1 as n FROM server_members sm1
                INNER JOIN server_members sm2 ON sm1.server_id = sm2.server_id
                WHERE sm1.user_id = $1 AND sm2.user_id = $2
                LIMIT 1
                "#,
            )
            .bind(sender_id)
            .bind(recipient_id)
            .fetch_optional(pool)
            .await?;
            Ok(shared.is_some())
        }
        _ => Ok(true), // Default to allowing
    }
}
