# Phase 8: SFU Media Engine & Call Signaling

## Problem Statement

Mercury has real-time messaging (text, E2E encrypted DMs, Sender Key channels) but no voice/video calling. Users need to join voice channels and initiate calls within servers and DMs. The server must route WebRTC signaling between clients and manage call lifecycle (room creation, participant tracking, teardown), while the actual media flows peer-to-SFU using selective forwarding.

**Who has this problem?** Every Mercury user who wants real-time voice/video communication.

## Proposed Solution

Build a call signaling infrastructure and SFU room manager inside the existing `mercury-media` crate. The SFU runtime runs on a **dedicated Tokio runtime** with CPU-pinned worker threads, isolated from the API runtime via bounded mpsc channels. Room state is entirely in-memory (calls are ephemeral). WebRTC session management uses **str0m** (pure Rust WebRTC). TURN credential generation already exists in `mercury-auth`.

## Goals

1. Users can join/leave voice channels via `voice_state_update` WebSocket op
2. WebRTC signaling (SDP offer/answer, ICE candidates) relayed via `webrtc_signal` op
3. Server broadcasts `VOICE_STATE_UPDATE`, `CALL_STARTED`, `CALL_ENDED`, `WEBRTC_SIGNAL`, `CALL_CONFIG` events
4. REST endpoints `POST /calls` and `GET /calls/:id` for call initiation and info
5. TURN credentials delivered in `CALL_CONFIG` using existing `mercury-auth::turn` module
6. Configurable media quality limits delivered in `CALL_CONFIG`
7. Room capacity enforced (default 25 participants)
8. SFU runtime isolated on dedicated cores with core affinity
9. Empty rooms cleaned up after 5-minute timeout
10. All 11 integration tests pass

## Non-Goals

- **Actual media packet forwarding**: str0m integration for RTP/RTCP handling is scaffolded but the UDP socket loop and packet forwarding are deferred to a follow-up phase. This phase focuses on signaling, room management, and the SFU runtime infrastructure.
- **Simulcast layer selection**: Quality adaptation logic deferred.
- **P2P fallback**: The `target_user` field in `webrtc_signal` enables future P2P but is not implemented.
- **Recording**: No call recording.
- **Screen sharing**: Deferred.

## Detailed Design

### 1. SFU Runtime Setup (`mercury-media`)

**Dedicated Tokio Runtime:**
```rust
// In mercury-media/src/runtime.rs
pub struct SfuRuntime {
    runtime: tokio::runtime::Runtime,
    command_tx: tokio::sync::mpsc::Sender<SfuCommand>,
    event_rx: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<SfuEvent>>,
}
```

- Create with `tokio::runtime::Builder::new_multi_thread()`
- Worker thread count from config `[media].dedicated_cores` (default: 2)
- Pin worker threads to last N CPU cores using `core_affinity` crate
- Bounded mpsc channel (capacity 1024) between API runtime and SFU runtime
- `SfuCommand` enum: `JoinRoom`, `LeaveRoom`, `WebRtcSignal`, `UpdateVoiceState`
- `SfuEvent` enum: `RoomCreated`, `RoomDestroyed`, `ParticipantJoined`, `ParticipantLeft`, `WebRtcSignal`, `CallConfig`

**Channel Messages (API → SFU):**
```rust
pub enum SfuCommand {
    JoinRoom {
        user_id: UserId,
        device_id: String,
        channel_id: ChannelId,
        server_id: ServerId,
        reply: oneshot::Sender<Result<JoinResult, SfuError>>,
    },
    LeaveRoom {
        user_id: UserId,
        channel_id: ChannelId,
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
}
```

**Channel Messages (SFU → API):**
```rust
pub enum SfuEvent {
    VoiceStateUpdate {
        user_id: UserId,
        channel_id: ChannelId,
        self_mute: bool,
        self_deaf: bool,
    },
    CallStarted {
        room_id: String,
        channel_id: ChannelId,
        initiator_id: UserId,
    },
    CallEnded {
        room_id: String,
    },
    WebRtcSignal {
        target_user: UserId,
        from_user: UserId,
        signal: WebRtcSignalData,
    },
    CallConfig {
        target_user: UserId,
        config: CallConfigData,
    },
}
```

### 2. Room Management

**Data Structures:**
```rust
pub struct Room {
    pub room_id: String,           // UUIDv7
    pub channel_id: ChannelId,
    pub server_id: Option<ServerId>,
    pub participants: HashMap<UserId, Participant>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub struct Participant {
    pub user_id: UserId,
    pub device_id: String,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub joined_at: chrono::DateTime<chrono::Utc>,
}
```

