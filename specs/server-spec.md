# Mercury Server — Technical Specification

**Project Codename:** Mercury
**Component:** Server
**Version:** 0.1.0 (MVP)
**Language:** Rust
**Deployment:** Docker container (self-hosted)

---

## 1. Project Overview

Mercury is a self-hosted, end-to-end encrypted communication platform supporting text, audio, and video. The server is designed to be deployed by anyone via a single Docker container, supporting 500–5,000+ concurrent users per instance.

### 1.1 Design Principles

- **Zero-trust architecture:** The server never has access to plaintext message content. All E2E encryption keys are managed client-side.
- **Self-hosted first:** Single `docker compose up` deployment with sane defaults and minimal configuration.
- **Configurable media quality:** Server operators can set bandwidth/quality limits for audio and video to match their infrastructure.
- **Federation-ready:** MVP is standalone, but all internal APIs and data models should be designed with future server-to-server federation in mind. Use globally unique identifiers (e.g., `user@server.domain`) even in MVP.
- **Horizontal scalability path:** Stateless server processes behind a load balancer, with shared state in PostgreSQL + Redis.

### 1.2 MVP Scope

| Feature | Status |
|---------|--------|
| User authentication & accounts | **MVP** |
| Servers & channels (Discord-like hierarchy) | **MVP** |
| Direct messages (1:1 and small group) | **MVP** |
| Group voice/video calls (channels + DMs) | **MVP** |
| E2E encrypted text messaging | **MVP** |
| E2E encrypted audio/video | **MVP** |
| Configurable audio/video quality limits | **MVP** |
| Screen sharing | Future |
| File sharing & attachments | Future |
| Message history & search (encrypted) | Future |
| Roles & permissions | Future |
| Server-to-server federation | Future |

---

## 2. Technology Stack

### 2.1 Core

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | **Rust (stable)** | Memory safety, zero-cost abstractions, async performance |
| Async runtime | **Tokio** | Industry standard, mature ecosystem |
| HTTP/WebSocket framework | **Axum** | Tower-based, composable middleware, first-class WebSocket support |
| Serialization | **serde + serde_json** (API), **bincode** (internal) | JSON for client APIs, binary for internal efficiency |
| Database | **PostgreSQL 16+** | Relational integrity, JSONB for flexible metadata, proven at scale |
| Database driver | **sqlx** | Compile-time query verification, async native |
| Migrations | **sqlx-cli** | Integrated with sqlx, reversible migrations |
| Cache / Pub-Sub | **Redis 7+** | Presence tracking, session cache, real-time pub/sub for cross-process signaling |
| Redis driver | **fred** or **redis-rs** | Async, connection pooling, cluster support |
| Media (SFU) | **str0m** (Rust WebRTC) | Pure-Rust SFU (Selective Forwarding Unit) for audio/video relay |
| Signaling | **WebSocket (Axum)** | WebRTC signaling, real-time events, presence |
| Authentication | **Argon2id** (passwords) + **JWT** (sessions) | Argon2id is current best practice for password hashing; JWT for stateless auth with Redis-backed revocation |
| E2E Key Exchange | **X3DH + Double Ratchet** (server facilitates key bundles only) | Signal Protocol model — server stores public key bundles, never sees plaintext |
| Cryptographic library | **ring** or **RustCrypto** crates | Audited, no OpenSSL dependency |
| Configuration | **TOML** (file) + **env vars** (override) | Human-readable config with 12-factor app env override |
| Logging | **tracing + tracing-subscriber** | Structured, async-aware, filterable |
| Containerization | **Docker** (multi-stage build) | Minimal final image based on `distroless` or `alpine` |

### 2.2 Development & Testing

| Tool | Purpose |
|------|---------|
| `cargo nextest` | Fast parallel test runner |
| `cargo clippy` | Linting |
| `cargo fmt` | Formatting |
| `sqlx prepare` | Offline query checking for CI |
| `docker compose` | Local dev environment (Postgres, Redis, SFU) |
| `cargo-watch` | Hot reload during development |

