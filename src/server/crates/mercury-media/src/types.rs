use mercury_core::ids::{ChannelId, ServerId, UserId};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

// ── SFU Error ───────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SfuError {
    #[error("room is full")]
    RoomFull,
    #[error("not in a room")]
    NotInRoom,
    #[error("room not found")]
    RoomNotFound,
    #[error("already in this room")]
    AlreadyInRoom,
    #[error("internal error: {0}")]
    Internal(String),
}

// ── API → SFU Commands ─────────────────────────────────────

pub enum SfuCommand {
    JoinRoom {
        user_id: UserId,
        device_id: String,
        channel_id: ChannelId,
        server_id: Option<ServerId>,
        reply: oneshot::Sender<Result<JoinResult, SfuError>>,
    },
    LeaveRoom {
        user_id: UserId,
        channel_id: ChannelId,
    },
    LeaveAll {
        user_id: UserId,
    },
    WebRtcSignal {
        user_id: UserId,
        room_id: String,
        signal: WebRtcSignalData,
        reply: oneshot::Sender<Result<Option<WebRtcSignalData>, SfuError>>,
    },
    UpdateVoiceState {
        user_id: UserId,
        channel_id: ChannelId,
        self_mute: bool,
        self_deaf: bool,
    },
    GetRoom {
        room_id: String,
        reply: oneshot::Sender<Option<RoomInfo>>,
    },
    GetRoomByChannel {
        channel_id: ChannelId,
        reply: oneshot::Sender<Option<RoomInfo>>,
    },
}

// ── SFU → API Events ───────────────────────────────────────

#[derive(Debug, Clone)]
pub enum SfuEvent {
    VoiceStateUpdate {
        user_id: UserId,
        channel_id: ChannelId,
        self_mute: bool,
        self_deaf: bool,
        server_id: Option<ServerId>,
    },
    CallStarted {
        room_id: String,
        channel_id: ChannelId,
        initiator_id: UserId,
        server_id: Option<ServerId>,
    },
    CallEnded {
        room_id: String,
        channel_id: ChannelId,
        server_id: Option<ServerId>,
    },
    ParticipantLeft {
        user_id: UserId,
        channel_id: ChannelId,
        server_id: Option<ServerId>,
    },
    WebRtcSignal {
        target_user: UserId,
        from_user: UserId,
        signal: WebRtcSignalData,
    },
}

// ── Shared Data Types ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebRtcSignalData {
    #[serde(rename = "type")]
    pub signal_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallConfigData {
    pub room_id: String,
    pub turn_urls: Vec<String>,
    pub stun_urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u64,
    pub audio: AudioLimits,
    pub video: VideoLimits,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioLimits {
    pub max_bitrate_kbps: u32,
    pub preferred_bitrate_kbps: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoLimits {
    pub max_bitrate_kbps: u32,
    pub max_resolution: String,
    pub max_framerate: u32,
}

#[derive(Debug, Clone)]
pub struct JoinResult {
    pub room_id: String,
    pub is_new_room: bool,
    pub participants: Vec<ParticipantInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParticipantInfo {
    pub user_id: String,
    pub self_mute: bool,
    pub self_deaf: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoomInfo {
    pub room_id: String,
    pub channel_id: String,
    pub participants: Vec<ParticipantInfo>,
    pub started_at: String,
}
