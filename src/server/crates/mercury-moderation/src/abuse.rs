use fred::prelude::*;
use mercury_core::ids::UserId;
use mercury_core::models::AbuseSignal;
use sqlx::PgPool;

/// Insert a new abuse signal.
pub async fn create_signal(
    pool: &PgPool,
    user_id: UserId,
    signal_type: &str,
    severity: &str,
    details: serde_json::Value,
    auto_action: Option<&str>,
) -> Result<AbuseSignal, sqlx::Error> {
    sqlx::query_as::<_, AbuseSignal>(
        r#"
        INSERT INTO abuse_signals (user_id, signal_type, severity, details, auto_action)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        "#,
    )
    .bind(user_id)
    .bind(signal_type)
    .bind(severity)
    .bind(details)
    .bind(auto_action)
    .fetch_one(pool)
    .await
}

/// List abuse signals with optional filters.
pub async fn list_signals(
    pool: &PgPool,
    reviewed_filter: Option<bool>,
    severity_filter: Option<&str>,
    limit: i64,
) -> Result<Vec<AbuseSignal>, sqlx::Error> {
    let mut query = String::from("SELECT * FROM abuse_signals WHERE 1=1");
    let mut param_idx = 1;

    if reviewed_filter.is_some() {
        query.push_str(&format!(" AND reviewed = ${param_idx}"));
        param_idx += 1;
    }
    if severity_filter.is_some() {
        query.push_str(&format!(" AND severity = ${param_idx}"));
        param_idx += 1;
    }

    query.push_str(&format!(" ORDER BY created_at DESC LIMIT ${param_idx}"));

    let mut q = sqlx::query_as::<_, AbuseSignal>(&query);

    if let Some(r) = reviewed_filter {
        q = q.bind(r);
    }
    if let Some(s) = severity_filter {
        q = q.bind(s);
    }
    q = q.bind(limit);

    q.fetch_all(pool).await
}

/// Mark an abuse signal as reviewed.
pub async fn mark_reviewed(
    pool: &PgPool,
    signal_id: i64,
) -> Result<Option<AbuseSignal>, sqlx::Error> {
    sqlx::query_as::<_, AbuseSignal>(
        "UPDATE abuse_signals SET reviewed = true WHERE id = $1 RETURNING *",
    )
    .bind(signal_id)
    .fetch_optional(pool)
    .await
}

/// Get aggregate abuse stats for the last 24 hours.
pub async fn get_abuse_stats(pool: &PgPool) -> Result<AbuseStats, sqlx::Error> {
    let total: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM abuse_signals WHERE created_at > now() - interval '24 hours'",
    )
    .fetch_one(pool)
    .await?;

    let unreviewed: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM abuse_signals WHERE reviewed = false",
    )
    .fetch_one(pool)
    .await?;

    let by_type: Vec<(String, i64)> = sqlx::query_as(
        r#"
        SELECT signal_type, COUNT(*) as cnt
        FROM abuse_signals
        WHERE created_at > now() - interval '24 hours'
        GROUP BY signal_type
        "#,
    )
    .fetch_all(pool)
    .await?;

    let top_users: Vec<(UserId, i64)> = sqlx::query_as(
        r#"
        SELECT user_id, COUNT(*) as cnt
        FROM abuse_signals
        WHERE created_at > now() - interval '24 hours'
        GROUP BY user_id
        ORDER BY cnt DESC
        LIMIT 10
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut signals_by_type = serde_json::Map::new();
    for (st, cnt) in by_type {
        signals_by_type.insert(st, serde_json::Value::Number(cnt.into()));
    }

    let top_flagged_users: Vec<serde_json::Value> = top_users
        .into_iter()
        .map(|(uid, cnt)| {
            serde_json::json!({
                "user_id": uid.to_string(),
                "signal_count": cnt,
            })
        })
        .collect();

    Ok(AbuseStats {
        total_signals_24h: total.0,
        unreviewed_count: unreviewed.0,
        signals_by_type: serde_json::Value::Object(signals_by_type),
        top_flagged_users,
    })
}

#[derive(Debug, serde::Serialize)]
pub struct AbuseStats {
    pub total_signals_24h: i64,
    pub unreviewed_count: i64,
    pub signals_by_type: serde_json::Value,
    pub top_flagged_users: Vec<serde_json::Value>,
}

