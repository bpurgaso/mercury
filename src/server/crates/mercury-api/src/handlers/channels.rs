use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use mercury_core::{
    error::MercuryError,
    ids::{ChannelId, ServerId},
};
use serde::{Deserialize, Serialize};

use crate::extractors::{require_membership, require_ownership, AuthUser};
use crate::state::AppState;

// ── Request/Response types ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default = "default_channel_type")]
    pub channel_type: String,
    pub encryption_mode: String,
}

fn default_channel_type() -> String {
    "text".to_string()
}

#[derive(Debug, Deserialize)]
pub struct UpdateChannelRequest {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct ChannelResponse {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub channel_type: String,
    pub encryption_mode: String,
    pub position: i32,
    pub topic: Option<String>,
    pub created_at: Option<String>,
}

impl From<mercury_core::models::Channel> for ChannelResponse {
    fn from(c: mercury_core::models::Channel) -> Self {
        ChannelResponse {
            id: c.id.to_string(),
            server_id: c.server_id.to_string(),
            name: c.name,
            channel_type: c.channel_type,
            encryption_mode: c.encryption_mode,
            position: c.position,
            topic: c.topic,
            created_at: c.created_at.map(|t| t.to_rfc3339()),
        }
    }
}

// ── Handlers ───────────────────────────────────────────────

/// POST /servers/:id/channels — create a channel (owner only).
pub async fn create_channel(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
    Json(req): Json<CreateChannelRequest>,
) -> Result<(StatusCode, Json<ChannelResponse>), MercuryError> {
    let server_id = ServerId(server_id);
    require_ownership(&state, auth_user.user_id, server_id).await?;

    if req.name.is_empty() || req.name.len() > 100 {
        return Err(MercuryError::BadRequest(
            "channel name must be 1-100 characters".into(),
        ));
    }

    match req.encryption_mode.as_str() {
        "standard" | "private" => {}
        _ => {
            return Err(MercuryError::BadRequest(
                "encryption_mode must be 'standard' or 'private'".into(),
            ));
        }
    }

    match req.channel_type.as_str() {
        "text" | "voice" | "video" => {}
        _ => {
            return Err(MercuryError::BadRequest(
                "channel_type must be 'text', 'voice', or 'video'".into(),
            ));
        }
    }

    let channel_id = ChannelId::new();

    let channel = mercury_db::channels::create_channel(
        &state.db,
        channel_id,
        server_id,
        &req.name,
        &req.channel_type,
        &req.encryption_mode,
    )
    .await?;

    Ok((StatusCode::CREATED, Json(ChannelResponse::from(channel))))
}

/// GET /servers/:id/channels — list channels in a server (requires membership).
pub async fn list_channels(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(server_id): Path<uuid::Uuid>,
) -> Result<Json<Vec<ChannelResponse>>, MercuryError> {
    let server_id = ServerId(server_id);
    require_membership(&state, auth_user.user_id, server_id).await?;

    let channels = mercury_db::channels::list_channels_for_server(&state.db, server_id).await?;
    Ok(Json(
        channels.into_iter().map(ChannelResponse::from).collect(),
    ))
}

/// PATCH /channels/:id — update channel name (owner only).
pub async fn update_channel(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(channel_id): Path<uuid::Uuid>,
    Json(req): Json<UpdateChannelRequest>,
) -> Result<Json<ChannelResponse>, MercuryError> {
    let channel_id = ChannelId(channel_id);

    // Look up which server this channel belongs to
    let server_id = mercury_db::servers::get_server_id_for_channel(&state.db, channel_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("channel not found".into()))?;

    require_ownership(&state, auth_user.user_id, server_id).await?;

    if req.name.is_empty() || req.name.len() > 100 {
        return Err(MercuryError::BadRequest(
            "channel name must be 1-100 characters".into(),
        ));
    }

    let channel = mercury_db::channels::update_channel_name(&state.db, channel_id, &req.name)
        .await?
        .ok_or_else(|| MercuryError::NotFound("channel not found".into()))?;

    Ok(Json(ChannelResponse::from(channel)))
}

/// DELETE /channels/:id — delete a channel (owner only).
pub async fn delete_channel(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(channel_id): Path<uuid::Uuid>,
) -> Result<StatusCode, MercuryError> {
    let channel_id = ChannelId(channel_id);

    let server_id = mercury_db::servers::get_server_id_for_channel(&state.db, channel_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("channel not found".into()))?;

    require_ownership(&state, auth_user.user_id, server_id).await?;

    mercury_db::channels::delete_channel(&state.db, channel_id).await?;

    Ok(StatusCode::NO_CONTENT)
}
