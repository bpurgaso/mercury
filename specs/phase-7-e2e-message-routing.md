# Phase 7: Server-Side E2E Message Routing

## Problem Statement

Mercury's server currently handles `message_send` for standard (plaintext) channels only — it stores content in the `messages` table and broadcasts `MESSAGE_CREATE` to connected members. End-to-end encrypted messages (DMs via Double Ratchet, private channels via Sender Keys) need server-side routing support: storing per-device ciphertexts, validating Sender Key epochs, delivering ciphertexts to the correct devices, and serving encrypted message history filtered per-device.

## Proposed Solution

Extend the existing WebSocket and REST infrastructure to handle three message encryption modes:

1. **Standard** (existing): plaintext content, broadcast to all server members
2. **E2E DM** (new): per-device ciphertext via Double Ratchet, routed to specific devices
3. **Private channel** (new): broadcast ciphertext via Sender Keys, epoch-validated

Additionally: add DM channel management endpoints, MessagePack binary framing for message ops, and Sender Key distribution via WebSocket.

## Goals

- Messages sent to E2E DM channels store per-device ciphertexts in `message_recipients` and deliver only the correct ciphertext to each device
- Messages sent to private channels store a single broadcast ciphertext, validate epoch against `sender_key_epoch`, and deliver to all channel members
- DM channels can be created/listed via REST endpoints
- Message history endpoints return device-filtered ciphertexts for E2E channels
- `message_send` and `MESSAGE_CREATE` use MessagePack binary frames; other ops remain JSON text
- Sender Key distribution messages route encrypted key material to target devices
- All binary data uses MessagePack `bin` type, not base64 strings
- Max message payload enforced at 65536 bytes

## Non-Goals

- Client-side crypto implementation (Double Ratchet, Sender Keys, X3DH)
- Offline message queue for devices not currently connected (store in DB, fetch via history)
- Message franking for abuse reports
- Multi-server federation
- File/media attachments

## Detailed Design

### 1. Extended `message_send` WebSocket Op

The `message_send` handler accepts three payload variants, distinguished by field presence:

**Standard channel** (existing — no changes, remains JSON text frame):
```json
{ "op": "message_send", "d": { "channel_id": "...", "content": "text" } }
```

**E2E DM** (new — MessagePack binary frame):
```msgpack
{
  "op": "message_send",
  "d": {
    "dm_channel_id": "...",
    "recipients": [
      {
        "device_id": "bob-device-uuid",
        "ciphertext": <bin>,
        "x3dh_header": {           // ONLY on first message in session
          "sender_identity_key": <bin>,
          "ephemeral_key": <bin>,
          "prekey_id": 42
        }
      }
    ]
  }
}
```

**Private channel** (new — MessagePack binary frame):
```msgpack
{
  "op": "message_send",
  "d": {
    "channel_id": "...",
    "encrypted": {
      "ciphertext": <bin>,
      "signature": <bin>,
      "sender_device_id": "...",
      "iteration": 123,
      "epoch": 5
    }
  }
}
```

**Dispatch logic**: If `dm_channel_id` is present → DM. If `channel_id` + `encrypted` → private channel. If `channel_id` + `content` → standard (existing).

### 2. Message Storage

**Standard channels** (no change):
- INSERT into `messages` with `content = plaintext`, `channel_id` set
- No `message_recipients` rows

**E2E DMs**:
- INSERT into `messages` with `content = NULL`, `dm_channel_id` set
- For each recipient: INSERT into `message_recipients` with `(message_id, device_id, ciphertext)`
- `ciphertext` blob contains the Double Ratchet ciphertext
- If `x3dh_header` is present, store it in a separate nullable `x3dh_header BYTEA` column on `message_recipients` (added via migration). The server stores the MessagePack-serialized header as-is and returns it as-is — fully opaque.

**Private channels (Sender Keys)**:
- INSERT into `messages` with `content = NULL`, `channel_id` set
- INSERT into `message_recipients` with `device_id = NULL` (broadcast), `ciphertext` = MessagePack-serialized `{ ciphertext, signature, sender_device_id, iteration, epoch }`

### 3. Epoch Validation (Private Channels)

