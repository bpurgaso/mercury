use chrono::{DateTime, Utc};
use mercury_core::ids::{ChannelId, ServerId, UserId};
use mercury_core::models::ModAuditLog;
use sqlx::PgPool;

/// Append an entry to the moderation audit log.
pub async fn log_action(
    pool: &PgPool,
    server_id: ServerId,
    moderator_id: UserId,
    action: &str,
    target_user_id: UserId,
    target_channel_id: Option<ChannelId>,
    reason: Option<&str>,
    metadata: Option<serde_json::Value>,
) -> Result<ModAuditLog, sqlx::Error> {
    sqlx::query_as::<_, ModAuditLog>(
        r#"
        INSERT INTO mod_audit_log (server_id, moderator_id, action, target_user_id, target_channel_id, reason, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        "#,
    )
    .bind(server_id)
    .bind(moderator_id)
    .bind(action)
    .bind(target_user_id)
    .bind(target_channel_id)
    .bind(reason)
    .bind(metadata)
    .fetch_one(pool)
    .await
}

/// Fetch audit log entries for a server (paginated, newest first).
pub async fn get_audit_log(
    pool: &PgPool,
    server_id: ServerId,
    before: Option<DateTime<Utc>>,
    limit: i64,
    action_filter: Option<&str>,
    target_user_filter: Option<UserId>,
    moderator_filter: Option<UserId>,
) -> Result<Vec<AuditLogEntryWithNames>, sqlx::Error> {
    // Build dynamic query
    let mut query = String::from(
        r#"
        SELECT
            mal.id, mal.server_id, mal.moderator_id, mal.action,
            mal.target_user_id, mal.target_channel_id, mal.reason,
            mal.metadata, mal.created_at,
            mod_user.username AS moderator_username,
            target_user.username AS target_username
        FROM mod_audit_log mal
        JOIN users mod_user ON mod_user.id = mal.moderator_id
        JOIN users target_user ON target_user.id = mal.target_user_id
        WHERE mal.server_id = $1
        "#,
    );

    let mut param_idx = 2;
    let mut conditions = Vec::new();

    if before.is_some() {
        conditions.push(format!("mal.created_at < ${param_idx}"));
        param_idx += 1;
    }
    if action_filter.is_some() {
        conditions.push(format!("mal.action = ${param_idx}"));
        param_idx += 1;
    }
    if target_user_filter.is_some() {
        conditions.push(format!("mal.target_user_id = ${param_idx}"));
        param_idx += 1;
    }
    if moderator_filter.is_some() {
        conditions.push(format!("mal.moderator_id = ${param_idx}"));
        param_idx += 1;
    }

    for cond in &conditions {
        query.push_str(" AND ");
        query.push_str(cond);
    }

    query.push_str(&format!(
        " ORDER BY mal.created_at DESC LIMIT ${param_idx}"
    ));

    let mut q = sqlx::query_as::<_, AuditLogEntryWithNames>(&query).bind(server_id);

    if let Some(b) = before {
        q = q.bind(b);
    }
    if let Some(a) = action_filter {
        q = q.bind(a);
    }
    if let Some(t) = target_user_filter {
        q = q.bind(t);
    }
    if let Some(m) = moderator_filter {
        q = q.bind(m);
    }

    q = q.bind(limit);

    q.fetch_all(pool).await
}

/// Audit log entry with moderator and target usernames joined.
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct AuditLogEntryWithNames {
    pub id: i64,
    pub server_id: ServerId,
    pub moderator_id: UserId,
    pub action: String,
    pub target_user_id: UserId,
    pub target_channel_id: Option<ChannelId>,
    pub reason: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: Option<DateTime<Utc>>,
    pub moderator_username: String,
    pub target_username: String,
}

/// Check if user is server owner or moderator.
pub async fn is_owner_or_mod(
    pool: &PgPool,
    user_id: UserId,
    server_id: ServerId,
) -> Result<bool, sqlx::Error> {
    // Check owner
    let owner_row: Option<(i32,)> =
        sqlx::query_as("SELECT 1 as n FROM servers WHERE id = $1 AND owner_id = $2")
            .bind(server_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    if owner_row.is_some() {
        return Ok(true);
    }

    // Check moderator
    let mod_row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 as n FROM server_members WHERE server_id = $1 AND user_id = $2 AND is_moderator = true",
    )
    .bind(server_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(mod_row.is_some())
}

/// Check if user is server owner.
pub async fn is_owner(
    pool: &PgPool,
    user_id: UserId,
    server_id: ServerId,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> =
        sqlx::query_as("SELECT 1 as n FROM servers WHERE id = $1 AND owner_id = $2")
            .bind(server_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}

/// Promote a user to moderator.
pub async fn promote_moderator(
    pool: &PgPool,
    server_id: ServerId,
    user_id: UserId,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE server_members SET is_moderator = true WHERE server_id = $1 AND user_id = $2",
    )
    .bind(server_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Demote a user from moderator.
pub async fn demote_moderator(
    pool: &PgPool,
    server_id: ServerId,
    user_id: UserId,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE server_members SET is_moderator = false WHERE server_id = $1 AND user_id = $2",
    )
    .bind(server_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
