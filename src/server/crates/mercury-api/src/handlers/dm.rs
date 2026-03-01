use axum::{
    extract::{Path, Query, State},
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use mercury_core::{
    error::MercuryError,
    ids::{DmChannelId, DeviceId, MessageId, UserId},
};
use serde::{Deserialize, Serialize};

use crate::extractors::AuthUser;
use crate::state::AppState;

// ── Request/Response types ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateDmRequest {
    pub recipient_id: String,
}

#[derive(Debug, Serialize)]
pub struct DmChannelResponse {
    pub id: String,
    pub recipient: DmRecipientInfo,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DmRecipientInfo {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DmMessageHistoryQuery {
    pub before: Option<uuid::Uuid>,
    pub after: Option<uuid::Uuid>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct DmMessageResponse {
    pub id: String,
    pub dm_channel_id: String,
    pub sender_id: String,
    /// Base64-encoded ciphertext
    pub ciphertext: String,
    /// Base64-encoded X3DH header (MessagePack blob)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x3dh_header: Option<String>,
    pub created_at: Option<String>,
}

// ── Handlers ───────────────────────────────────────────────

/// POST /dm — Create or get a DM channel.
pub async fn create_or_get_dm(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(body): Json<CreateDmRequest>,
) -> Result<Json<DmChannelResponse>, MercuryError> {
    let recipient_uuid = uuid::Uuid::parse_str(&body.recipient_id)
        .map_err(|_| MercuryError::BadRequest("invalid recipient_id".into()))?;
    let recipient_id = UserId(recipient_uuid);

    // Prevent creating a DM with yourself
    if recipient_id == auth_user.user_id {
        return Err(MercuryError::BadRequest("cannot create a DM with yourself".into()));
    }

    // Check if DM creation is blocked by abuse detection
    if mercury_moderation::abuse::is_dm_blocked(&state.redis, auth_user.user_id).await {
        return Err(MercuryError::Forbidden("DM creation temporarily blocked".into()));
    }

    // Verify recipient exists
    let recipient = mercury_db::users::get_user_by_id(&state.db, recipient_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("recipient not found".into()))?;

    // Check if the recipient has blocked the sender
    if mercury_moderation::blocks::is_blocked(&state.redis, recipient_id, auth_user.user_id).await {
        return Err(MercuryError::Forbidden("cannot create DM with this user".into()));
    }

    // Check if the sender has blocked the recipient
    if mercury_moderation::blocks::is_blocked(&state.redis, auth_user.user_id, recipient_id).await {
        return Err(MercuryError::Forbidden("cannot create DM with this user".into()));
    }

    // Check recipient's DM policy
    let dm_allowed = mercury_moderation::blocks::check_dm_policy(
        &state.db,
        auth_user.user_id,
        recipient_id,
    )
    .await
    .map_err(|e| MercuryError::Database(e))?;
    if !dm_allowed {
        return Err(MercuryError::Forbidden("recipient's DM policy does not allow this message".into()));
    }

    // Get or create the DM channel
    let dm_channel = mercury_db::dm_channels::get_or_create_dm_channel(
        &state.db,
        auth_user.user_id,
        recipient_id,
    )
    .await?;

    // Increment DM creation rate counter for abuse detection
    mercury_moderation::abuse::increment_dm_rate(&state.redis, auth_user.user_id).await;

    Ok(Json(DmChannelResponse {
        id: dm_channel.id.to_string(),
        recipient: DmRecipientInfo {
            id: recipient.id.to_string(),
            username: recipient.username,
            display_name: recipient.display_name,
            avatar_url: recipient.avatar_url,
        },
        created_at: dm_channel.created_at.map(|t| t.to_rfc3339()),
    }))
}

/// GET /dm — List all DM channels for the authenticated user.
pub async fn list_dm_channels(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Vec<DmChannelResponse>>, MercuryError> {
    let channels = mercury_db::dm_channels::list_dm_channels_for_user(&state.db, auth_user.user_id)
        .await?;

    let response: Vec<DmChannelResponse> = channels
        .into_iter()
        .map(|dm| DmChannelResponse {
            id: dm.id.to_string(),
            recipient: DmRecipientInfo {
                id: dm.recipient_id.to_string(),
                username: dm.recipient_username,
                display_name: dm.recipient_display_name,
                avatar_url: dm.recipient_avatar_url,
            },
            created_at: dm.created_at.map(|t| t.to_rfc3339()),
        })
        .collect();

    Ok(Json(response))
}

/// GET /dm/:id/messages — Paginated DM message history filtered by device.
pub async fn get_dm_messages(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(dm_channel_id): Path<uuid::Uuid>,
    Query(query): Query<DmMessageHistoryQuery>,
) -> Result<Json<Vec<DmMessageResponse>>, MercuryError> {
    let dm_channel_id = DmChannelId(dm_channel_id);

    // Verify the user is a member of this DM channel
    let is_member = mercury_db::dm_channels::is_dm_member(&state.db, auth_user.user_id, dm_channel_id)
        .await?;
    if !is_member {
        return Err(MercuryError::Forbidden("not a member of this DM channel".into()));
    }

    // Get device_id from the session in Redis
    let session = mercury_auth::session::get_session(&state.redis, &auth_user.jti)
        .await
        .map_err(|e| MercuryError::Internal(anyhow::anyhow!("redis error: {e}")))?
        .ok_or_else(|| MercuryError::Unauthorized("session not found".into()))?;

    let device_id_str = session.device_id
        .ok_or_else(|| MercuryError::BadRequest("device not registered in session".into()))?;
    let device_uuid = uuid::Uuid::parse_str(&device_id_str)
        .map_err(|_| MercuryError::BadRequest("invalid device_id in session".into()))?;
    let device_id = DeviceId(device_uuid);

    let limit = query.limit.unwrap_or(50).min(100).max(1);
    let before = query.before.map(MessageId);
    let after = query.after.map(MessageId);

    let messages = mercury_db::messages::get_dm_messages_paginated(
        &state.db,
        dm_channel_id,
        device_id,
        auth_user.user_id,
        before,
        after,
        limit,
    )
    .await?;

    let response: Vec<DmMessageResponse> = messages
        .into_iter()
        .map(|m| DmMessageResponse {
            id: m.id.to_string(),
            dm_channel_id: m.dm_channel_id.map(|id| id.to_string()).unwrap_or_default(),
            sender_id: m.sender_id.to_string(),
            ciphertext: BASE64.encode(&m.ciphertext),
            x3dh_header: m.x3dh_header.as_ref().map(|h| BASE64.encode(h)),
            created_at: m.created_at.map(|t| t.to_rfc3339()),
        })
        .collect();

    Ok(Json(response))
}
