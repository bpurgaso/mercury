use chrono::{DateTime, Utc};
use fred::prelude::*;
use mercury_core::ids::{ChannelId, MessageId, ReportId, ServerId, UserId};
use mercury_core::models::Report;
use sqlx::PgPool;

/// Valid report categories.
const VALID_CATEGORIES: &[&str] = &["spam", "harassment", "illegal", "csam", "other"];

/// Validate a report category.
pub fn is_valid_category(category: &str) -> bool {
    VALID_CATEGORIES.contains(&category)
}

/// Create a new report.
pub async fn create_report(
    pool: &PgPool,
    id: ReportId,
    reporter_id: UserId,
    reported_user_id: UserId,
    server_id: Option<ServerId>,
    channel_id: Option<ChannelId>,
    message_id: Option<MessageId>,
    category: &str,
    description: Option<&str>,
    evidence_blob: Option<&[u8]>,
) -> Result<Report, sqlx::Error> {
    sqlx::query_as::<_, Report>(
        r#"
        INSERT INTO reports (id, reporter_id, reported_user_id, server_id, channel_id,
                            message_id, category, description, evidence_blob, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(reporter_id)
    .bind(reported_user_id)
    .bind(server_id)
    .bind(channel_id)
    .bind(message_id)
    .bind(category)
    .bind(description)
    .bind(evidence_blob)
    .fetch_one(pool)
    .await
}

/// Check report rate limit: max N reports per user per day via Redis counter.
/// Returns true if under the limit, false if rate limited.
pub async fn check_report_rate_limit(
    redis: &RedisClient,
    user_id: UserId,
    max_per_day: u64,
) -> bool {
    let key = format!("abuse:report_rate:{}", user_id);
    let count: u64 = redis.get(&key).await.unwrap_or(0);
    count < max_per_day
}

/// Increment the report rate counter for a user.
pub async fn increment_report_rate(redis: &RedisClient, user_id: UserId) {
    let key = format!("abuse:report_rate:{}", user_id);
    let count: u64 = redis.incr(&key).await.unwrap_or(0);
    // Set TTL only on first increment to avoid race conditions
    if count == 1 {
        let _: () = redis.expire(&key, 86400).await.unwrap_or(());
    }
}

/// Increment the report count against a reported user (for abuse detection).
pub async fn increment_report_count_against(redis: &RedisClient, reported_user_id: UserId) {
    let key = format!("abuse:report_count:{}", reported_user_id);
    let count: u64 = redis.incr(&key).await.unwrap_or(0);
    if count == 1 {
        let _: () = redis.expire(&key, 86400).await.unwrap_or(());
    }
}

/// List reports for a server (paginated, newest first).
/// Does NOT return evidence_blob in list view.
pub async fn list_reports(
    pool: &PgPool,
    server_id: ServerId,
    status_filter: Option<&str>,
    before: Option<DateTime<Utc>>,
    limit: i64,
) -> Result<Vec<ReportListEntry>, sqlx::Error> {
    let mut query = String::from(
        r#"
        SELECT r.id, r.reporter_id, r.reported_user_id, r.server_id, r.channel_id,
               r.message_id, r.category, r.description, r.status, r.reviewed_by,
               r.reviewed_at, r.action_taken, r.created_at,
               reporter.username AS reporter_username,
               reported.username AS reported_username
        FROM reports r
        JOIN users reporter ON reporter.id = r.reporter_id
        JOIN users reported ON reported.id = r.reported_user_id
        WHERE r.server_id = $1
        "#,
    );

    let mut param_idx = 2;
    if status_filter.is_some() {
        query.push_str(&format!(" AND r.status = ${param_idx}"));
        param_idx += 1;
    }
    if before.is_some() {
        query.push_str(&format!(" AND r.created_at < ${param_idx}"));
        param_idx += 1;
    }

    query.push_str(&format!(" ORDER BY r.created_at DESC LIMIT ${param_idx}"));

    let mut q = sqlx::query_as::<_, ReportListEntry>(&query).bind(server_id);

    if let Some(s) = status_filter {
        q = q.bind(s);
    }
    if let Some(b) = before {
        q = q.bind(b);
    }
    q = q.bind(limit);

    q.fetch_all(pool).await
}

/// Get a single report by ID (full detail including evidence_blob).
pub async fn get_report_by_id(
    pool: &PgPool,
    report_id: ReportId,
) -> Result<Option<Report>, sqlx::Error> {
    sqlx::query_as::<_, Report>("SELECT * FROM reports WHERE id = $1")
        .bind(report_id)
        .fetch_optional(pool)
        .await
}

/// Get the server_id for a report (to validate moderator access).
pub async fn get_report_server_id(
    pool: &PgPool,
    report_id: ReportId,
) -> Result<Option<ServerId>, sqlx::Error> {
    let row: Option<(Option<ServerId>,)> =
        sqlx::query_as("SELECT server_id FROM reports WHERE id = $1")
            .bind(report_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(s,)| s))
}

/// Update report status and action.
pub async fn review_report(
    pool: &PgPool,
    report_id: ReportId,
    status: &str,
    reviewed_by: UserId,
    action_taken: Option<&str>,
) -> Result<Option<Report>, sqlx::Error> {
    sqlx::query_as::<_, Report>(
        r#"
        UPDATE reports
        SET status = $2, reviewed_by = $3, reviewed_at = now(), action_taken = $4
        WHERE id = $1
        RETURNING *
        "#,
    )
    .bind(report_id)
    .bind(status)
    .bind(reviewed_by)
    .bind(action_taken)
    .fetch_optional(pool)
    .await
}

/// Report list entry (without evidence_blob, with usernames joined).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ReportListEntry {
    pub id: ReportId,
    pub reporter_id: UserId,
    pub reported_user_id: UserId,
    pub server_id: Option<ServerId>,
    pub channel_id: Option<ChannelId>,
    pub message_id: Option<MessageId>,
    pub category: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub reviewed_by: Option<UserId>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub action_taken: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub reporter_username: String,
    pub reported_username: String,
}