**Room Manager** (runs on SFU runtime):
```rust
pub struct RoomManager {
    rooms_by_id: HashMap<String, Room>,
    rooms_by_channel: HashMap<ChannelId, String>,  // channel_id → room_id
    max_participants: usize,                        // default 25
    empty_room_timeout: Duration,                   // default 5 min
}
```

**Lifecycle:**
- Room created when first user joins a channel (via `voice_state_update` with non-null `channel_id`)
- Room ID is UUIDv7
- Room destroyed when last participant leaves OR after 5-minute empty timeout
- Joining a room while already in another room: leave the old room first (implicit leave)
- Joining with `channel_id: null`: explicit leave from current room

### 3. str0m Integration (Scaffolded)

For this phase, str0m is added as a dependency and session creation is scaffolded but the UDP media loop is not wired up. The signaling (SDP/ICE) flows through the SFU room manager:

- When a participant joins and receives `CALL_CONFIG`, the client sends an SDP offer via `webrtc_signal`
- The SFU generates an SDP answer (using str0m's session builder) and returns it via `WEBRTC_SIGNAL`
- ICE candidates are relayed bidirectionally
- **For this phase**: SDP offer/answer exchange is simulated — the server acknowledges the signal and returns a placeholder answer. Full str0m media negotiation is deferred.

### 4. WebSocket Signaling Ops

**Client → Server:**

`voice_state_update` (JSON text frame):
```json
{
  "op": "voice_state_update",
  "d": {
    "channel_id": "uuid-or-null",
    "self_mute": false,
    "self_deaf": false
  }
}
```

`webrtc_signal` (JSON text frame):
```json
{
  "op": "webrtc_signal",
  "d": {
    "room_id": "uuid",
    "signal": {
      "type": "offer|answer|ice_candidate",
      "sdp": "...",
      "candidate": "..."
    }
  }
}
```

**Server → Client:**

`VOICE_STATE_UPDATE`:
```json
{
  "t": "VOICE_STATE_UPDATE",
  "d": {
    "user_id": "uuid",
    "channel_id": "uuid-or-null",
    "self_mute": false,
    "self_deaf": false
  }
}
```

`CALL_STARTED`:
```json
{
  "t": "CALL_STARTED",
  "d": {
    "room_id": "uuid",
    "channel_id": "uuid",
    "initiator_id": "uuid"
  }
}
```

`CALL_ENDED`:
```json
{
  "t": "CALL_ENDED",
  "d": {
    "room_id": "uuid"
  }
}
```

`WEBRTC_SIGNAL`:
```json
{
  "t": "WEBRTC_SIGNAL",
  "d": {
    "from_user": "uuid",
    "signal": {
      "type": "offer|answer|ice_candidate",
      "sdp": "...",
      "candidate": "..."
    }
  }
}
```

`CALL_CONFIG`:
```json
{
  "t": "CALL_CONFIG",
  "d": {
    "room_id": "uuid",
    "turn_urls": ["turn:host:port"],
    "stun_urls": ["stun:host:port"],
    "username": "timestamp:user_id",
    "credential": "hmac-base64",
    "ttl": 86400,
    "audio": {
      "max_bitrate_kbps": 128,
      "preferred_bitrate_kbps": 64
    },
    "video": {
      "max_bitrate_kbps": 2500,
      "max_resolution": "1280x720",
      "max_framerate": 30
    }
  }
}
```

### 5. Configuration

Add `[media]` section to `AppConfig`:

```toml
[media]
dedicated_cores = 2
max_participants_per_room = 25
empty_room_timeout_secs = 300
udp_port_range_start = 10000
udp_port_range_end = 10100

[media.ice]
turn_secret = "same-as-turn-secret"
turn_urls = ["turn:localhost:3478"]
stun_urls = ["stun:stun.l.google.com:19302"]

[media.audio]
max_bitrate_kbps = 128
preferred_bitrate_kbps = 64

[media.video]
max_bitrate_kbps = 2500
max_resolution = "1280x720"
max_framerate = 30

[media.bandwidth]
total_mbps = 100
per_user_kbps = 4000
```

### 6. REST Endpoints

**POST /calls** — Initiate a call
- Request: `{ "channel_id": "uuid" }`
- Auth: JWT + server membership (via channel → server)
- Creates room if not exists, joins user
- Response: `{ "room_id": "uuid", "channel_id": "uuid", "participants": [], "call_config": {...} }`

**GET /calls/:id** — Get call info
- Auth: JWT (any authenticated user for now)
- Response: `{ "room_id": "uuid", "channel_id": "uuid", "participants": [{ "user_id": "uuid", "self_mute": false, "self_deaf": false }], "started_at": "iso8601" }`

### 7. TURN Credential Generation

Reuse existing `mercury_auth::turn::generate_turn_credentials()`. On call join:
1. Generate credentials with user_id and TurnConfig
2. Add STUN URLs from `[media.ice].stun_urls`
3. Bundle into `CALL_CONFIG` event
4. Send to joining user via WebSocket

### 8. Quality Control

Read limits from `[media.audio]`, `[media.video]`, `[media.bandwidth]` config sections. Include in `CALL_CONFIG` so clients can self-enforce. Server-side enforcement (SFU bandwidth monitoring) deferred to media forwarding phase.

## Edge Cases

1. **User joins voice channel they're not a member of**: Reject with ERROR event (checked against server membership in DB)
2. **User joins when room is full (25)**: Reject with ERROR event `ROOM_FULL`
3. **User joins new channel while already in a room**: Implicit leave from old room, then join new
4. **Last participant leaves**: Room enters 5-minute empty timeout, then destroyed
5. **Participant reconnects during empty timeout**: Room stays alive, timeout canceled
6. **voice_state_update with channel_id=null**: Leave current room
7. **webrtc_signal for non-existent room**: Reject with ERROR event
8. **Config missing [media] section**: Use sensible defaults for all fields
9. **TURN disabled**: CALL_CONFIG still sent but with empty turn_urls
10. **DM channel calls**: Same flow as server channels, but membership check against dm_members

## Acceptance Criteria

All 11 integration tests pass:

1. **voice_state_update join**: Join voice channel → VOICE_STATE_UPDATE broadcast to server members → CALL_STARTED event
2. **voice_state_update leave**: Leave → VOICE_STATE_UPDATE broadcast → CALL_ENDED when last participant
3. **webrtc_signal relay**: Send SDP offer → server relays to SFU → answer returned via WEBRTC_SIGNAL
4. **ICE candidate relay**: Send ICE candidate → relayed correctly
5. **CALL_CONFIG includes TURN credentials**: Valid username format (`timestamp:user_id`), valid HMAC, correct TTL, correct media limits
6. **POST /calls**: Creates room, returns call info with participants and call_config
7. **GET /calls/:id**: Returns participants and status
8. **Max participants**: Join 26th participant → rejected with ROOM_FULL error
9. **Non-member cannot join**: User not in server → voice_state_update rejected with ERROR
10. **Room cleanup**: All leave → room destroyed after timeout (verified by GET /calls/:id returning 404)
11. **Multiple rooms**: Two channels with active calls → independent rooms with correct participants

## Implementation Plan

### Files to Create/Modify

**New files in `mercury-media`:**
- `src/runtime.rs` — SFU dedicated Tokio runtime, core affinity, mpsc channels
- `src/room.rs` — Room, Participant, RoomManager
- `src/types.rs` — SfuCommand, SfuEvent, WebRtcSignalData, CallConfigData, etc.
- `src/lib.rs` — Re-exports, SfuHandle (API-side handle)

**Modify in `mercury-core`:**
- `src/config.rs` — Add MediaConfig, IceConfig, AudioConfig, VideoConfig, BandwidthConfig to AppConfig

**Modify in `mercury-api`:**
- `src/state.rs` — Add `sfu_handle: Arc<SfuHandle>` to AppState
- `src/router.rs` — Add `/calls` and `/calls/:id` routes
- `src/handlers/calls.rs` — New handler file for REST call endpoints
- `src/ws/connection.rs` — Handle `voice_state_update` and `webrtc_signal` ops, spawn SFU event consumer
- `src/ws/protocol.rs` — Add payload types for voice/call events

**Modify in `mercury-server`:**
- `src/lib.rs` — Initialize SfuHandle, pass to AppState
- `src/main.rs` — Initialize SfuHandle in production startup

**Modify workspace:**
- `Cargo.toml` — Add `str0m`, `core_affinity` dependencies
- `mercury-media/Cargo.toml` — Add dependencies

**New test file:**
- `tests/phase_8.rs` — All 11 integration tests

**Config:**
- `config/default.toml` — Add `[media]` section with defaults
