use fred::prelude::*;
use mercury_core::ids::UserId;
use serde::{Deserialize, Serialize};

/// Session data stored in Redis under `session:{jti}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub user_id: String,
    pub device_id: Option<String>,
    pub expires_at: i64,
    /// For access token sessions, the JTI of the paired refresh token.
    /// Used to revoke the refresh session on logout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_refresh_jti: Option<String>,
}

/// Store a session in Redis with the key `session:{jti}` and a TTL matching the token expiry.
pub async fn create_session(
    redis: &RedisClient,
    jti: &str,
    user_id: UserId,
    expires_at: i64,
    ttl_seconds: u64,
) -> Result<(), RedisError> {
    create_session_inner(redis, jti, user_id, expires_at, ttl_seconds, None).await
}

/// Store an access-token session that records the paired refresh token's JTI,
/// so logout can revoke both tokens.
pub async fn create_session_with_refresh_jti(
    redis: &RedisClient,
    jti: &str,
    user_id: UserId,
    expires_at: i64,
    ttl_seconds: u64,
    refresh_jti: &str,
) -> Result<(), RedisError> {
    create_session_inner(redis, jti, user_id, expires_at, ttl_seconds, Some(refresh_jti)).await
}

async fn create_session_inner(
    redis: &RedisClient,
    jti: &str,
    user_id: UserId,
    expires_at: i64,
    ttl_seconds: u64,
    paired_refresh_jti: Option<&str>,
) -> Result<(), RedisError> {
    let key = format!("session:{jti}");
    let data = SessionData {
        user_id: user_id.0.to_string(),
        device_id: None,
        expires_at,
        paired_refresh_jti: paired_refresh_jti.map(String::from),
    };
    let json =
        serde_json::to_string(&data).map_err(|e| RedisError::new(RedisErrorKind::Parse, e.to_string()))?;
    redis
        .set::<(), _, _>(&key, json, Some(Expiration::EX(ttl_seconds as i64)), None, false)
        .await?;
    Ok(())
}

/// Retrieve a session from Redis by its JWT ID.
pub async fn get_session(redis: &RedisClient, jti: &str) -> Result<Option<SessionData>, RedisError> {
    let key = format!("session:{jti}");
    let value: Option<String> = redis.get(&key).await?;
    match value {
        Some(json) => {
            let data: SessionData = serde_json::from_str(&json)
                .map_err(|e| RedisError::new(RedisErrorKind::Parse, e.to_string()))?;
            Ok(Some(data))
        }
        None => Ok(None),
    }
}

/// Delete a session from Redis (used for logout / token revocation).
pub async fn delete_session(redis: &RedisClient, jti: &str) -> Result<bool, RedisError> {
    let key = format!("session:{jti}");
    let deleted: i64 = redis.del(&key).await?;
    Ok(deleted > 0)
}