---

## 3. Architecture

### 3.1 High-Level Architecture

```
┌─────────────┐     HTTPS/WSS      ┌──────────────────────────────────────┐
│   Clients   │◄───────────────────►│            Reverse Proxy             │
│  (Electron) │                     │        (Traefik / Nginx)             │
└─────────────┘                     └──────────┬───────────┬───────────────┘
                                               │           │
                                    ┌──────────▼──┐  ┌─────▼──────────────┐
                                    │  API Server  │  │   Media Server     │
                                    │   (Axum)     │  │   (SFU - str0m)   │
                                    │              │  │                    │
                                    │ • REST API   │  │ • WebRTC ingest   │
                                    │ • WebSocket  │  │ • Selective fwd   │
                                    │ • Signaling  │  │ • Quality control │
                                    └──────┬───────┘  └────────┬──────────┘
                                           │                   │
                                    ┌──────▼───────────────────▼──────────┐
                                    │          Shared State               │
                                    │  ┌─────────────┐ ┌───────────────┐  │
                                    │  │ PostgreSQL   │ │    Redis      │  │
                                    │  │ • Users      │ │ • Sessions    │  │
                                    │  │ • Channels   │ │ • Presence    │  │
                                    │  │ • Messages   │ │ • Pub/Sub     │  │
                                    │  │ • Key bundles│ │ • Rate limits │  │
                                    │  └─────────────┘ └───────────────┘  │
                                    └─────────────────────────────────────┘
```

### 3.2 Process Model

The MVP runs as a **single process** with internal task separation:

- **HTTP/WebSocket task pool** — Handles REST endpoints and persistent WebSocket connections via Tokio.
- **Media SFU task pool** — Handles WebRTC connections, DTLS-SRTP, and selective forwarding. Runs within the same process but on a dedicated Tokio runtime or thread pool to isolate media processing from API latency.
- **Background workers** — Periodic tasks: session cleanup, stale presence pruning, key bundle rotation reminders.

Future scaling: Split API and Media into separate processes/containers communicating via Redis pub/sub.

### 3.3 Crate/Module Structure

```
mercury-server/
├── Cargo.toml                  # Workspace root
├── Dockerfile
├── docker-compose.yml
├── config/
│   ├── default.toml            # Default configuration
│   └── example.env             # Example environment overrides
├── migrations/                 # sqlx migrations
│   ├── 001_create_users.sql
│   ├── 002_create_servers_channels.sql
│   ├── 003_create_messages.sql
│   └── 004_create_key_bundles.sql
├── crates/
│   ├── mercury-core/               # Shared types, error handling, config
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── config.rs       # Configuration structs (serde + TOML)
│   │       ├── error.rs        # Unified error types (thiserror)
│   │       ├── ids.rs          # Typed IDs (UserId, ChannelId, etc.)
│   │       └── models.rs       # Domain models
│   ├── mercury-db/                 # Database layer
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── pool.rs         # Connection pool setup
│   │       ├── users.rs        # User CRUD
│   │       ├── servers.rs      # Server/channel CRUD
│   │       ├── messages.rs     # Encrypted message storage
│   │       └── key_bundles.rs  # E2E public key bundle storage
│   ├── mercury-auth/               # Authentication & authorization
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── password.rs     # Argon2id hashing
│   │       ├── jwt.rs          # JWT issue/verify
│   │       ├── middleware.rs   # Axum auth middleware/extractor
│   │       └── session.rs      # Redis-backed session management
│   ├── mercury-api/                # REST + WebSocket handlers
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── router.rs       # Route definitions
│   │       ├── handlers/
│   │       │   ├── auth.rs     # Register, login, logout, refresh
│   │       │   ├── users.rs    # Profile, key bundles
│   │       │   ├── servers.rs  # CRUD servers
│   │       │   ├── channels.rs # CRUD channels within servers
│   │       │   ├── messages.rs # Send/receive encrypted messages
│   │       │   └── calls.rs    # Initiate/join/leave calls
│   │       ├── ws/
│   │       │   ├── mod.rs      # WebSocket upgrade handler
│   │       │   ├── connection.rs # Per-connection state machine
│   │       │   ├── events.rs   # Event types (inbound/outbound)
│   │       │   └── signaling.rs # WebRTC signaling relay
│   │       ├── middleware.rs   # Rate limiting, CORS, request ID
│   │       └── extractors.rs   # Custom Axum extractors
│   ├── mercury-media/              # SFU / media handling
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── sfu.rs          # Selective Forwarding Unit core
│   │       ├── room.rs         # Call room management
│   │       ├── quality.rs      # Bandwidth/quality enforcement
│   │       ├── codec.rs        # Codec negotiation & constraints
│   │       └── metrics.rs      # Media quality metrics
│   └── mercury-crypto/             # Cryptographic utilities
│       └── src/
│           ├── lib.rs
│           ├── keys.rs         # Key generation, serialization
│           ├── bundle.rs       # X3DH key bundle types
│           └── verify.rs       # Signature verification for key uploads
└── src/
    └── main.rs                 # Entry point: load config, init tracing, start server
```