// ── Redis counter helpers for inline abuse tracking ──────────

/// Increment the message rate counter for a user (TTL 60s).
pub async fn increment_msg_rate(redis: &RedisClient, user_id: UserId) {
    let key = format!("abuse:msg_rate:{}", user_id);
    let count: u64 = redis.incr(&key).await.unwrap_or(0);
    // Set TTL only on first increment to avoid race conditions
    if count == 1 {
        let _: () = redis.expire(&key, 60).await.unwrap_or(());
    }
}

/// Increment the DM creation rate counter for a user (TTL 3600s).
pub async fn increment_dm_rate(redis: &RedisClient, user_id: UserId) {
    let key = format!("abuse:dm_rate:{}", user_id);
    let count: u64 = redis.incr(&key).await.unwrap_or(0);
    if count == 1 {
        let _: () = redis.expire(&key, 3600).await.unwrap_or(());
    }
}

/// Increment the server join rate counter for a user (TTL 3600s).
pub async fn increment_join_rate(redis: &RedisClient, user_id: UserId) {
    let key = format!("abuse:join_rate:{}", user_id);
    let count: u64 = redis.incr(&key).await.unwrap_or(0);
    if count == 1 {
        let _: () = redis.expire(&key, 3600).await.unwrap_or(());
    }
}

/// Get the current message rate counter.
pub async fn get_msg_rate(redis: &RedisClient, user_id: UserId) -> u64 {
    let key = format!("abuse:msg_rate:{}", user_id);
    redis.get(&key).await.unwrap_or(0)
}

/// Get the current DM rate counter.
pub async fn get_dm_rate(redis: &RedisClient, user_id: UserId) -> u64 {
    let key = format!("abuse:dm_rate:{}", user_id);
    redis.get(&key).await.unwrap_or(0)
}

/// Get the current join rate counter.
pub async fn get_join_rate(redis: &RedisClient, user_id: UserId) -> u64 {
    let key = format!("abuse:join_rate:{}", user_id);
    redis.get(&key).await.unwrap_or(0)
}

/// Get the current report count against a user.
pub async fn get_report_count(redis: &RedisClient, user_id: UserId) -> u64 {
    let key = format!("abuse:report_count:{}", user_id);
    redis.get(&key).await.unwrap_or(0)
}

/// Apply auto rate limit for rapid messaging.
pub async fn apply_rate_limit(redis: &RedisClient, user_id: UserId, cooldown_secs: i64) {
    // Use a wildcard key that is_rate_limited checks per-channel,
    // but the abuse auto-action applies globally via a special "global" key.
    let key = format!("rate_limited:{}:global", user_id);
    let _: () = redis
        .set(&key, "1", Some(Expiration::EX(cooldown_secs)), None, false)
        .await
        .unwrap_or(());
}

/// Check if a user is globally rate-limited (auto-action).
pub async fn is_globally_rate_limited(redis: &RedisClient, user_id: UserId) -> bool {
    let key = format!("rate_limited:{}:global", user_id);
    let val: Option<String> = redis.get(&key).await.unwrap_or(None);
    val.is_some()
}

/// Check if DM creation is blocked for a user.
pub async fn is_dm_blocked(redis: &RedisClient, user_id: UserId) -> bool {
    let key = format!("dm_blocked:{}", user_id);
    let val: Option<String> = redis.get(&key).await.unwrap_or(None);
    val.is_some()
}

/// Block DM creation for a user.
pub async fn block_dm_creation(redis: &RedisClient, user_id: UserId, cooldown_secs: i64) {
    let key = format!("dm_blocked:{}", user_id);
    let _: () = redis
        .set(&key, "1", Some(Expiration::EX(cooldown_secs)), None, false)
        .await
        .unwrap_or(());
}

/// Check if server joins are blocked for a user.
pub async fn is_join_blocked(redis: &RedisClient, user_id: UserId) -> bool {
    let key = format!("join_blocked:{}", user_id);
    let val: Option<String> = redis.get(&key).await.unwrap_or(None);
    val.is_some()
}

/// Block server joins for a user.
pub async fn block_joins(redis: &RedisClient, user_id: UserId, cooldown_secs: i64) {
    let key = format!("join_blocked:{}", user_id);
    let _: () = redis
        .set(&key, "1", Some(Expiration::EX(cooldown_secs)), None, false)
        .await
        .unwrap_or(());
}
