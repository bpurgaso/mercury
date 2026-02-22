use axum::{extract::State, Json};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use mercury_core::{error::MercuryError, ids::{DeviceId, MessageId}};
use serde::{Deserialize, Serialize};

use crate::extractors::AuthUser;
use crate::state::AppState;

// ── Response types ──────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct PendingSenderKeyResponse {
    pub message_id: String,
    pub channel_id: String,
    pub sender_id: String,
    /// Base64-encoded MessagePack blob of the SenderKeyDistributionEvent
    pub ciphertext: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AcknowledgeRequest {
    pub message_ids: Vec<String>,
}

// ── Handlers ────────────────────────────────────────────────

/// GET /sender-keys/pending — Fetch pending offline SenderKey distributions
/// for the authenticated device.
pub async fn get_pending(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Vec<PendingSenderKeyResponse>>, MercuryError> {
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

    let rows = mercury_db::messages::get_pending_sender_key_distributions(
        &state.db,
        device_id,
    )
    .await
    .map_err(MercuryError::Database)?;

    let response: Vec<PendingSenderKeyResponse> = rows
        .into_iter()
        .map(|r| PendingSenderKeyResponse {
            message_id: r.message_id.to_string(),
            channel_id: r.channel_id.map(|id| id.to_string()).unwrap_or_default(),
            sender_id: r.sender_id.to_string(),
            ciphertext: BASE64.encode(&r.ciphertext),
            created_at: r.created_at.map(|t| t.to_rfc3339()),
        })
        .collect();

    Ok(Json(response))
}

/// POST /sender-keys/acknowledge — Acknowledge (delete) fetched distributions.
pub async fn acknowledge(
    State(state): State<AppState>,
    _auth_user: AuthUser,
    Json(body): Json<AcknowledgeRequest>,
) -> Result<Json<()>, MercuryError> {
    let message_ids: Vec<MessageId> = body
        .message_ids
        .iter()
        .filter_map(|id| uuid::Uuid::parse_str(id).ok().map(MessageId))
        .collect();

    if !message_ids.is_empty() {
        mercury_db::messages::delete_sender_key_distributions(&state.db, &message_ids)
            .await
            .map_err(MercuryError::Database)?;
    }

    Ok(Json(()))
}