---

## 4. Data Models

### 4.1 Database Schema (PostgreSQL)

All IDs use `UUID v7` (time-sortable) for natural ordering and future federation compatibility.

```sql
-- 001_create_users.sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(32) UNIQUE NOT NULL,
    display_name    VARCHAR(64) NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,                    -- Argon2id hash
    avatar_url      TEXT,
    status          VARCHAR(16) DEFAULT 'offline',    -- online, idle, dnd, offline
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_users_username ON users (username);
CREATE INDEX idx_users_email ON users (email);

-- 002_create_servers_channels.sql
CREATE TABLE servers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    icon_url        TEXT,
    owner_id        UUID NOT NULL REFERENCES users(id),
    invite_code     VARCHAR(16) UNIQUE NOT NULL,
    max_members     INT DEFAULT 5000,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    channel_type    VARCHAR(16) NOT NULL,              -- 'text', 'voice', 'video'
    topic           TEXT,
    position        INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(server_id, name)
);

CREATE TABLE server_members (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    nickname        VARCHAR(64),
    joined_at       TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, server_id)
);

-- 003_create_messages.sql
-- NOTE: message_blob is E2E encrypted ciphertext. Server cannot read content.
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id      UUID REFERENCES channels(id) ON DELETE CASCADE,
    dm_channel_id   UUID REFERENCES dm_channels(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id),
    message_blob    BYTEA NOT NULL,                   -- E2E encrypted payload
    message_type    VARCHAR(16) DEFAULT 'text',       -- 'text', 'system'
    created_at      TIMESTAMPTZ DEFAULT now(),
    CHECK (
        (channel_id IS NOT NULL AND dm_channel_id IS NULL) OR
        (channel_id IS NULL AND dm_channel_id IS NOT NULL)
    )
);

CREATE INDEX idx_messages_channel ON messages (channel_id, created_at DESC);
CREATE INDEX idx_messages_dm ON messages (dm_channel_id, created_at DESC);

CREATE TABLE dm_channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE dm_members (
    dm_channel_id   UUID NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (dm_channel_id, user_id)
);

-- 004_create_key_bundles.sql
-- X3DH key bundles — server stores public keys only
CREATE TABLE identity_keys (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    identity_key    BYTEA NOT NULL,                   -- Long-term public identity key
    signed_prekey   BYTEA NOT NULL,                   -- Signed pre-key (public)
    prekey_signature BYTEA NOT NULL,                  -- Signature over signed_prekey
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE one_time_prekeys (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_id          INT NOT NULL,
    prekey          BYTEA NOT NULL,                   -- One-time pre-key (public)
    used            BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, key_id)
);

CREATE INDEX idx_otp_available ON one_time_prekeys (user_id, used) WHERE NOT used;
```

