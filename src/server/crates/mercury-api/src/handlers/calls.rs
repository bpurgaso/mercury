use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use mercury_core::{
    error::MercuryError,
    ids::{ChannelId, DmChannelId},
};
use serde::{Deserialize, Serialize};

use crate::extractors::AuthUser;
use crate::state::AppState;
use crate::ws::protocol::*;

// ── Request/Response types ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateCallRequest {
    pub channel_id: String,
}

#[derive(Debug, Serialize)]
pub struct CallResponse {
    pub room_id: String,
    pub channel_id: String,
    pub participants: Vec<ParticipantResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_config: Option<CallConfigEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ParticipantResponse {
    pub user_id: String,
    pub self_mute: bool,
    pub self_deaf: bool,
}

// ── Handlers ───────────────────────────────────────────────

/// POST /calls — initiate a call (creates room if not exists, joins user).
/// Supports both server voice channels and DM channels.
pub async fn create_call(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<CreateCallRequest>,
) -> Result<(StatusCode, Json<CallResponse>), MercuryError> {
    let channel_uuid = uuid::Uuid::parse_str(&req.channel_id)
        .map_err(|_| MercuryError::BadRequest("invalid channel_id".into()))?;
    let channel_id = ChannelId(channel_uuid);

    // Try server channel first, then fall back to DM channel
    let server_id = if let Some(channel) =
        mercury_db::channels::get_channel_by_id(&state.db, channel_id).await?
    {
        // Server channel — must be voice or video type
        if channel.channel_type != "voice" && channel.channel_type != "video" {
            return Err(MercuryError::BadRequest(
                "channel is not a voice/video channel".into(),
            ));
        }

        // Check server membership
        let is_member =
            mercury_db::servers::is_member(&state.db, auth_user.user_id, channel.server_id)
                .await
                .map_err(|e| MercuryError::Database(e))?;
        if !is_member {
            return Err(MercuryError::Forbidden(
                "not a member of this server".into(),
            ));
        }

        Some(channel.server_id)
    } else {
        // Try as DM channel
        let dm_channel_id = DmChannelId(channel_uuid);
        let _dm_channel = mercury_db::dm_channels::get_dm_channel_by_id(&state.db, dm_channel_id)
            .await
            .map_err(|e| MercuryError::Database(e))?
            .ok_or_else(|| MercuryError::NotFound("channel not found".into()))?;

        // Check DM membership
        let is_dm_member =
            mercury_db::dm_channels::is_dm_member(&state.db, auth_user.user_id, dm_channel_id)
                .await
                .map_err(|e| MercuryError::Database(e))?;
        if !is_dm_member {
            return Err(MercuryError::Forbidden(
                "not a member of this DM channel".into(),
            ));
        }

        None // DM calls have no server_id
    };

    // Join via SFU (creates room if needed)
    let join_result = state
        .sfu_handle
        .join_room(
            auth_user.user_id,
            "rest-api".to_string(),
            channel_id,
            server_id,
        )
        .await
        .map_err(|e| match e {
            mercury_media::SfuError::RoomFull => {
                MercuryError::BadRequest("room is full".into())
            }
            _ => MercuryError::Internal(anyhow::anyhow!("{e}")),
        })?;

    // Generate CALL_CONFIG
    let turn_creds = mercury_auth::turn::generate_turn_credentials(
        &auth_user.user_id.to_string(),
        &mercury_core::config::TurnConfig {
            enabled: true,
            secret: if state.media_config.ice.turn_secret.is_empty() {
                state.turn_config.secret.clone()
            } else {
                state.media_config.ice.turn_secret.clone()
            },
            urls: state.media_config.ice.turn_urls.clone(),
            credential_ttl_seconds: state.turn_config.credential_ttl_seconds,
        },
    );

    let call_config = CallConfigEvent {
        room_id: join_result.room_id.clone(),
        turn_urls: turn_creds.urls,
        stun_urls: state.media_config.ice.stun_urls.clone(),
        username: turn_creds.username,
        credential: turn_creds.credential,
        ttl: turn_creds.ttl,
        audio: AudioLimitsPayload {
            max_bitrate_kbps: state.media_config.audio.max_bitrate_kbps,
            preferred_bitrate_kbps: state.media_config.audio.preferred_bitrate_kbps,
        },
        video: VideoLimitsPayload {
            max_bitrate_kbps: state.media_config.video.max_bitrate_kbps,
            max_resolution: state.media_config.video.max_resolution.clone(),
            max_framerate: state.media_config.video.max_framerate,
            simulcast_enabled: state.media_config.video.simulcast_enabled,
            simulcast_layers: state.media_config.video.simulcast_layers.clone(),
        },
    };

    let participants = join_result
        .participants
        .iter()
        .map(|p| ParticipantResponse {
            user_id: p.user_id.clone(),
            self_mute: p.self_mute,
            self_deaf: p.self_deaf,
        })
        .collect();

    Ok((
        StatusCode::OK,
        Json(CallResponse {
            room_id: join_result.room_id,
            channel_id: req.channel_id,
            participants,
            call_config: Some(call_config),
            started_at: None,
        }),
    ))
}

/// GET /calls/:id — get call info.
pub async fn get_call(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<CallResponse>, MercuryError> {
    let room_info = state
        .sfu_handle
        .get_room(room_id)
        .await
        .ok_or_else(|| MercuryError::NotFound("call not found".into()))?;

    // Verify the caller has access — check server or DM membership via channel
    let channel_uuid = uuid::Uuid::parse_str(&room_info.channel_id)
        .map_err(|_| MercuryError::Internal(anyhow::anyhow!("invalid channel_id in room")))?;
    let channel_id = ChannelId(channel_uuid);

    let has_access = if let Some(channel) =
        mercury_db::channels::get_channel_by_id(&state.db, channel_id).await?
    {
        // Server channel — check server membership
        mercury_db::servers::is_member(&state.db, auth_user.user_id, channel.server_id)
            .await
            .map_err(|e| MercuryError::Database(e))?
    } else {
        // Try as DM channel
        let dm_channel_id = DmChannelId(channel_uuid);
        mercury_db::dm_channels::is_dm_member(&state.db, auth_user.user_id, dm_channel_id)
            .await
            .map_err(|e| MercuryError::Database(e))?
    };

    if !has_access {
        return Err(MercuryError::Forbidden(
            "not a member of this channel".into(),
        ));
    }

    let participants = room_info
        .participants
        .iter()
        .map(|p| ParticipantResponse {
            user_id: p.user_id.clone(),
            self_mute: p.self_mute,
            self_deaf: p.self_deaf,
        })
        .collect();

    Ok(Json(CallResponse {
        room_id: room_info.room_id,
        channel_id: room_info.channel_id,
        participants,
        call_config: None,
        started_at: Some(room_info.started_at),
    }))
}
