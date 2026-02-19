use serde::{Deserialize, Serialize};

// ── Client → Server Operations ──────────────────────────────

/// Op codes for client-to-server messages.
/// Wire format uses snake_case strings per spec §5.2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientOp {
    Heartbeat,
    Identify,
    Resume,
    MessageSend,
    TypingStart,
    VoiceStateUpdate,
    WebrtcSignal,
    PresenceUpdate,
}

/// Envelope for client-to-server WebSocket messages.
#[derive(Debug, Deserialize)]
pub struct ClientMessage {
    pub op: ClientOp,
    #[serde(default)]
    pub d: serde_json::Value,
}

// ── Server → Client Events ──────────────────────────────────

/// Event names for server-to-client messages.
/// Wire format uses SCREAMING_SNAKE_CASE per spec §5.2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[allow(non_camel_case_types)]
pub enum ServerEvent {
    READY,
    RESUMED,
    MESSAGE_CREATE,
    TYPING_START,
    PRESENCE_UPDATE,
    VOICE_STATE_UPDATE,
    CALL_STARTED,
    CALL_ENDED,
    WEBRTC_SIGNAL,
    CALL_CONFIG,
    HEARTBEAT_ACK,
    KEY_BUNDLE_UPDATE,
    DEVICE_LIST_UPDATE,
    CHANNEL_CREATE,
    CHANNEL_UPDATE,
    CHANNEL_DELETE,
    MEMBER_ADD,
    MEMBER_REMOVE,
    USER_BANNED,
    USER_KICKED,
    USER_MUTED,
    USER_UNMUTED,
    REPORT_CREATED,
    ABUSE_SIGNAL,
    ICE_DIAGNOSTIC,
}

/// Envelope for server-to-client WebSocket messages.
#[derive(Debug, Clone, Serialize)]
pub struct ServerMessage {
    pub t: ServerEvent,
    pub d: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

// ── Payload Types ───────────────────────────────────────────

/// Payload for the `identify` client op.
#[derive(Debug, Deserialize)]
pub struct IdentifyPayload {
    pub token: String,
    pub device_id: String,
}

/// Payload for the `resume` client op.
#[derive(Debug, Deserialize)]
pub struct ResumePayload {
    pub token: String,
    pub session_id: String,
    pub seq: u64,
}

/// Payload for the `heartbeat` client op.
#[derive(Debug, Deserialize)]
pub struct HeartbeatPayload {
    pub seq: u64,
}

/// Payload for the `presence_update` client op.
#[derive(Debug, Deserialize)]
pub struct PresenceUpdatePayload {
    pub status: String,
}

/// Payload for the `typing_start` client op.
#[derive(Debug, Deserialize)]
pub struct TypingStartPayload {
    pub channel_id: String,
}

/// Payload for the READY server event.
#[derive(Debug, Serialize)]
pub struct ReadyPayload {
    pub user: ReadyUser,
    pub servers: Vec<serde_json::Value>,
    pub channels: Vec<serde_json::Value>,
    pub dm_channels: Vec<serde_json::Value>,
    pub session_id: String,
    pub heartbeat_interval: u64,
}

/// User info included in the READY payload.
#[derive(Debug, Serialize)]
pub struct ReadyUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub avatar_url: Option<String>,
    pub status: Option<String>,
}

/// Payload for the RESUMED server event.
#[derive(Debug, Serialize)]
pub struct ResumedPayload {
    pub replayed_events: u64,
}

/// Payload for PRESENCE_UPDATE server event.
#[derive(Debug, Serialize)]
pub struct PresenceUpdateEvent {
    pub user_id: String,
    pub status: String,
}

/// Payload for the `message_send` client op (standard channel — JSON text frame).
#[derive(Debug, Deserialize)]
pub struct MessageSendPayload {
    pub channel_id: String,
    pub content: Option<String>,
}

/// Payload for the MESSAGE_CREATE server event (standard channel).
#[derive(Debug, Serialize)]
pub struct MessageCreatePayload {
    pub id: String,
    pub channel_id: String,
    pub sender_id: String,
    pub content: Option<String>,
    pub created_at: String,
}

/// Payload for CHANNEL_CREATE server event.
#[derive(Debug, Serialize)]
pub struct ChannelCreatePayload {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub channel_type: String,
    pub encryption_mode: String,
    pub position: i32,
    pub topic: Option<String>,
    pub created_at: Option<String>,
}

/// Payload for CHANNEL_UPDATE server event.
#[derive(Debug, Serialize)]
pub struct ChannelUpdatePayload {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub channel_type: String,
    pub encryption_mode: String,
    pub position: i32,
    pub topic: Option<String>,
    pub created_at: Option<String>,
}

/// Payload for CHANNEL_DELETE server event.
#[derive(Debug, Serialize)]
pub struct ChannelDeletePayload {
    pub id: String,
    pub server_id: String,
}

/// Payload for MEMBER_ADD server event.
#[derive(Debug, Serialize)]
pub struct MemberAddPayload {
    pub server_id: String,
    pub user_id: String,
}

/// Payload for MEMBER_REMOVE server event.
#[derive(Debug, Serialize)]
pub struct MemberRemovePayload {
    pub server_id: String,
    pub user_id: String,
}

/// WebSocket close codes used by Mercury.
pub mod close_codes {
    /// Invalid or expired authentication token.
    pub const INVALID_TOKEN: u16 = 4008;
    /// Session expired or heartbeat timeout.
    pub const SESSION_EXPIRED: u16 = 4009;
}

/// Default heartbeat interval in seconds.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 30;