### 4.2 Redis Key Schema

```
session:{jwt_id}                → JSON { user_id, expires_at, device_id }    TTL: 7d
presence:{user_id}              → JSON { status, last_seen, connected_devices[] }  TTL: 5min (refreshed by heartbeat)
typing:{channel_id}:{user_id}  → "1"  TTL: 5s
call:{room_id}                  → JSON { participants[], created_at, channel_id }
rate:{user_id}:{endpoint}      → counter  TTL: sliding window
```

### 4.3 Domain Types (Rust)

```rust
// mercury-core/src/ids.rs
use uuid::Uuid;
use serde::{Serialize, Deserialize};

macro_rules! typed_id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
        #[sqlx(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self { Self(Uuid::now_v7()) }
        }
    };
}

typed_id!(UserId);
typed_id!(ServerId);
typed_id!(ChannelId);
typed_id!(MessageId);
typed_id!(DmChannelId);
```

---

## 5. API Design

### 5.1 REST API

Base path: `/api/v1`

#### Authentication

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/auth/register` | Create account | No |
| `POST` | `/auth/login` | Login, receive JWT + refresh token | No |
| `POST` | `/auth/refresh` | Refresh JWT | Refresh token |
| `POST` | `/auth/logout` | Invalidate session | JWT |

#### Users

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/users/me` | Get current user profile | JWT |
| `PATCH` | `/users/me` | Update profile | JWT |
| `GET` | `/users/:id` | Get user public profile | JWT |
| `PUT` | `/users/me/keys` | Upload/update key bundle | JWT |
| `GET` | `/users/:id/keys` | Fetch user's public key bundle | JWT |
| `POST` | `/users/:id/keys/one-time` | Claim a one-time prekey | JWT |

#### Servers

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/servers` | Create server | JWT |
| `GET` | `/servers` | List user's servers | JWT |
| `GET` | `/servers/:id` | Get server details | JWT + Member |
| `PATCH` | `/servers/:id` | Update server settings | JWT + Owner |
| `DELETE` | `/servers/:id` | Delete server | JWT + Owner |
| `POST` | `/servers/join` | Join via invite code | JWT |
| `DELETE` | `/servers/:id/members/me` | Leave server | JWT + Member |

#### Channels

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/servers/:id/channels` | Create channel | JWT + Owner |
| `GET` | `/servers/:id/channels` | List channels | JWT + Member |
| `PATCH` | `/channels/:id` | Update channel | JWT + Owner |
| `DELETE` | `/channels/:id` | Delete channel | JWT + Owner |

#### Messages

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/channels/:id/messages` | Fetch history (paginated, encrypted blobs) | JWT + Member |
| `GET` | `/dm/:id/messages` | Fetch DM history | JWT + DM Member |

Messages are **sent via WebSocket**, not REST, for real-time delivery. REST is for history retrieval only.

#### Direct Messages

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/dm` | Create/get DM channel with user(s) | JWT |
| `GET` | `/dm` | List DM channels | JWT |

#### Calls

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/calls` | Initiate a call (in channel or DM) | JWT |
| `GET` | `/calls/:id` | Get call info (participants, status) | JWT |

Call join/leave/signaling is handled over WebSocket.

### 5.2 WebSocket Protocol

**Connection:** `wss://{host}/ws?token={jwt}`

All WebSocket messages use JSON envelope:

```json
{
  "op": "string",       // Operation code
  "d": { },             // Payload (operation-specific)
  "seq": 12345,         // Sequence number (client-maintained for resume)
  "t": "EVENT_NAME"     // Event name (server→client events only)
}
```

#### Client → Server Operations