On receiving a Sender Key message:
1. Read `sender_key_epoch` from the channel record
2. Compare message `epoch` with channel's `sender_key_epoch`
3. If message epoch < channel epoch → reject with error code `STALE_SENDER_KEY`
4. If message epoch >= channel epoch → accept

Error response (JSON text frame):
```json
{ "t": "ERROR", "d": { "code": "STALE_SENDER_KEY", "message": "sender key epoch is stale, re-key required" } }
```

### 4. MessagePack Binary Framing

**Incoming frames**: Check frame type — binary → decode as MessagePack; text → decode as JSON. Both decode to the same `ClientMessage` struct (op + d).

**Outgoing MESSAGE_CREATE**: Encode as MessagePack binary frame. All ciphertext fields use MessagePack `bin` type.

**Other ops** (heartbeat, identify, resume, typing, presence, voice): Remain JSON text frames.

**Implementation**: Use `rmp-serde` (already in Cargo.toml). Define a `BinaryClientMessage` that can deserialize from MessagePack with `serde_bytes` for binary fields. The connection event loop checks `Message::Binary` vs `Message::Text` to choose decoder.

### 5. MESSAGE_CREATE Broadcast Routing

**Standard channels** (no change): Broadcast to all connected members of the channel's server.

**E2E DMs**: Send `MESSAGE_CREATE` to:
- Each recipient device listed in `recipients` — payload includes only that device's ciphertext
- Sender's OTHER devices (for multi-device sync) — each gets the ciphertext addressed to them from the recipients array, if present
- Payload is a MessagePack binary frame per device, containing only the one relevant ciphertext row

**Private channels**: Broadcast `MESSAGE_CREATE` to all connected members of the channel. Payload includes the single broadcast ciphertext (same for everyone). Sent as MessagePack binary frame.

### 6. Message History Endpoints

**GET /channels/:id/messages** (existing, extended):
- For standard channels: return messages with `content` (plaintext) — no change
- For private channels: return messages joined with `message_recipients WHERE device_id IS NULL`, each including the full encrypted payload

**GET /dm/:id/messages** (new):
- Return messages for a DM channel, joined with `message_recipients WHERE device_id = requesting_device_id`
- Each message includes only the requesting device's ciphertext blob
- Include x3dh_header if present (extracted from the ciphertext blob format)
- `device_id` comes from the JWT session in Redis (`session:{jti}` → `device_id`)
- If no `device_id` in session → return 400

Both endpoints: paginated by cursor (created_at DESC), limit capped at 100.

### 7. DM Channel Management

**POST /dm** — Create or get DM channel:
- Request: `{ "recipient_id": "user-uuid" }`
- Check if DM channel exists between sender and recipient (query `dm_members`)
- If exists: return existing channel
- If not: create `dm_channel` + two `dm_members` rows in a transaction
- Response: `{ "id": "...", "recipient": { "id": "...", "username": "..." }, "created_at": "..." }`

**GET /dm** — List DM channels:
- Return all DM channels for the authenticated user
- Each includes the other user's info (id, username, display_name, avatar_url)

### 8. Sender Key Distribution

**New WebSocket op**: `sender_key_distribute` (MessagePack binary frame)

Client → Server:
```msgpack
{
  "op": "sender_key_distribute",
  "d": {
    "channel_id": "...",
    "distributions": [
      { "device_id": "target-device-uuid", "ciphertext": <bin> }
    ]
  }
}
```

Server behavior:
- For each distribution entry: deliver `SENDER_KEY_DISTRIBUTION` event to the target device's WebSocket connection (if online)
- Store in `message_recipients` table with a system message for offline delivery (create a message with `message_type = 'sender_key_distribution'`)

Server → Client (MessagePack binary frame):
```msgpack
{
  "t": "SENDER_KEY_DISTRIBUTION",
  "d": {
    "channel_id": "...",
    "sender_id": "...",
    "sender_device_id": "...",
    "ciphertext": <bin>
  }
}
```

### 9. Payload Size Validation

All incoming message payloads (the raw WebSocket frame) are validated against 65536 bytes max. If exceeded → send error `MESSAGE_TOO_LARGE` and drop the message.

### 10. Membership Validation

- `message_send` to a channel: sender must be a member of the channel's server
- `message_send` to a DM: sender must be a member of the DM channel
- `sender_key_distribute`: sender must be a member of the channel's server

## Data Structures

