use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use mercury_core::{
    error::MercuryError,
    ids::ServerId,
};
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::extractors::{require_membership, require_ownership, AuthUser};
use crate::state::AppState;
use crate::ws::protocol::{
    MemberAddPayload, MemberRemovePayload, ServerEvent, ServerMessage,
};

// ── Request/Response types ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateServerRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateServerRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct JoinServerRequest {
    pub invite_code: String,
}

#[derive(Debug, Serialize)]
pub struct ServerResponse {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    pub owner_id: String,
    pub invite_code: String,
    pub max_members: Option<i32>,
    pub created_at: Option<String>,
}

impl From<mercury_core::models::Server> for ServerResponse {
    fn from(s: mercury_core::models::Server) -> Self {
        ServerResponse {
            id: s.id.to_string(),
            name: s.name,
            description: s.description,
            icon_url: s.icon_url,
            owner_id: s.owner_id.to_string(),
            invite_code: s.invite_code,
            max_members: s.max_members,
            created_at: s.created_at.map(|t| t.to_rfc3339()),
        }
    }
}

// ── Helpers ────────────────────────────────────────────────

fn generate_invite_code() -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

// ── Handlers ───────────────────────────────────────────────

/// POST /servers — create a server, add creator as owner + member.
pub async fn create_server(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<CreateServerRequest>,
) -> Result<(StatusCode, Json<ServerResponse>), MercuryError> {
    if req.name.is_empty() || req.name.len() > 100 {
        return Err(MercuryError::BadRequest(
            "server name must be 1-100 characters".into(),
        ));
    }

    let server_id = ServerId::new();
    let invite_code = generate_invite_code();

    let server = mercury_db::servers::create_server(
        &state.db,
        server_id,
        &req.name,
        auth_user.user_id,
        &invite_code,
    )
    .await?;

    // Auto-add creator as member
    mercury_db::servers::add_member(&state.db, auth_user.user_id, server_id).await?;

    Ok((StatusCode::CREATED, Json(ServerResponse::from(server))))
}

/// GET /servers — list the authenticated user's servers.
pub async fn list_servers(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Vec<ServerResponse>>, MercuryError> {
    let servers = mercury_db::servers::list_servers_for_user(&state.db, auth_user.user_id).await?;
    Ok(Json(servers.into_iter().map(ServerResponse::from).collect()))
}

/// GET /servers/:id — get server details (requires membership).
pub async fn get_server(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
) -> Result<Json<ServerResponse>, MercuryError> {
    let server_id = ServerId(server_id);
    require_membership(&state, auth_user.user_id, server_id).await?;

    let server = mercury_db::servers::get_server_by_id(&state.db, server_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("server not found".into()))?;

    Ok(Json(ServerResponse::from(server)))
}

/// PATCH /servers/:id — update server settings (owner only).
pub async fn update_server(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
    Json(req): Json<UpdateServerRequest>,
) -> Result<Json<ServerResponse>, MercuryError> {
    let server_id = ServerId(server_id);
    require_ownership(&state, auth_user.user_id, server_id).await?;

    let server = mercury_db::servers::update_server(
        &state.db,
        server_id,
        req.name.as_deref(),
        req.description.as_deref(),
        req.icon_url.as_deref(),
    )
    .await?
    .ok_or_else(|| MercuryError::NotFound("server not found".into()))?;

    Ok(Json(ServerResponse::from(server)))
}

/// DELETE /servers/:id — delete server (owner only).
pub async fn delete_server(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
) -> Result<StatusCode, MercuryError> {
    let server_id = ServerId(server_id);
    require_ownership(&state, auth_user.user_id, server_id).await?;

    mercury_db::servers::delete_server(&state.db, server_id).await?;

    Ok(StatusCode::NO_CONTENT)
}

/// POST /servers/join — join a server via invite code.
pub async fn join_server(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<JoinServerRequest>,
) -> Result<(StatusCode, Json<ServerResponse>), MercuryError> {
    let server = mercury_db::servers::get_server_by_invite_code(&state.db, &req.invite_code)
        .await?
        .ok_or_else(|| MercuryError::NotFound("invalid invite code".into()))?;

    // Check if server joins are blocked by abuse detection
    if mercury_moderation::abuse::is_join_blocked(&state.redis, auth_user.user_id).await {
        return Err(MercuryError::Forbidden("server joins temporarily blocked".into()));
    }

    // Check if user is banned from this server
    if mercury_moderation::bans::is_banned(&state.db, &state.redis, server.id, auth_user.user_id)
        .await
    {
        return Err(MercuryError::Forbidden("SERVER_BANNED".into()));
    }

    // Check if already a member
    let already_member =
        mercury_db::servers::is_member(&state.db, auth_user.user_id, server.id).await?;
    if already_member {
        return Err(MercuryError::Conflict("already a member of this server".into()));
    }

    mercury_db::servers::add_member(&state.db, auth_user.user_id, server.id).await?;

    // Increment join rate counter for abuse detection
    mercury_moderation::abuse::increment_join_rate(&state.redis, auth_user.user_id).await;

    // Add new member to all existing private channels in this server
    mercury_db::channels::add_member_to_server_private_channels(
        &state.db,
        auth_user.user_id,
        server.id,
    )
    .await?;

    // Broadcast MEMBER_ADD to all connected members of this server
    let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server.id).await?;
    let event = ServerMessage {
        t: ServerEvent::MEMBER_ADD,
        d: serde_json::to_value(MemberAddPayload {
            server_id: server.id.to_string(),
            user_id: auth_user.user_id.to_string(),
        })
        .unwrap_or_default(),
        seq: None,
    };
    state.ws_manager.send_to_users(&member_ids, &event);

    Ok((StatusCode::OK, Json(ServerResponse::from(server))))
}