| Op Code | Description | Payload |
|---------|-------------|---------|
| `heartbeat` | Keep-alive (every 30s) | `{ "seq": <last_received_seq> }` |
| `identify` | Initial handshake after connect | `{ "token": "jwt", "device_id": "..." }` |
| `resume` | Resume dropped connection | `{ "token": "jwt", "session_id": "...", "seq": <last_seq> }` |
| `message_send` | Send E2E encrypted message | `{ "channel_id": "...", "blob": "<base64>", "nonce": "..." }` |
| `typing_start` | User started typing | `{ "channel_id": "..." }` |
| `voice_state_update` | Join/leave/mute voice | `{ "channel_id": "...", "self_mute": bool, "self_deaf": bool }` |
| `webrtc_signal` | SDP offer/answer/ICE candidate | `{ "room_id": "...", "target_user": "...", "signal": { ... } }` |
| `presence_update` | Update user status | `{ "status": "online\|idle\|dnd\|offline" }` |

#### Server → Client Events

| Event | Description | Payload |
|-------|-------------|---------|
| `READY` | Connection established | `{ "user": {...}, "servers": [...], "dm_channels": [...], "session_id": "..." }` |
| `RESUMED` | Connection resumed | `{ "replayed_events": <count> }` |
| `MESSAGE_CREATE` | New encrypted message | `{ "message": { "id", "channel_id", "sender_id", "blob", "nonce", "created_at" } }` |
| `TYPING_START` | User typing indicator | `{ "channel_id", "user_id" }` |
| `PRESENCE_UPDATE` | User status changed | `{ "user_id", "status" }` |
| `VOICE_STATE_UPDATE` | User joined/left/muted | `{ "user_id", "channel_id", "self_mute", "self_deaf" }` |
| `CALL_STARTED` | Call initiated | `{ "room_id", "channel_id", "initiator_id" }` |
| `CALL_ENDED` | Call ended | `{ "room_id" }` |
| `WEBRTC_SIGNAL` | SDP/ICE relay | `{ "from_user", "signal": { ... } }` |
| `HEARTBEAT_ACK` | Response to heartbeat | `{ }` |
| `KEY_BUNDLE_UPDATE` | User updated keys | `{ "user_id" }` |

### 5.3 Rate Limiting

| Endpoint Category | Limit |
|-------------------|-------|
| Auth (register/login) | 5 req/min per IP |
| REST API (general) | 60 req/min per user |
| Message send (WS) | 10 msg/sec per user |
| WebSocket connect | 3/min per IP |

Implemented via Redis sliding window counters. Returns `429 Too Many Requests` with `Retry-After` header.

---

## 6. End-to-End Encryption

### 6.1 Architecture Overview

The server is **never trusted with plaintext**. It facilitates key exchange and relays ciphertext.

```
Alice                          Server                         Bob
  │                              │                              │
  │── Upload key bundle ────────►│◄──── Upload key bundle ──────│
  │                              │                              │
  │── Request Bob's keys ───────►│                              │
  │◄── Bob's public bundle ──────│                              │
  │                              │                              │
  │── X3DH key agreement ──────────────────────────────────────►│
  │                              │                              │
  │── Encrypted message ────────►│──── Relay ciphertext ───────►│
  │                              │                              │
  │   (Server sees only blobs)   │     (Bob decrypts locally)   │
```

### 6.2 Text Messaging Encryption

**Protocol:** Based on the Signal Protocol (X3DH + Double Ratchet).

#### Key Bundle (per user)

- **Identity Key (IK):** Long-term Ed25519/X25519 keypair. Generated on first registration.
- **Signed Pre-Key (SPK):** Medium-term X25519 keypair, signed by IK. Rotated weekly.
- **One-Time Pre-Keys (OPK):** Batch of ephemeral X25519 keys. Server stores public halves; consumed on first message to a new contact.

#### Session Establishment (X3DH)