/// Number of missed heartbeats before disconnect.
pub const HEARTBEAT_MISS_LIMIT: u32 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_op_serialize_roundtrip() {
        let ops = vec![
            (ClientOp::Heartbeat, "\"heartbeat\""),
            (ClientOp::Identify, "\"identify\""),
            (ClientOp::Resume, "\"resume\""),
            (ClientOp::MessageSend, "\"message_send\""),
            (ClientOp::TypingStart, "\"typing_start\""),
            (ClientOp::VoiceStateUpdate, "\"voice_state_update\""),
            (ClientOp::WebrtcSignal, "\"webrtc_signal\""),
            (ClientOp::PresenceUpdate, "\"presence_update\""),
        ];

        for (op, expected_json) in ops {
            let serialized = serde_json::to_string(&op).expect("serialize");
            assert_eq!(serialized, expected_json, "serialization mismatch for {:?}", op);

            let deserialized: ClientOp =
                serde_json::from_str(&serialized).expect("deserialize");
            assert_eq!(deserialized, op, "roundtrip mismatch for {:?}", op);
        }
    }

    #[test]
    fn server_event_serialize_roundtrip() {
        let events = vec![
            (ServerEvent::READY, "\"READY\""),
            (ServerEvent::RESUMED, "\"RESUMED\""),
            (ServerEvent::MESSAGE_CREATE, "\"MESSAGE_CREATE\""),
            (ServerEvent::TYPING_START, "\"TYPING_START\""),
            (ServerEvent::PRESENCE_UPDATE, "\"PRESENCE_UPDATE\""),
            (ServerEvent::VOICE_STATE_UPDATE, "\"VOICE_STATE_UPDATE\""),
            (ServerEvent::CALL_STARTED, "\"CALL_STARTED\""),
            (ServerEvent::CALL_ENDED, "\"CALL_ENDED\""),
            (ServerEvent::WEBRTC_SIGNAL, "\"WEBRTC_SIGNAL\""),
            (ServerEvent::CALL_CONFIG, "\"CALL_CONFIG\""),
            (ServerEvent::HEARTBEAT_ACK, "\"HEARTBEAT_ACK\""),
            (ServerEvent::KEY_BUNDLE_UPDATE, "\"KEY_BUNDLE_UPDATE\""),
            (ServerEvent::DEVICE_LIST_UPDATE, "\"DEVICE_LIST_UPDATE\""),
            (ServerEvent::CHANNEL_CREATE, "\"CHANNEL_CREATE\""),
            (ServerEvent::CHANNEL_UPDATE, "\"CHANNEL_UPDATE\""),
            (ServerEvent::CHANNEL_DELETE, "\"CHANNEL_DELETE\""),
            (ServerEvent::MEMBER_ADD, "\"MEMBER_ADD\""),
            (ServerEvent::MEMBER_REMOVE, "\"MEMBER_REMOVE\""),
            (ServerEvent::USER_BANNED, "\"USER_BANNED\""),
            (ServerEvent::USER_KICKED, "\"USER_KICKED\""),
            (ServerEvent::USER_MUTED, "\"USER_MUTED\""),
            (ServerEvent::USER_UNMUTED, "\"USER_UNMUTED\""),
            (ServerEvent::REPORT_CREATED, "\"REPORT_CREATED\""),
            (ServerEvent::ABUSE_SIGNAL, "\"ABUSE_SIGNAL\""),
            (ServerEvent::ICE_DIAGNOSTIC, "\"ICE_DIAGNOSTIC\""),
        ];

        for (event, expected_json) in events {
            let serialized = serde_json::to_string(&event).expect("serialize");
            assert_eq!(serialized, expected_json, "serialization mismatch for {:?}", event);

            let deserialized: ServerEvent =
                serde_json::from_str(&serialized).expect("deserialize");
            assert_eq!(deserialized, event, "roundtrip mismatch for {:?}", event);
        }
    }

    #[test]
    fn client_message_deserialize() {
        let json = r#"{"op":"identify","d":{"token":"jwt","device_id":"dev1"}}"#;
        let msg: ClientMessage = serde_json::from_str(json).expect("deserialize");
        assert_eq!(msg.op, ClientOp::Identify);
        assert_eq!(msg.d["token"], "jwt");
        assert_eq!(msg.d["device_id"], "dev1");
    }

    #[test]
    fn server_message_serialize() {
        let msg = ServerMessage {
            t: ServerEvent::HEARTBEAT_ACK,
            d: serde_json::json!({}),
            seq: None,
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains("\"t\":\"HEARTBEAT_ACK\""));
        assert!(json.contains("\"d\":{}"));
        // seq should be omitted when None
        assert!(!json.contains("\"seq\""));
    }

    #[test]
    fn server_message_with_seq() {
        let msg = ServerMessage {
            t: ServerEvent::PRESENCE_UPDATE,
            d: serde_json::json!({"user_id": "abc", "status": "online"}),
            seq: Some(42),
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains("\"seq\":42"));
    }

    #[test]
    fn identify_payload_deserialize() {
        let json = r#"{"token":"my-jwt","device_id":"device-123"}"#;
        let payload: IdentifyPayload = serde_json::from_str(json).expect("deserialize");
        assert_eq!(payload.token, "my-jwt");
        assert_eq!(payload.device_id, "device-123");
    }

    #[test]
    fn resume_payload_deserialize() {
        let json = r#"{"token":"my-jwt","session_id":"sess-1","seq":42}"#;
        let payload: ResumePayload = serde_json::from_str(json).expect("deserialize");
        assert_eq!(payload.token, "my-jwt");
        assert_eq!(payload.session_id, "sess-1");
        assert_eq!(payload.seq, 42);
    }
}