/// GET /servers/:id/members — list server members.
pub async fn list_members(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
) -> Result<Json<Vec<MemberResponse>>, MercuryError> {
    let server_id = ServerId(server_id);
    require_membership(&state, auth_user.user_id, server_id).await?;

    let user_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id).await?;
    let members: Vec<MemberResponse> = user_ids
        .into_iter()
        .map(|uid| MemberResponse {
            user_id: uid.to_string(),
        })
        .collect();

    Ok(Json(members))
}

#[derive(Serialize)]
pub struct MemberResponse {
    pub user_id: String,
}

/// DELETE /servers/:id/members/me — leave a server.
pub async fn leave_server(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
) -> Result<StatusCode, MercuryError> {
    let server_id = ServerId(server_id);
    require_membership(&state, auth_user.user_id, server_id).await?;

    // Owner cannot leave their own server (they must delete it)
    let server = mercury_db::servers::get_server_by_id(&state.db, server_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("server not found".into()))?;
    if server.owner_id == auth_user.user_id {
        return Err(MercuryError::BadRequest(
            "owner cannot leave their own server; delete it instead".into(),
        ));
    }

    // Remove from channel_members for all channels in this server
    mercury_db::channels::remove_member_from_server_channels(
        &state.db,
        auth_user.user_id,
        server_id,
    )
    .await?;

    mercury_db::servers::remove_member(&state.db, auth_user.user_id, server_id).await?;

    // Increment sender_key_epoch for all private channels in this server
    // to trigger lazy re-keying by remaining members
    mercury_db::channels::increment_epoch_for_server_private_channels(&state.db, server_id)
        .await?;

    // Broadcast MEMBER_REMOVE to remaining connected members
    let member_ids = mercury_db::servers::get_member_user_ids(&state.db, server_id).await?;
    let event = ServerMessage {
        t: ServerEvent::MEMBER_REMOVE,
        d: serde_json::to_value(MemberRemovePayload {
            server_id: server_id.to_string(),
            user_id: auth_user.user_id.to_string(),
        })
        .unwrap_or_default(),
        seq: None,
    };
    state.ws_manager.send_to_users(&member_ids, &event);
    // Also send to the leaving user so their client can update
    state.ws_manager.send_to_user(&auth_user.user_id, &event);

    Ok(StatusCode::NO_CONTENT)
}