1. Alice fetches Bob's key bundle from server (IK, SPK, one OPK if available).
2. Alice generates ephemeral key (EK) and computes shared secret via X3DH.
3. Alice sends initial message with: her IK (public), EK (public), used OPK ID, ciphertext.
4. Bob receives, computes same shared secret, initializes Double Ratchet.

#### Message Encryption (Double Ratchet)

- Each message encrypted with unique key derived from ratchet state.
- Provides forward secrecy and break-in recovery.
- Message format stored on server:

```json
{
  "sender_ik": "<base64>",
  "ephemeral_key": "<base64>",
  "prekey_id": 42,
  "ratchet_header": "<base64>",
  "ciphertext": "<base64>"
}
```

The entire payload is stored as an opaque `BYTEA` blob in the database.

#### Group/Channel Encryption

For channels with multiple members, use **Sender Keys** (Signal Group Protocol variant):

1. Each member generates a sender key and distributes it (encrypted per-recipient via pairwise sessions) to all group members.
2. Messages are encrypted once with the sender key (symmetric), not per-recipient.
3. When membership changes, sender keys are rotated.

### 6.3 Audio/Video Encryption

- **Transport:** DTLS-SRTP (standard WebRTC encryption).
- **Key management:** Insertable Streams API on the client side for true E2E encryption through the SFU.
- **SFU role:** The SFU forwards encrypted media packets **without decrypting them**. It operates on RTP headers only (for routing, simulcast layer selection, bandwidth estimation).
- **Frame-level E2E encryption:** Clients use a shared symmetric key (per call room, distributed via encrypted signaling) to encrypt/decrypt media frames before/after they pass through the SFU.
- **Key rotation:** Per-call symmetric key is rotated when participants join or leave.

```
Sender Client                   SFU                    Receiver Client
     │                           │                           │
     │── Encrypt frame ──►       │                           │
     │   (E2E key)               │                           │
     │── DTLS-SRTP ─────────────►│                           │
     │                           │── DTLS-SRTP ─────────────►│
     │                           │   (still E2E encrypted)   │
     │                           │                     ◄── Decrypt frame
     │                           │                         (E2E key)
```

---

## 7. Media Server (SFU)

### 7.1 Architecture

The SFU (Selective Forwarding Unit) receives media from each sender and forwards it to all other participants **without mixing or transcoding**. This preserves E2E encryption.

- Built on **str0m** (pure Rust WebRTC library).
- Runs within the same process as the API server in MVP (separate Tokio runtime).
- Communicates with the API server via in-process channels (tokio mpsc).

### 7.2 Room Management

- A **Room** is created when a call starts (mapped to a channel or DM).
- Participants are added/removed via WebSocket signaling events.
- Each participant has one `PeerConnection` to the SFU.
- Tracks are published (audio, video) and subscribed to per-participant.

### 7.3 Quality Control (Configurable)

Server operators configure quality limits in `config/default.toml`:

```toml
[media]
# Maximum participants per call room
max_participants_per_room = 25

[media.audio]
# Opus codec settings
max_bitrate_kbps = 128          # Max audio bitrate per stream
preferred_bitrate_kbps = 64     # Default audio bitrate
channels = 2                     # 1 = mono, 2 = stereo
frame_duration_ms = 20           # 10 or 20ms Opus frames

[media.video]
# Per-stream video quality caps
max_bitrate_kbps = 2500          # Max video bitrate per stream
max_resolution_height = 1080     # Max vertical resolution
max_framerate = 30               # Max frames per second
preferred_bitrate_kbps = 1000    # Default video bitrate
preferred_resolution_height = 720
preferred_framerate = 24

# Simulcast layers (client sends multiple quality levels, SFU selects)
simulcast_enabled = true
simulcast_layers = [
    { rid = "high",   max_bitrate_kbps = 2500, scale_resolution_down = 1.0 },
    { rid = "medium", max_bitrate_kbps = 500,  scale_resolution_down = 2.0 },
    { rid = "low",    max_bitrate_kbps = 150,  scale_resolution_down = 4.0 },
]

[media.bandwidth]
# Total server bandwidth budget
total_upload_mbps = 100          # Total upload bandwidth available
total_download_mbps = 100        # Total download bandwidth available
per_user_upload_limit_kbps = 4000   # Max upload per user (all streams combined)
per_user_download_limit_kbps = 8000 # Max download per user (all streams combined)
```