### New/Modified Protocol Types

```rust
// E2E DM message send payload
struct DmMessageSendPayload {
    dm_channel_id: String,
    recipients: Vec<DmRecipient>,
}

struct DmRecipient {
    device_id: String,
    #[serde(with = "serde_bytes")]
    ciphertext: Vec<u8>,
    x3dh_header: Option<X3dhHeader>,
}

struct X3dhHeader {
    #[serde(with = "serde_bytes")]
    sender_identity_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    ephemeral_key: Vec<u8>,
    prekey_id: i32,
}

// Private channel message send payload
struct PrivateMessageSendPayload {
    channel_id: String,
    encrypted: SenderKeyPayload,
}

struct SenderKeyPayload {
    #[serde(with = "serde_bytes")]
    ciphertext: Vec<u8>,
    #[serde(with = "serde_bytes")]
    signature: Vec<u8>,
    sender_device_id: String,
    iteration: i64,
    epoch: i64,
}

// Sender Key distribution payload
struct SenderKeyDistributePayload {
    channel_id: String,
    distributions: Vec<SenderKeyDistribution>,
}

struct SenderKeyDistribution {
    device_id: String,
    #[serde(with = "serde_bytes")]
    ciphertext: Vec<u8>,
}
```

### New DB Functions

```rust
// messages.rs
fn create_dm_message(pool, id, dm_channel_id, sender_id) -> Message
fn create_message_recipient(pool, message_id, device_id, ciphertext) -> MessageRecipient
fn get_dm_messages_paginated(pool, dm_channel_id, device_id, before, after, limit) -> Vec<(Message, Vec<u8>)>
fn get_private_channel_messages_paginated(pool, channel_id, before, after, limit) -> Vec<(Message, Vec<u8>)>

// dm_channels.rs (new file)
fn get_or_create_dm_channel(pool, user_a, user_b) -> DmChannel
fn list_dm_channels_for_user(pool, user_id) -> Vec<DmChannelWithRecipient>
fn is_dm_member(pool, user_id, dm_channel_id) -> bool
```

### ConnectionManager Extensions

```rust
// Send to a specific device by device_id
fn send_to_device(&self, device_id: &str, message: &ServerMessage)

// Send to all devices of a user EXCEPT a specific device
fn send_to_user_except_device(&self, user_id: &UserId, exclude_device: &str, message: &ServerMessage)
```

## Edge Cases

1. **DM to self**: User creates a DM channel with themselves — allowed but unusual. Recipients array would contain only the sender's own devices.
2. **Device not registered**: If a `device_id` in the recipients array doesn't exist in the `devices` table, the server ignores it (doesn't store a `message_recipients` row for it) but still processes the rest.
3. **Empty recipients array**: DM message_send with empty recipients → reject as bad request.
4. **Stale epoch race**: Two clients send messages simultaneously, one with a stale epoch. The stale one gets rejected; the client must re-key and retry.
5. **DM channel already exists**: POST /dm is idempotent — returns existing channel.
6. **Session without device_id**: History endpoint for E2E channels returns 400 if the session doesn't have a device_id.
7. **Oversized payload**: Frames > 65536 bytes → `MESSAGE_TOO_LARGE` error, message not stored.
8. **Standard message on private channel**: If someone sends `{ channel_id, content }` to a private channel → reject (content should be null for E2E channels, use `encrypted` instead).

## Acceptance Criteria

1. Standard channel messages continue to work as before (plaintext, JSON text frames for send, MessagePack binary for MESSAGE_CREATE broadcast)
2. E2E DM messages: send via WS → stored with per-device ciphertexts → MESSAGE_CREATE delivered to correct devices with correct ciphertext → history returns device-filtered ciphertexts
3. Private channel messages: send via WS with epoch validation → broadcast ciphertext stored → MESSAGE_CREATE to all members → history returns broadcast ciphertext
4. Stale epoch rejected with STALE_SENDER_KEY
5. DM channel create/list endpoints work and are idempotent
6. MessagePack binary framing for message_send and MESSAGE_CREATE; JSON text for other ops
7. Cross-device isolation: each device only sees its own ciphertext
8. Message payload > 65536 bytes rejected with MESSAGE_TOO_LARGE
9. Sender Key distribution routes to target devices
10. All 11 integration tests pass
