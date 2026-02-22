use axum::{
    extract::{Path, Query, State},
    Json,
};
use mercury_core::{
    error::MercuryError,
    ids::{ChannelId, MessageId},
};
use serde::{Deserialize, Serialize};

use crate::extractors::{require_membership, AuthUser};
use crate::state::AppState;

// ── Request/Response types ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct MessageHistoryQuery {
    pub before: Option<uuid::Uuid>,
    pub after: Option<uuid::Uuid>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub id: String,
    pub channel_id: Option<String>,
    pub sender_id: String,
    pub content: Option<String>,
    pub message_type: Option<String>,
    pub created_at: Option<String>,
    pub edited_at: Option<String>,
}

impl From<mercury_core::models::Message> for MessageResponse {
    fn from(m: mercury_core::models::Message) -> Self {
        MessageResponse {
            id: m.id.to_string(),
            channel_id: m.channel_id.map(|id| id.to_string()),
            sender_id: m.sender_id.to_string(),
            content: m.content,
            message_type: m.message_type,
            created_at: m.created_at.map(|t| t.to_rfc3339()),
            edited_at: m.edited_at.map(|t| t.to_rfc3339()),
        }
    }
}

/// Response for private channel message history (includes encrypted payload).
#[derive(Debug, Serialize)]
pub struct PrivateMessageResponse {
    pub id: String,
    pub channel_id: Option<String>,
    pub sender_id: String,
    pub ciphertext: Vec<u8>,
    pub message_type: Option<String>,
    pub created_at: Option<String>,
    pub edited_at: Option<String>,
}

/// Unified response that can be either standard or encrypted.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ChannelMessageResponse {
    Standard(MessageResponse),
    Private(PrivateMessageResponse),
}

// ── Handlers ───────────────────────────────────────────────

/// GET /channels/:id/messages — paginated, cursor-based message history.
/// Returns plaintext for standard channels, encrypted payload for private channels.
pub async fn get_messages(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(channel_id): Path<uuid::Uuid>,
    Query(query): Query<MessageHistoryQuery>,
) -> Result<Json<Vec<ChannelMessageResponse>>, MercuryError> {
    let channel_id = ChannelId(channel_id);

    // Look up the channel to check encryption_mode
    let channel = mercury_db::channels::get_channel_by_id(&state.db, channel_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("channel not found".into()))?;

    require_membership(&state, auth_user.user_id, channel.server_id).await?;

    let limit = query.limit.unwrap_or(50).min(100).max(1);
    let before = query.before.map(MessageId);
    let after = query.after.map(MessageId);

    match channel.encryption_mode.as_str() {
        "private" => {
            // Private channel: return messages with broadcast ciphertext
            let messages = mercury_db::messages::get_private_channel_messages_paginated(
                &state.db,
                channel_id,
                before,
                after,
                limit,
            )
            .await?;

            let response: Vec<ChannelMessageResponse> = messages
                .into_iter()
                .map(|m| {
                    ChannelMessageResponse::Private(PrivateMessageResponse {
                        id: m.id.to_string(),
                        channel_id: m.channel_id.map(|id| id.to_string()),
                        sender_id: m.sender_id.to_string(),
                        ciphertext: m.ciphertext,
                        message_type: m.message_type,
                        created_at: m.created_at.map(|t| t.to_rfc3339()),
                        edited_at: m.edited_at.map(|t| t.to_rfc3339()),
                    })
                })
                .collect();

            Ok(Json(response))
        }
        _ => {
            // Standard channel: return plaintext messages
            let messages = mercury_db::messages::get_messages_paginated(
                &state.db,
                channel_id,
                before,
                after,
                limit,
            )
            .await?;

            let response: Vec<ChannelMessageResponse> = messages
                .into_iter()
                .map(|m| ChannelMessageResponse::Standard(MessageResponse::from(m)))
                .collect();

            Ok(Json(response))
        }
    }
}
