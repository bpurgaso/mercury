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
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;

    Ok(Json(entries))
}

// ── Common types ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PaginationParams {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}