### 7.4 Quality Adaptation

- **Simulcast selection:** SFU selects which simulcast layer to forward based on receiver bandwidth, number of participants, and configured limits.
- **Bandwidth estimation:** Use REMB/TWCC feedback to estimate receiver bandwidth.
- **Dynamic downgrade:** If total server bandwidth nears the configured limit, progressively reduce forwarded layers (high → medium → low) for all rooms.
- **Priority:** Audio always prioritized over video. Active speaker video prioritized over others.

---

## 8. Configuration

### 8.1 Server Configuration File

`config/default.toml`:

```toml
[server]
host = "0.0.0.0"
port = 8443
public_url = "https://your-server.example.com"   # Required for WebRTC ICE

[database]
url = "postgres://mercury:password@localhost:5432/mercury"
max_connections = 50
min_connections = 5

[redis]
url = "redis://localhost:6379"
pool_size = 20

[auth]
jwt_secret = "CHANGE_ME_IN_PRODUCTION"            # Or load from env: MERCURY_AUTH_JWT_SECRET
jwt_expiry_minutes = 60
refresh_token_expiry_days = 30
argon2_memory_kib = 65536
argon2_iterations = 3
argon2_parallelism = 4

[tls]
enabled = true
cert_path = "/etc/mercury/cert.pem"
key_path = "/etc/mercury/key.pem"

# ... [media] section shown above in §7.3 ...

[limits]
max_servers_per_user = 100
max_channels_per_server = 500
max_members_per_server = 5000
max_message_size_bytes = 65536                     # Encrypted blob size limit
```

### 8.2 Environment Variable Overrides

All config keys can be overridden via environment variables with prefix `MERCURY_`:

```
MERCURY_SERVER_PORT=9443
MERCURY_DATABASE_URL=postgres://...
MERCURY_AUTH_JWT_SECRET=supersecret
```

---

## 9. Docker Deployment

### 9.1 Dockerfile (multi-stage)

```dockerfile
# Stage 1: Build
FROM rust:1.82-bookworm AS builder
WORKDIR /build
COPY . .
RUN cargo build --release

# Stage 2: Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/mercury-server /usr/local/bin/
COPY config/default.toml /etc/mercury/config.toml
EXPOSE 8443
ENTRYPOINT ["mercury-server"]
```

### 9.2 docker-compose.yml

```yaml
version: "3.9"
services:
  mercury:
    build: .
    ports:
      - "8443:8443"
      - "10000-10100:10000-10100/udp"    # WebRTC media UDP ports
    environment:
      - MERCURY_DATABASE_URL=postgres://mercury:password@db:5432/mercury
      - MERCURY_REDIS_URL=redis://redis:6379
      - MERCURY_AUTH_JWT_SECRET=${JWT_SECRET}
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    volumes:
      - ./config:/etc/mercury
      - certs:/etc/mercury/certs

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: mercury
      POSTGRES_USER: mercury
      POSTGRES_PASSWORD: password
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mercury"]
      interval: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data

volumes:
  pgdata:
  redisdata:
  certs:
```

### 9.3 Networking Considerations

- **WebRTC UDP ports:** The SFU needs a range of UDP ports exposed for media traffic. Configure `10000-10100/udp` (adjustable).
- **TURN server:** For clients behind restrictive NATs, deploy a TURN server (e.g., coturn) alongside or reference an external one. The server config should include TURN credentials:

```toml
[media.ice]
stun_urls = ["stun:stun.l.google.com:19302"]
turn_urls = ["turn:your-turn-server.com:3478"]
turn_username = "mercury"
turn_password = "turnpassword"
```

---

## 10. Security

### 10.1 Server-Side Hardening

- **No plaintext access:** Server never sees unencrypted messages, media content, or private keys.
- **Input validation:** All inputs validated with strict length/type constraints before touching the database.
- **SQL injection:** Parameterized queries via sqlx (compile-time verified).
- **Rate limiting:** Per-user and per-IP limits on all endpoints.
- **CORS:** Strict origin whitelist.
- **CSP:** Content-Security-Policy headers on all responses.
- **Dependency auditing:** `cargo audit` in CI pipeline.

### 10.2 Authentication Security

- **Argon2id:** Memory-hard password hashing resistant to GPU attacks.
- **JWT rotation:** Short-lived access tokens (60 min) + long-lived refresh tokens (30 days).
- **Session revocation:** JWT IDs stored in Redis; revocation is immediate.
- **Device tracking:** Each session is bound to a device ID for multi-device support and selective logout.

### 10.3 Key Management Safety

- Server only ever stores **public** keys.
- Key upload requires signing by the identity key — prevents unauthorized key replacement.
- One-time prekeys are marked as used atomically (database transaction) to prevent reuse.

---

## 11. Observability

### 11.1 Metrics (Prometheus)

Expose `/metrics` endpoint:

- `mercury_connected_clients` — gauge
- `mercury_active_calls` — gauge
- `mercury_messages_relayed_total` — counter
- `mercury_api_request_duration_seconds` — histogram by endpoint
- `mercury_media_bandwidth_bytes` — gauge (upload/download)
- `mercury_sfu_rooms_active` — gauge
- `mercury_db_pool_connections` — gauge (active/idle)

### 11.2 Structured Logging

All logs via `tracing` with JSON output:

```json
{
  "timestamp": "2026-02-14T12:00:00Z",
  "level": "INFO",
  "target": "mercury_api::handlers::messages",
  "message": "message relayed",
  "user_id": "...",
  "channel_id": "...",
  "blob_size": 1234,
  "span": { "request_id": "abc-123" }
}
```

### 11.3 Health Check

`GET /health` — returns `200 OK` with:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "database": "connected",
  "redis": "connected",
  "uptime_seconds": 86400
}
```

---

## 12. Testing Strategy

| Layer | Approach | Tools |
|-------|----------|-------|
| Unit | Pure function tests, error paths | `#[cfg(test)]`, `mockall` |
| Integration | Database operations, auth flows | `sqlx` test fixtures, testcontainers |
| API | Full request/response cycles | `axum::test`, `reqwest` |
| WebSocket | Connection lifecycle, events | Custom test harness with `tokio-tungstenite` |
| Media | SFU packet forwarding, quality adaptation | `str0m` test utilities, mock RTP streams |
| Load | Concurrent connections, message throughput | `k6`, `drill`, custom Rust load generator |
| Security | Auth bypass attempts, injection, rate limits | Manual + automated fuzzing (`cargo-fuzz`) |

---

## 13. Future Considerations

These are **not in MVP** but the architecture should not preclude them:

- **Federation:** ActivityPub-inspired or custom protocol. User IDs are already `user@domain` ready.
- **Roles & permissions:** RBAC stored in a `roles` + `role_permissions` table. Channel-level overrides.
- **Screen sharing:** Additional media track type through existing SFU infrastructure.
- **File attachments:** Encrypted file upload to object storage (S3/MinIO), metadata in DB.
- **Searchable encryption:** Client-side index generation, encrypted search tokens stored server-side.
- **Mobile push notifications:** FCM/APNs integration with encrypted notification payloads.
- **Audit logging:** Immutable append-only log of admin/moderation actions.
