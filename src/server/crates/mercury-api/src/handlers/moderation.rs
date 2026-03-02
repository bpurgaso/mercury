use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use mercury_core::{
    error::MercuryError,
    ids::{ChannelId, ServerId, UserId},
};
use serde::{Deserialize, Serialize};

use crate::extractors::AuthUser;
use crate::state::AppState;
use crate::ws::protocol::{ServerEvent, ServerMessage};

// ── Helpers ──────────────────────────────────────────────────

fn validate_reason(reason: &Option<String>) -> Result<(), MercuryError> {
    if let Some(r) = reason {
        if r.is_empty() || r.len() > 1000 {
            return Err(MercuryError::BadRequest(
                "reason must be 1-1000 characters".into(),
            ));
        }
    }
    Ok(())
}

async fn require_owner_or_mod(
    state: &AppState,
    user_id: UserId,
    server_id: ServerId,
) -> Result<(), MercuryError> {
    let allowed = mercury_moderation::audit::is_owner_or_mod(&state.db, user_id, server_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;
    if !allowed {
        return Err(MercuryError::Forbidden(
            "requires server owner or moderator".into(),
        ));
    }
    Ok(())
}

async fn require_owner(
    state: &AppState,
    user_id: UserId,
    server_id: ServerId,
) -> Result<(), MercuryError> {
    let is_owner = mercury_moderation::audit::is_owner(&state.db, user_id, server_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;
    if !is_owner {
        return Err(MercuryError::Forbidden(
            "requires server owner".into(),
        ));
    }
    Ok(())
}

/// Require the user to be an owner or moderator of at least one server (for admin endpoints).
async fn require_any_mod_or_owner(
    state: &AppState,
    user_id: UserId,
) -> Result<(), MercuryError> {
    let allowed =
        mercury_moderation::audit::is_any_server_mod_or_owner(&state.db, user_id)
            .await
            .map_err(|e| MercuryError::Database(e))?;
    if !allowed {
        return Err(MercuryError::Forbidden(
            "requires server owner or moderator privileges".into(),
        ));
    }
    Ok(())
}

/// Get the server owner_id for a given server_id.
async fn get_server_owner(state: &AppState, server_id: ServerId) -> Result<UserId, MercuryError> {
    let server = mercury_db::servers::get_server_by_id(&state.db, server_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("server not found".into()))?;
    Ok(server.owner_id)
}

/// Get server_id from a channel_id.
async fn get_server_for_channel(
    state: &AppState,
    channel_id: ChannelId,
) -> Result<ServerId, MercuryError> {
    mercury_db::servers::get_server_id_for_channel(&state.db, channel_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("channel not found".into()))
}

// ── Block endpoints ──────────────────────────────────────────

/// PUT /users/me/blocks/:userId
pub async fn block_user(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(target_id): Path<uuid::Uuid>,
) -> Result<StatusCode, MercuryError> {
    let target_id = UserId(target_id);

    if auth_user.user_id == target_id {
        return Err(MercuryError::BadRequest("cannot block yourself".into()));
    }

    mercury_moderation::blocks::block_user(
        &state.db,
        &state.redis,
        auth_user.user_id,
        target_id,
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /users/me/blocks/:userId
pub async fn unblock_user(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(target_id): Path<uuid::Uuid>,
) -> Result<StatusCode, MercuryError> {
    let target_id = UserId(target_id);

    let removed = mercury_moderation::blocks::unblock_user(
        &state.db,
        &state.redis,
        auth_user.user_id,
        target_id,
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    if !removed {
        return Err(MercuryError::NotFound("block not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct BlockedUserResponse {
    pub user_id: String,
    pub created_at: Option<String>,
}

/// GET /users/me/blocks
pub async fn list_blocks(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Query(params): Query<PaginationParams>,
) -> Result<Json<Vec<BlockedUserResponse>>, MercuryError> {
    let limit = params.limit.unwrap_or(50).min(100);
    let offset = params.offset.unwrap_or(0);

    let blocks = mercury_moderation::blocks::list_blocked_users(
        &state.db,
        auth_user.user_id,
        limit,
        offset,
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    let resp: Vec<BlockedUserResponse> = blocks
        .into_iter()
        .map(|b| BlockedUserResponse {
            user_id: b.blocked_id.to_string(),
            created_at: b.created_at.map(|t| t.to_rfc3339()),
        })
        .collect();

    Ok(Json(resp))
}

// ── DM Policy ────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct DmPolicyRequest {
    pub policy: String,
}

#[derive(Serialize)]
pub struct DmPolicyResponse {
    pub dm_policy: String,
}

/// PUT /users/me/dm-policy
pub async fn set_dm_policy(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<DmPolicyRequest>,
) -> Result<Json<DmPolicyResponse>, MercuryError> {
    match req.policy.as_str() {
        "anyone" | "mutual_servers" | "nobody" => {}
        _ => {
            return Err(MercuryError::BadRequest(
                "invalid dm_policy: must be 'anyone', 'mutual_servers', or 'nobody'".into(),
            ))
        }
    }

    mercury_moderation::blocks::set_dm_policy(&state.db, auth_user.user_id, &req.policy)
        .await
        .map_err(|e| MercuryError::Database(e))?;

    Ok(Json(DmPolicyResponse {
        dm_policy: req.policy,
    }))
}

// ── Ban endpoints ────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BanRequest {
    pub user_id: uuid::Uuid,
    pub reason: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct BanResponse {
    pub server_id: String,
    pub user_id: String,
    pub banned_by: String,
    pub reason: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: Option<String>,
}

/// POST /servers/:id/bans
pub async fn ban_user(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
    Json(req): Json<BanRequest>,
) -> Result<(StatusCode, Json<BanResponse>), MercuryError> {
    let server_id = ServerId(server_id);
    let target_id = UserId(req.user_id);
    validate_reason(&req.reason)?;

    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    // Cannot ban the server owner
    let owner_id = get_server_owner(&state, server_id).await?;
    if target_id == owner_id {
        return Err(MercuryError::Forbidden(
            "cannot ban the server owner".into(),
        ));
    }

    let ban = mercury_moderation::bans::ban_user(
        &state.db,
        &state.redis,
        server_id,
        target_id,
        auth_user.user_id,
        req.reason.as_deref(),
        req.expires_at,
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    // Write audit log
    let _ = mercury_moderation::audit::log_action(
        &state.db,
        server_id,
        auth_user.user_id,
        "ban",
        target_id,
        None,
        req.reason.as_deref(),
        Some(serde_json::json!({
            "expires_at": req.expires_at.map(|t| t.to_rfc3339()),
        })),
    )
    .await;

    // Send USER_BANNED WebSocket event to all server members
    let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id)
        .await
        .unwrap_or_default();
    let event = ServerMessage {
        t: ServerEvent::USER_BANNED,
        d: serde_json::json!({
            "server_id": server_id.to_string(),
            "user_id": target_id.to_string(),
        }),
        seq: None,
    };
    state.ws_manager.send_to_users(&member_ids, &event);
    // Also send to the banned user
    state.ws_manager.send_to_user(&target_id, &event);

    // Force disconnect the banned user
    state.ws_manager.disconnect_user(&target_id);

    Ok((
        StatusCode::CREATED,
        Json(BanResponse {
            server_id: ban.server_id.to_string(),
            user_id: ban.user_id.to_string(),
            banned_by: ban.banned_by.to_string(),
            reason: ban.reason,
            expires_at: ban.expires_at.map(|t| t.to_rfc3339()),
            created_at: ban.created_at.map(|t| t.to_rfc3339()),
        }),
    ))
}

/// DELETE /servers/:id/bans/:userId
pub async fn unban_user(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((server_id, user_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<StatusCode, MercuryError> {
    let server_id = ServerId(server_id);
    let user_id = UserId(user_id);

    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    let removed = mercury_moderation::bans::unban_user(&state.db, &state.redis, server_id, user_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;

    if !removed {
        return Err(MercuryError::NotFound("ban not found".into()));
    }

    // Write audit log
    let _ = mercury_moderation::audit::log_action(
        &state.db,
        server_id,
        auth_user.user_id,
        "unban",
        user_id,
        None,
        None,
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /servers/:id/bans
pub async fn list_bans(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
    Query(params): Query<PaginationParams>,
) -> Result<Json<Vec<BanResponse>>, MercuryError> {
    let server_id = ServerId(server_id);
    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    let limit = params.limit.unwrap_or(50).min(100);
    let offset = params.offset.unwrap_or(0);

    let bans = mercury_moderation::bans::list_bans(&state.db, server_id, limit, offset)
        .await
        .map_err(|e| MercuryError::Database(e))?;

    let resp: Vec<BanResponse> = bans
        .into_iter()
        .map(|b| BanResponse {
            server_id: b.server_id.to_string(),
            user_id: b.user_id.to_string(),
            banned_by: b.banned_by.to_string(),
            reason: b.reason,
            expires_at: b.expires_at.map(|t| t.to_rfc3339()),
            created_at: b.created_at.map(|t| t.to_rfc3339()),
        })
        .collect();

    Ok(Json(resp))
}

// ── Kick endpoint ────────────────────────────────────────────

#[derive(Deserialize)]
pub struct KickRequest {
    pub reason: Option<String>,
}

/// POST /servers/:id/kicks/:userId
pub async fn kick_user(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((server_id, user_id)): Path<(uuid::Uuid, uuid::Uuid)>,
    Json(req): Json<KickRequest>,
) -> Result<StatusCode, MercuryError> {
    let server_id = ServerId(server_id);
    let target_id = UserId(user_id);
    validate_reason(&req.reason)?;

    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    // Cannot kick the server owner
    let owner_id = get_server_owner(&state, server_id).await?;
    if target_id == owner_id {
        return Err(MercuryError::Forbidden(
            "cannot kick the server owner".into(),
        ));
    }

    // Check target is a member
    let is_member = mercury_db::servers::is_member(&state.db, target_id, server_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;
    if !is_member {
        return Err(MercuryError::NotFound(
            "user is not a member of this server".into(),
        ));
    }

    // Remove from server_members (but not banned — can rejoin)
    mercury_db::servers::remove_member(&state.db, target_id, server_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;

    // Write audit log
    let _ = mercury_moderation::audit::log_action(
        &state.db,
        server_id,
        auth_user.user_id,
        "kick",
        target_id,
        None,
        req.reason.as_deref(),
        None,
    )
    .await;

    // Send USER_KICKED WebSocket event to all server members
    let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id)
        .await
        .unwrap_or_default();
    let event = ServerMessage {
        t: ServerEvent::USER_KICKED,
        d: serde_json::json!({
            "server_id": server_id.to_string(),
            "user_id": target_id.to_string(),
        }),
        seq: None,
    };
    state.ws_manager.send_to_users(&member_ids, &event);
    // Also send to the kicked user
    state.ws_manager.send_to_user(&target_id, &event);

    // Force disconnect the kicked user
    state.ws_manager.disconnect_user(&target_id);

    Ok(StatusCode::NO_CONTENT)
}

// ── Mute endpoints ──────────────────────────────────────────

#[derive(Deserialize)]
pub struct MuteRequest {
    pub user_id: uuid::Uuid,
    pub reason: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct MuteResponse {
    pub channel_id: String,
    pub user_id: String,
    pub muted_by: String,
    pub reason: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: Option<String>,
}

/// POST /channels/:id/mutes
pub async fn mute_user(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(channel_id): Path<uuid::Uuid>,
    Json(req): Json<MuteRequest>,
) -> Result<(StatusCode, Json<MuteResponse>), MercuryError> {
    let channel_id = ChannelId(channel_id);
    let target_id = UserId(req.user_id);
    validate_reason(&req.reason)?;

    // Get server for channel
    let server_id = get_server_for_channel(&state, channel_id).await?;
    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    // Cannot mute the server owner
    let owner_id = get_server_owner(&state, server_id).await?;
    if target_id == owner_id {
        return Err(MercuryError::Forbidden(
            "cannot mute the server owner".into(),
        ));
    }

    let mute = mercury_moderation::mutes::mute_user(
        &state.db,
        &state.redis,
        channel_id,
        target_id,
        auth_user.user_id,
        req.reason.as_deref(),
        req.expires_at,
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    // Write audit log
    let _ = mercury_moderation::audit::log_action(
        &state.db,
        server_id,
        auth_user.user_id,
        "mute",
        target_id,
        Some(channel_id),
        req.reason.as_deref(),
        Some(serde_json::json!({
            "expires_at": req.expires_at.map(|t| t.to_rfc3339()),
        })),
    )
    .await;

    // Send USER_MUTED event
    let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id)
        .await
        .unwrap_or_default();
    let event = ServerMessage {
        t: ServerEvent::USER_MUTED,
        d: serde_json::json!({
            "channel_id": channel_id.to_string(),
            "user_id": target_id.to_string(),
            "expires_at": req.expires_at.map(|t| t.to_rfc3339()),
        }),
        seq: None,
    };
    state.ws_manager.send_to_users(&member_ids, &event);

    Ok((
        StatusCode::CREATED,
        Json(MuteResponse {
            channel_id: mute.channel_id.to_string(),
            user_id: mute.user_id.to_string(),
            muted_by: mute.muted_by.to_string(),
            reason: mute.reason,
            expires_at: mute.expires_at.map(|t| t.to_rfc3339()),
            created_at: mute.created_at.map(|t| t.to_rfc3339()),
        }),
    ))
}

/// DELETE /channels/:id/mutes/:userId
pub async fn unmute_user(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((channel_id, user_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<StatusCode, MercuryError> {
    let channel_id = ChannelId(channel_id);
    let target_id = UserId(user_id);

    let server_id = get_server_for_channel(&state, channel_id).await?;
    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    let removed =
        mercury_moderation::mutes::unmute_user(&state.db, &state.redis, channel_id, target_id)
            .await
            .map_err(|e| MercuryError::Database(e))?;

    if !removed {
        return Err(MercuryError::NotFound("mute not found".into()));
    }

    // Write audit log
    let _ = mercury_moderation::audit::log_action(
        &state.db,
        server_id,
        auth_user.user_id,
        "unmute",
        target_id,
        Some(channel_id),
        None,
        None,
    )
    .await;

    // Send USER_UNMUTED event
    let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id)
        .await
        .unwrap_or_default();
    let event = ServerMessage {
        t: ServerEvent::USER_UNMUTED,
        d: serde_json::json!({
            "channel_id": channel_id.to_string(),
            "user_id": target_id.to_string(),
        }),
        seq: None,
    };
    state.ws_manager.send_to_users(&member_ids, &event);

    Ok(StatusCode::NO_CONTENT)
}

// ── Moderator endpoints ─────────────────────────────────────

/// PUT /servers/:id/moderators/:userId
pub async fn promote_moderator(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((server_id, user_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<StatusCode, MercuryError> {
    let server_id = ServerId(server_id);
    let target_id = UserId(user_id);

    // Only owner can promote
    require_owner(&state, auth_user.user_id, server_id).await?;

    // Verify target is a member
    let is_member = mercury_db::servers::is_member(&state.db, target_id, server_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;
    if !is_member {
        return Err(MercuryError::NotFound(
            "user is not a member of this server".into(),
        ));
    }

    mercury_moderation::audit::promote_moderator(&state.db, server_id, target_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;

    // Write audit log
    let _ = mercury_moderation::audit::log_action(
        &state.db,
        server_id,
        auth_user.user_id,
        "promote_moderator",
        target_id,
        None,
        None,
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /servers/:id/moderators/:userId
pub async fn demote_moderator(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path((server_id, user_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<StatusCode, MercuryError> {
    let server_id = ServerId(server_id);
    let target_id = UserId(user_id);

    // Only owner can demote
    require_owner(&state, auth_user.user_id, server_id).await?;

    mercury_moderation::audit::demote_moderator(&state.db, server_id, target_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;

    // Write audit log
    let _ = mercury_moderation::audit::log_action(
        &state.db,
        server_id,
        auth_user.user_id,
        "demote_moderator",
        target_id,
        None,
        None,
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

// ── Audit log endpoint ──────────────────────────────────────

#[derive(Deserialize)]
pub struct AuditLogParams {
    pub before: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    pub action: Option<String>,
    pub target_user_id: Option<uuid::Uuid>,
    pub moderator_id: Option<uuid::Uuid>,
}

/// GET /servers/:id/audit-log
pub async fn get_audit_log(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
    Query(params): Query<AuditLogParams>,
) -> Result<Json<Vec<mercury_moderation::audit::AuditLogEntryWithNames>>, MercuryError> {
    let server_id = ServerId(server_id);
    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    let limit = params.limit.unwrap_or(50).min(100);

    let entries = mercury_moderation::audit::get_audit_log(
        &state.db,
        server_id,
        params.before,
        limit,
        params.action.as_deref(),
        params.target_user_id.map(UserId),
        params.moderator_id.map(UserId),
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    Ok(Json(entries))
}

// ── Report endpoints ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct SubmitReportRequest {
    pub reported_user_id: uuid::Uuid,
    pub server_id: Option<uuid::Uuid>,
    pub channel_id: Option<uuid::Uuid>,
    pub message_id: Option<uuid::Uuid>,
    pub category: String,
    pub description: String,
    #[serde(default)]
    pub evidence_blob: Option<Vec<u8>>,
}

#[derive(Serialize)]
pub struct ReportResponse {
    pub id: String,
    pub reporter_id: String,
    pub reported_user_id: String,
    pub server_id: Option<String>,
    pub channel_id: Option<String>,
    pub message_id: Option<String>,
    pub category: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub reviewed_by: Option<String>,
    pub reviewed_at: Option<String>,
    pub action_taken: Option<String>,
    pub evidence_blob: Option<Vec<u8>>,
    pub created_at: Option<String>,
}

impl From<mercury_core::models::Report> for ReportResponse {
    fn from(r: mercury_core::models::Report) -> Self {
        ReportResponse {
            id: r.id.to_string(),
            reporter_id: r.reporter_id.to_string(),
            reported_user_id: r.reported_user_id.to_string(),
            server_id: r.server_id.map(|s| s.to_string()),
            channel_id: r.channel_id.map(|c| c.to_string()),
            message_id: r.message_id.map(|m| m.to_string()),
            category: r.category,
            description: r.description,
            status: r.status,
            reviewed_by: r.reviewed_by.map(|u| u.to_string()),
            reviewed_at: r.reviewed_at.map(|t| t.to_rfc3339()),
            action_taken: r.action_taken,
            evidence_blob: r.evidence_blob,
            created_at: r.created_at.map(|t| t.to_rfc3339()),
        }
    }
}

/// POST /reports — submit a content report.
pub async fn submit_report(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<SubmitReportRequest>,
) -> Result<(StatusCode, Json<ReportResponse>), MercuryError> {
    let reported_user_id = UserId(req.reported_user_id);

    // Cannot report yourself
    if auth_user.user_id == reported_user_id {
        return Err(MercuryError::BadRequest("cannot report yourself".into()));
    }

    // Validate category
    if !mercury_moderation::reports::is_valid_category(&req.category) {
        return Err(MercuryError::BadRequest(
            "invalid category: must be 'spam', 'harassment', 'illegal', 'csam', or 'other'".into(),
        ));
    }

    // Validate description is not empty and within length
    if req.description.trim().is_empty() || req.description.len() > 1000 {
        return Err(MercuryError::BadRequest(
            "description must be 1-1000 characters".into(),
        ));
    }

    let server_id = req.server_id.map(ServerId);

    // If server_id is provided, verify reporter is a member
    if let Some(sid) = server_id {
        let is_member = mercury_db::servers::is_member(&state.db, auth_user.user_id, sid)
            .await
            .map_err(|e| MercuryError::Database(e))?;
        if !is_member {
            return Err(MercuryError::Forbidden(
                "you must be a member of the server to report".into(),
            ));
        }
    }

    // Check rate limit
    let max_reports = state.moderation_config.auto_actions.report_rate_limit_per_day;
    if !mercury_moderation::reports::check_report_rate_limit(
        &state.redis,
        auth_user.user_id,
        max_reports,
    )
    .await
    {
        return Err(MercuryError::RateLimited { retry_after: 86400 });
    }

    let report_id = mercury_core::ids::ReportId::new();
    let channel_id = req.channel_id.map(ChannelId);
    let message_id = req.message_id.map(mercury_core::ids::MessageId);

    let report = mercury_moderation::reports::create_report(
        &state.db,
        report_id,
        auth_user.user_id,
        reported_user_id,
        server_id,
        channel_id,
        message_id,
        &req.category,
        Some(&req.description),
        req.evidence_blob.as_deref(),
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    // Increment rate counters
    mercury_moderation::reports::increment_report_rate(&state.redis, auth_user.user_id).await;
    mercury_moderation::reports::increment_report_count_against(&state.redis, reported_user_id)
        .await;

    // Send REPORT_CREATED WebSocket event to owner/moderators of the relevant server
    if let Some(sid) = server_id {
        let mod_ids = mercury_db::servers::get_owner_and_mod_ids(&state.db, sid)
            .await
            .unwrap_or_default();
        let event = ServerMessage {
            t: ServerEvent::REPORT_CREATED,
            d: serde_json::json!({
                "report": {
                    "id": report.id.to_string(),
                    "category": report.category,
                    "status": report.status,
                    "reported_user_id": report.reported_user_id.to_string(),
                    "reporter_id": report.reporter_id.to_string(),
                    "created_at": report.created_at.map(|t| t.to_rfc3339()),
                }
            }),
            seq: None,
        };
        state.ws_manager.send_to_users(&mod_ids, &event);
    }

    Ok((StatusCode::CREATED, Json(ReportResponse::from(report))))
}

#[derive(Deserialize)]
pub struct ReportListParams {
    pub status: Option<String>,
    pub before: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}

/// GET /servers/:id/reports — list reports for a server (Owner/Mod auth).
pub async fn list_reports(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
    Query(params): Query<ReportListParams>,
) -> Result<Json<Vec<serde_json::Value>>, MercuryError> {
    let server_id = ServerId(server_id);
    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    let limit = params.limit.unwrap_or(20).min(100);

    let entries = mercury_moderation::reports::list_reports(
        &state.db,
        server_id,
        params.status.as_deref(),
        params.before,
        limit,
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    let resp: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|e| {
            serde_json::json!({
                "id": e.id.to_string(),
                "reporter_id": e.reporter_id.to_string(),
                "reported_user_id": e.reported_user_id.to_string(),
                "reporter_username": e.reporter_username,
                "reported_username": e.reported_username,
                "server_id": e.server_id.map(|s| s.to_string()),
                "channel_id": e.channel_id.map(|c| c.to_string()),
                "message_id": e.message_id.map(|m| m.to_string()),
                "category": e.category,
                "description": e.description,
                "status": e.status,
                "reviewed_by": e.reviewed_by.map(|u| u.to_string()),
                "reviewed_at": e.reviewed_at.map(|t| t.to_rfc3339()),
                "action_taken": e.action_taken,
                "created_at": e.created_at.map(|t| t.to_rfc3339()),
            })
        })
        .collect();

    Ok(Json(resp))
}

/// GET /reports/:id — single report detail (Owner/Mod auth).
pub async fn get_report(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(report_id): Path<uuid::Uuid>,
) -> Result<Json<ReportResponse>, MercuryError> {
    let report_id = mercury_core::ids::ReportId(report_id);

    let report = mercury_moderation::reports::get_report_by_id(&state.db, report_id)
        .await
        .map_err(|e| MercuryError::Database(e))?
        .ok_or_else(|| MercuryError::NotFound("report not found".into()))?;

    // Verify moderator has access to the server this report belongs to
    if let Some(sid) = report.server_id {
        require_owner_or_mod(&state, auth_user.user_id, sid).await?;
    } else {
        return Err(MercuryError::Forbidden(
            "report has no server context".into(),
        ));
    }

    Ok(Json(ReportResponse::from(report)))
}

#[derive(Deserialize)]
pub struct ReviewReportRequest {
    pub status: String,
    pub action_taken: Option<String>,
    pub ban_duration: Option<u64>,
}

/// PATCH /reports/:id — review/action a report (Owner/Mod auth).
pub async fn review_report(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(report_id): Path<uuid::Uuid>,
    Json(req): Json<ReviewReportRequest>,
) -> Result<Json<ReportResponse>, MercuryError> {
    let report_id = mercury_core::ids::ReportId(report_id);

    // Validate status
    match req.status.as_str() {
        "reviewed" | "actioned" | "dismissed" => {}
        _ => {
            return Err(MercuryError::BadRequest(
                "status must be 'reviewed', 'actioned', or 'dismissed'".into(),
            ))
        }
    }

    // Validate action_taken if provided
    if let Some(ref action) = req.action_taken {
        match action.as_str() {
            "none" | "warn" | "mute" | "kick" | "ban" => {}
            _ => {
                return Err(MercuryError::BadRequest(
                    "action_taken must be 'none', 'warn', 'mute', 'kick', or 'ban'".into(),
                ))
            }
        }
    }

    // Get report to find server context
    let report = mercury_moderation::reports::get_report_by_id(&state.db, report_id)
        .await
        .map_err(|e| MercuryError::Database(e))?
        .ok_or_else(|| MercuryError::NotFound("report not found".into()))?;

    let server_id = report
        .server_id
        .ok_or_else(|| MercuryError::BadRequest("report has no server context".into()))?;

    // Verify moderator access
    require_owner_or_mod(&state, auth_user.user_id, server_id).await?;

    // Update report
    let updated = mercury_moderation::reports::review_report(
        &state.db,
        report_id,
        &req.status,
        auth_user.user_id,
        req.action_taken.as_deref(),
    )
    .await
    .map_err(|e| MercuryError::Database(e))?
    .ok_or_else(|| MercuryError::NotFound("report not found".into()))?;

    // Execute action if specified
    if let Some(ref action) = req.action_taken {
        let target_id = report.reported_user_id;

        // Cannot ban/kick the server owner
        if matches!(action.as_str(), "ban" | "kick") {
            let owner_id = get_server_owner(&state, server_id).await?;
            if target_id == owner_id {
                return Err(MercuryError::Forbidden(
                    "cannot ban or kick the server owner".into(),
                ));
            }
        }

        match action.as_str() {
            "ban" => {
                let expires_at = req.ban_duration.map(|secs| {
                    Utc::now() + chrono::Duration::seconds(secs as i64)
                });
                mercury_moderation::bans::ban_user(
                    &state.db,
                    &state.redis,
                    server_id,
                    target_id,
                    auth_user.user_id,
                    Some("banned via report review"),
                    expires_at,
                )
                .await
                .map_err(|e| MercuryError::Database(e))?;

                // Send USER_BANNED event
                let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id)
                    .await
                    .unwrap_or_default();
                let event = ServerMessage {
                    t: ServerEvent::USER_BANNED,
                    d: serde_json::json!({
                        "server_id": server_id.to_string(),
                        "user_id": target_id.to_string(),
                    }),
                    seq: None,
                };
                state.ws_manager.send_to_users(&member_ids, &event);
                state.ws_manager.send_to_user(&target_id, &event);
                state.ws_manager.disconnect_user(&target_id);
            }
            "kick" => {
                mercury_db::servers::remove_member(&state.db, target_id, server_id)
                    .await
                    .map_err(|e| MercuryError::Database(e))?;

                let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id)
                    .await
                    .unwrap_or_default();
                let event = ServerMessage {
                    t: ServerEvent::USER_KICKED,
                    d: serde_json::json!({
                        "server_id": server_id.to_string(),
                        "user_id": target_id.to_string(),
                    }),
                    seq: None,
                };
                state.ws_manager.send_to_users(&member_ids, &event);
                state.ws_manager.send_to_user(&target_id, &event);
                state.ws_manager.disconnect_user(&target_id);
            }
            "mute" => {
                // Mute in the report's channel if specified
                if let Some(cid) = report.channel_id {
                    mercury_moderation::mutes::mute_user(
                        &state.db,
                        &state.redis,
                        cid,
                        target_id,
                        auth_user.user_id,
                        Some("muted via report review"),
                        None,
                    )
                    .await
                    .map_err(|e| MercuryError::Database(e))?;
                }
            }
            _ => {}
        }
    }

    // Write audit log entry
    let _ = mercury_moderation::audit::log_action(
        &state.db,
        server_id,
        auth_user.user_id,
        "report_review",
        report.reported_user_id,
        report.channel_id,
        None,
        Some(serde_json::json!({
            "report_id": report_id.to_string(),
            "category": report.category,
            "action_taken": req.action_taken,
        })),
    )
    .await;

    Ok(Json(ReportResponse::from(updated)))
}

// ── Abuse signal endpoints ──────────────────────────────────

#[derive(Deserialize)]
pub struct AbuseSignalListParams {
    pub reviewed: Option<bool>,
    pub severity: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Serialize)]
pub struct AbuseSignalResponse {
    pub id: i64,
    pub user_id: String,
    pub signal_type: String,
    pub severity: Option<String>,
    pub details: serde_json::Value,
    pub auto_action: Option<String>,
    pub reviewed: Option<bool>,
    pub created_at: Option<String>,
}

impl From<mercury_core::models::AbuseSignal> for AbuseSignalResponse {
    fn from(s: mercury_core::models::AbuseSignal) -> Self {
        AbuseSignalResponse {
            id: s.id,
            user_id: s.user_id.to_string(),
            signal_type: s.signal_type,
            severity: s.severity,
            details: s.details,
            auto_action: s.auto_action,
            reviewed: s.reviewed,
            created_at: s.created_at.map(|t| t.to_rfc3339()),
        }
    }
}

/// GET /admin/abuse-signals — list flagged signals.
/// Requires any authenticated user who is an owner or mod of at least one server.
pub async fn list_abuse_signals(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Query(params): Query<AbuseSignalListParams>,
) -> Result<Json<Vec<AbuseSignalResponse>>, MercuryError> {
    // For admin endpoints, verify the user owns or moderates at least one server.
    require_any_mod_or_owner(&state, auth_user.user_id).await?;

    let limit = params.limit.unwrap_or(20).min(100);

    let signals = mercury_moderation::abuse::list_signals(
        &state.db,
        params.reviewed,
        params.severity.as_deref(),
        limit,
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    Ok(Json(
        signals
            .into_iter()
            .map(AbuseSignalResponse::from)
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct MarkReviewedRequest {
    #[serde(default)]
    pub reviewed: Option<bool>,
}

/// PATCH /admin/abuse-signals/:id — mark reviewed.
pub async fn mark_signal_reviewed(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(signal_id): Path<i64>,
) -> Result<Json<AbuseSignalResponse>, MercuryError> {
    require_any_mod_or_owner(&state, auth_user.user_id).await?;

    let signal = mercury_moderation::abuse::mark_reviewed(&state.db, signal_id)
        .await
        .map_err(|e| MercuryError::Database(e))?
        .ok_or_else(|| MercuryError::NotFound("abuse signal not found".into()))?;

    Ok(Json(AbuseSignalResponse::from(signal)))
}

/// GET /admin/abuse-stats — aggregate stats.
pub async fn get_abuse_stats(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<mercury_moderation::abuse::AbuseStats>, MercuryError> {
    require_any_mod_or_owner(&state, auth_user.user_id).await?;

    let stats = mercury_moderation::abuse::get_abuse_stats(&state.db)
        .await
        .map_err(|e| MercuryError::Database(e))?;

    Ok(Json(stats))
}

// ── Moderation key endpoint ─────────────────────────────────

#[derive(Serialize)]
pub struct ModerationKeyResponse {
    pub operator_moderation_pubkey: String,
}

/// GET /servers/:id/moderation-key — returns operator's moderation public key.
pub async fn get_moderation_key(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
) -> Result<Json<ModerationKeyResponse>, MercuryError> {
    let server_id = ServerId(server_id);

    // Verify the user is a member of this server
    let is_member = mercury_db::servers::is_member(&state.db, auth_user.user_id, server_id)
        .await
        .map_err(|e| MercuryError::Database(e))?;
    if !is_member {
        return Err(MercuryError::Forbidden("not a member of this server".into()));
    }

    Ok(Json(ModerationKeyResponse {
        operator_moderation_pubkey: state
            .moderation_config
            .reporting
            .operator_moderation_pubkey
            .clone(),
    }))
}

// ── Common types ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PaginationParams {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}
