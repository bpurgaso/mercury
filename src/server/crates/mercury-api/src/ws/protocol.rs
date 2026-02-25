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
    SenderKeyDistribute,
}

/// Envelope for client-to-server WebSocket messages (JSON text frames).
#[derive(Debug, Deserialize)]
pub struct ClientMessage {
    pub op: ClientOp,
    #[serde(default)]
    pub d: serde_json::Value,
}

/// Envelope for client-to-server WebSocket messages (MessagePack binary frames).
/// Uses rmpv::Value for the data field to support binary payloads.
#[derive(Debug, Deserialize)]
pub struct BinaryClientMessage {
    pub op: ClientOp,
    #[serde(default = "default_rmpv_nil")]
    pub d: rmpv::Value,
}

fn default_rmpv_nil() -> rmpv::Value {
    rmpv::Value::Nil
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
    SENDER_KEY_DISTRIBUTION,
    ERROR,
}

/// Envelope for server-to-client WebSocket messages (JSON text frames).
#[derive(Debug, Clone, Serialize)]
pub struct ServerMessage {
    pub t: ServerEvent,
    pub d: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

/// Pre-encoded server message that can be sent as either JSON text or MessagePack binary.
/// Used to avoid re-serializing when sending to multiple clients.
#[derive(Debug, Clone)]
pub enum EncodedServerMessage {
    /// JSON text frame
    Text(ServerMessage),
    /// Pre-encoded MessagePack bytes for a binary frame
    Binary(Vec<u8>),
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

// ── E2E DM Payload Types ──────────────────────────────────

/// Payload for `message_send` with E2E DM (MessagePack binary frame).
#[derive(Debug, Deserialize, Serialize)]
pub struct DmMessageSendPayload {
    pub dm_channel_id: String,
    pub recipients: Vec<DmRecipient>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DmRecipient {
    pub device_id: String,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
    pub x3dh_header: Option<X3dhHeader>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct X3dhHeader {
    #[serde(with = "serde_bytes")]
    pub sender_identity_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ephemeral_key: Vec<u8>,
    pub prekey_id: i32,
}

/// MESSAGE_CREATE payload for E2E DMs — sent per-device with only that device's ciphertext.
#[derive(Debug, Serialize)]
pub struct DmMessageCreatePayload {
    pub id: String,
    pub dm_channel_id: String,
    pub sender_id: String,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x3dh_header: Option<X3dhHeaderPayload>,
    pub created_at: String,
}

/// X3DH header in MESSAGE_CREATE — returned as-is from storage.
#[derive(Debug, Serialize)]
pub struct X3dhHeaderPayload {
    #[serde(with = "serde_bytes")]
    pub sender_identity_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ephemeral_key: Vec<u8>,
    pub prekey_id: i32,
}

// ── Private Channel (Sender Key) Payload Types ─────────────

/// Payload for `message_send` with private channel (MessagePack binary frame).
#[derive(Debug, Deserialize, Serialize)]
pub struct PrivateMessageSendPayload {
    pub channel_id: String,
    pub encrypted: SenderKeyPayload,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SenderKeyPayload {
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub nonce: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
    pub sender_device_id: String,
    pub iteration: i64,
    pub epoch: i64,
}

/// MESSAGE_CREATE payload for private channels — broadcast to all members.
#[derive(Debug, Serialize)]
pub struct PrivateMessageCreatePayload {
    pub id: String,
    pub channel_id: String,
    pub sender_id: String,
    pub encrypted: SenderKeyPayload,
    pub created_at: String,
}

// ── Sender Key Distribution Payload Types ───────────────────

/// Payload for `sender_key_distribute` client op (MessagePack binary frame).
#[derive(Debug, Deserialize, Serialize)]
pub struct SenderKeyDistributePayload {
    pub channel_id: String,
    pub distributions: Vec<SenderKeyDistribution>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SenderKeyDistribution {
    pub device_id: String,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

/// SENDER_KEY_DISTRIBUTION server event payload.
#[derive(Debug, Serialize)]
pub struct SenderKeyDistributionEvent {
    pub channel_id: String,
    pub sender_id: String,
    pub sender_device_id: String,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

// ── Error Payload ───────────────────────────────────────────

/// ERROR server event payload.
#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

// ── Channel Event Payloads ──────────────────────────────────

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

// ── Voice / Call Payloads ───────────────────────────────────

/// Payload for the `voice_state_update` client op.
#[derive(Debug, Deserialize)]
pub struct VoiceStateUpdatePayload {
    /// Channel to join, or null/absent to leave.
    pub channel_id: Option<String>,
    #[serde(default)]
    pub self_mute: bool,
    #[serde(default)]
    pub self_deaf: bool,
}

/// Payload for the `webrtc_signal` client op.
#[derive(Debug, Deserialize)]
pub struct WebrtcSignalPayload {
    pub room_id: String,
    pub signal: mercury_media::WebRtcSignalData,
}

/// Payload for VOICE_STATE_UPDATE server event.
#[derive(Debug, Serialize)]
pub struct VoiceStateUpdateEvent {
    pub user_id: String,
    pub channel_id: Option<String>,
    pub self_mute: bool,
    pub self_deaf: bool,
}

/// Payload for CALL_STARTED server event.
#[derive(Debug, Serialize)]
pub struct CallStartedEvent {
    pub room_id: String,
    pub channel_id: String,
    pub initiator_id: String,
}

/// Payload for CALL_ENDED server event.
#[derive(Debug, Serialize)]
pub struct CallEndedEvent {
    pub room_id: String,
}

/// Payload for WEBRTC_SIGNAL server event.
#[derive(Debug, Serialize)]
pub struct WebrtcSignalEvent {
    pub from_user: String,
    pub signal: mercury_media::WebRtcSignalData,
}

/// Payload for CALL_CONFIG server event.
#[derive(Debug, Serialize)]
pub struct CallConfigEvent {
    pub room_id: String,
    pub turn_urls: Vec<String>,
    pub stun_urls: Vec<String>,
    pub username: String,
    pub credential: String,
    pub ttl: u64,
    pub audio: AudioLimitsPayload,
    pub video: VideoLimitsPayload,
}

#[derive(Debug, Serialize)]
pub struct AudioLimitsPayload {
    pub max_bitrate_kbps: u32,
    pub preferred_bitrate_kbps: u32,
}

#[derive(Debug, Serialize)]
pub struct VideoLimitsPayload {
    pub max_bitrate_kbps: u32,
    pub max_resolution: String,
    pub max_framerate: u32,
}

/// WebSocket close codes used by Mercury.
pub mod close_codes {
    /// Invalid or expired authentication token.
    pub const INVALID_TOKEN: u16 = 4008;
    /// Session expired or heartbeat timeout.
    pub const SESSION_EXPIRED: u16 = 4009;
}

/// Maximum message payload size in bytes.
pub const MAX_MESSAGE_PAYLOAD_SIZE: usize = 65536;

/// Default heartbeat interval in seconds.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 30;

/// Number of missed heartbeats before disconnect.
pub const HEARTBEAT_MISS_LIMIT: u32 = 3;

/// Encode a server message as a MessagePack binary frame.
/// The message is a map with "t", "d", and optionally "seq" keys.
pub fn encode_msgpack_server_message(
    event: ServerEvent,
    payload: &impl Serialize,
    seq: Option<u64>,
) -> Vec<u8> {
    // Build the value as an rmpv::Value map
    let t_val = rmpv::Value::String(
        serde_json::to_value(&event)
            .unwrap_or_default()
            .as_str()
            .unwrap_or("")
            .into(),
    );
    // Serialize with rmp_serde::to_vec_named to preserve struct field names as map keys,
    // then decode back to rmpv::Value. Using rmpv::ext::to_value would serialize
    // structs as arrays, losing field names.
    let d_bytes = rmp_serde::to_vec_named(payload).unwrap_or_default();
    let d_val = rmpv::decode::read_value(&mut &d_bytes[..]).unwrap_or(rmpv::Value::Nil);

    let mut pairs = vec![
        (rmpv::Value::String("t".into()), t_val),
        (rmpv::Value::String("d".into()), d_val),
    ];

    if let Some(s) = seq {
        pairs.push((
            rmpv::Value::String("seq".into()),
            rmpv::Value::Integer(s.into()),
        ));
    }

    let map = rmpv::Value::Map(pairs);
    let mut buf = Vec::new();
    rmpv::encode::write_value(&mut buf, &map).expect("msgpack encode failed");
    buf
}

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
            (ClientOp::SenderKeyDistribute, "\"sender_key_distribute\""),
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
            (ServerEvent::SENDER_KEY_DISTRIBUTION, "\"SENDER_KEY_DISTRIBUTION\""),
            (ServerEvent::ERROR, "\"ERROR\""),
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

    #[test]
    fn msgpack_encode_decode_roundtrip() {
        let payload = MessageCreatePayload {
            id: "msg-1".to_string(),
            channel_id: "ch-1".to_string(),
            sender_id: "user-1".to_string(),
            content: Some("hello".to_string()),
            created_at: "2024-01-01T00:00:00Z".to_string(),
        };

        let bytes = encode_msgpack_server_message(
            ServerEvent::MESSAGE_CREATE,
            &payload,
            Some(1),
        );

        // Decode back
        let val: rmpv::Value = rmpv::decode::read_value(&mut &bytes[..]).expect("decode");
        let map = val.as_map().expect("should be map");
        let t = map.iter().find(|(k, _)| k.as_str() == Some("t")).unwrap().1.as_str().unwrap();
        assert_eq!(t, "MESSAGE_CREATE");
    }
}
