# Phase 7b: Client-Side E2E DM Messaging

## Problem Statement

Mercury's server-side E2E message routing (Phase 7) is complete — the server stores per-device ciphertexts, routes DM messages to correct devices, and serves device-filtered encrypted history. The client-side crypto engine (Phase 6) is complete — X3DH, Double Ratchet, Sender Keys, device management, and recovery are all tested in isolation. However, nothing wires them together: the WebSocket manager only speaks JSON, the message store only handles plaintext, and the crypto worker has no encrypt/decrypt DM ops. Users cannot actually send or receive encrypted DMs.

This spec wires the crypto engine into the client DM flow end-to-end.

## Proposed Solution

1. Upgrade the WebSocket manager to support hybrid framing (MessagePack binary for `message_send` / `sender_key_distribute`, JSON text for everything else).
2. Add `encrypt_dm` and `decrypt_dm` ops to the crypto worker, orchestrating X3DH session establishment and Double Ratchet encrypt/decrypt.
3. Extend `messageStore` to handle DM channels with a completely different send/receive pipeline (worker-mediated crypto instead of plaintext).
4. Add a `dmChannelStore` to manage DM channel state from the READY event and REST API.
5. Add DM creation UI and message history with local-first loading from `messages.db`.
6. Show an encryption badge on DM conversations.

## Goals

- Alice can send an encrypted DM to Bob; Bob receives and reads it. The server never sees plaintext.
- First message to a new device triggers X3DH + Double Ratchet session establishment transparently.
- Subsequent messages use the established Double Ratchet session (no X3DH fields).
- Messages persist locally in `messages.db` for offline access and forward secrecy.
- WebSocket frames use MessagePack binary for `message_send` and `sender_key_distribute`; JSON text for all other ops.
- Ciphertext fields remain as `Uint8Array` throughout — no base64 conversion anywhere in the client pipeline.
- All crypto operations run exclusively in the Worker thread.
- TOFU identity change triggers a warning dialog; messages are not sent until the user approves or cancels.
- DM channels appear in the sidebar and are populated from the READY event.

## Non-Goals

- Private channel (Sender Key) encryption — separate phase.
- Multi-device sender sync (sender encrypting for their own other devices) — future work.
- File/media attachments in DMs.
- Message editing or deletion in DMs.
- Read receipts or typing indicators for DMs.
- Key verification UI (safety numbers dialog) — exists in crypto engine but UI is out of scope here.

## Detailed Design

### 1. MessagePack Integration in WebSocket Manager

**File:** `src/client/src/renderer/services/websocket.ts`

Modify `WebSocketManager`:

**Send path — new `sendBinary(op, data)` method:**
```typescript
sendBinary(op: string, data: unknown): void {
  if (this.ws?.readyState === WebSocket.OPEN) {
    const encoded = encode({ op, d: data })
    this.ws.send(encoded)
  }
}
```

**Modify `send()` to route binary ops:**
```typescript
send(op: string, data: unknown): void {
  if (op === 'message_send' || op === 'sender_key_distribute') {
    this.sendBinary(op, data)
  } else {
    // existing JSON path
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, d: data }))
    }
  }
}
```

**Receive path — update `handleMessage()`:**
```typescript
private handleMessage(event: MessageEvent): void {
  let envelope: ServerMessage
  if (event.data instanceof ArrayBuffer) {
    // Binary frame → MessagePack
    envelope = decode(new Uint8Array(event.data)) as ServerMessage
  } else {
    // Text frame → JSON
    try {
      envelope = JSON.parse(event.data as string)
    } catch {
      return
    }
  }
  // ... rest of handler unchanged
}
```

**WebSocket binary type:** Set `ws.binaryType = 'arraybuffer'` after construction in `doConnect()`.

**Dependencies:** `@msgpack/msgpack` — already in `package.json`.

**MessagePack encode options:** Use `{ forceIntegerToFloat: false }` (default) so integers stay integers. For `Uint8Array` fields, `@msgpack/msgpack` automatically encodes them as MessagePack `bin` type.

### 2. WebSocket Event Types Update

**File:** `src/client/src/renderer/types/ws.ts`

Add new types:

```typescript
// DM-specific MESSAGE_CREATE from binary frame
export interface DmMessageCreateEvent {
  t: 'MESSAGE_CREATE'
  d: {
    id: string
    dm_channel_id: string
    sender_id: string
    sender_device_id: string
    ciphertext: Uint8Array
    ratchet_header: Uint8Array  // serialized header bytes
    x3dh_header?: {
      sender_identity_key: Uint8Array
      ephemeral_key: Uint8Array
      prekey_id: number
    }
    created_at: string
  }
  seq?: number
}
```

Update `MessageCreateEvent` to include optional DM fields:
```typescript
export interface MessageCreateEvent {
  id: string
  channel_id?: string        // present for standard/private channel messages
  dm_channel_id?: string     // present for DM messages
  sender_id: string
  sender_device_id?: string  // present for DM messages
  content?: string | null    // present for standard messages only
  ciphertext?: Uint8Array    // present for DM messages
  ratchet_header?: Uint8Array
  x3dh_header?: {
    sender_identity_key: Uint8Array
    ephemeral_key: Uint8Array
    prekey_id: number
  }
  created_at: string
}
```

Add `sender_key_distribute` to `ClientOp` type:
```typescript
export type ClientOp = ... | 'sender_key_distribute'
```

### 3. DM Channel Store

**New file:** `src/client/src/renderer/stores/dmChannelStore.ts`

```typescript
interface DmChannel {
  id: string
  recipient: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
  }
  created_at: string | null
}

interface DmChannelState {
  dmChannels: Map<string, DmChannel>
  activeDmChannelId: string | null

  setDmChannels(channels: DmChannel[]): void
  addDmChannel(channel: DmChannel): void
  setActiveDmChannel(id: string | null): void
  getDmChannelByRecipient(recipientId: string): DmChannel | undefined
}
```

Populated from `READY` event's `dm_channels` array. The `DmChannel.recipient` contains the other user's info.

### 4. Crypto Worker — New DM Operations

**File:** `src/client/src/main/workers/crypto-worker-entry.ts`

Add these ops to `handleCryptoOp`:

#### `crypto:encryptDm`

**Input:**
```typescript
{
  recipientId: string
  recipientDevices: Array<{
    deviceId: string
    hasSession: boolean  // from pre-loaded session metadata
  }>
  plaintext: string  // UTF-8 message text
}
```

**Flow:**
1. For each recipient device:
   a. If `hasSession === true`: load session from KeyStore → `ratchetEncrypt(session, plaintext)` → persist updated session → return `{ device_id, ciphertext, ratchet_header }`.
   b. If `hasSession === false`: signal back to renderer that key bundle is needed for this device (the worker cannot make HTTP requests).
2. Return `{ recipients: [...], needsKeyBundle: [deviceId, ...] }`.

If key bundles are needed, the renderer fetches them via REST API and re-calls:

#### `crypto:establishAndEncryptDm`

**Input:**
```typescript
{
  recipientId: string
  recipientMasterVerifyKey: Uint8Array  // for TOFU check
  keyBundles: Array<{
    deviceId: string
    identityKey: Uint8Array
    signedPreKey: { keyId: number; publicKey: Uint8Array; signature: Uint8Array }
    oneTimePreKey?: { keyId: number; publicKey: Uint8Array }
  }>
  plaintext: string
}
```

**Flow:**
1. TOFU check: compare `recipientMasterVerifyKey` against `keyStore.getTrustedIdentity(recipientId)`.
   - First seen → store as trusted → proceed.
   - Matches stored → proceed.
   - Mismatch → return `{ error: 'IDENTITY_CHANGED', previousKey, newKey }` — do NOT encrypt.
2. For each key bundle:
   a. `performX3DH(ourDeviceIdentityKey, keyBundle)` → `x3dhResult`.
   b. `initSenderSession(x3dhResult.sharedSecret, keyBundle.signedPreKey.publicKey)` → initial Double Ratchet session.
   c. `ratchetEncrypt(session, plaintext)` → ciphertext + header.
   d. Persist session to KeyStore.
   e. Build x3dh_header: `{ sender_identity_key, ephemeral_key, prekey_id }`.
3. Return `{ recipients: [{ device_id, ciphertext, ratchet_header, x3dh_header }] }`.

#### `crypto:decryptDm`

**Input:**
```typescript
{
  messageId: string
  dmChannelId: string
  senderId: string
  senderDeviceId: string
  ciphertext: Uint8Array   // serialized RatchetMessage wire format
  x3dhHeader?: {
    senderIdentityKey: Uint8Array
    ephemeralKey: Uint8Array
    prekeyId: number
  }
  createdAt: number  // Unix ms
}
```

**Flow:**
1. If `x3dhHeader` is present (first message from this device):
   a. Load our device identity key and signed pre-key from KeyStore.
   b. Load one-time pre-key if `prekeyId` is specified.
   c. `respondX3DH(ourIdentityKey, ourSignedPreKey, ourOTP, x3dhHeader.senderIdentityKey, x3dhHeader.ephemeralKey)` → shared secret.
   d. `initReceiverSession(sharedSecret, ourSignedPreKey.keyPair)` → initial Double Ratchet session.
   e. Mark OTP as used.
   f. `ratchetDecrypt(session, deserializedMessage)` → plaintext.
   g. Persist session to KeyStore.
2. If no `x3dhHeader`:
   a. Load existing session from KeyStore.
   b. If no session exists → return `{ error: 'NO_SESSION' }`.
   c. `ratchetDecrypt(session, deserializedMessage)` → plaintext.
   d. Persist updated session.
3. Persist decrypted plaintext to `messages.db`.
4. Return `{ plaintext: string, messageId }`.

**Error handling:** If `ratchetDecrypt` throws (AEAD auth failure), return `{ error: 'DECRYPT_FAILED' }`. Do NOT advance ratchet state (the deserialization creates a copy, so the stored session remains unchanged).

#### `crypto:getLocalMessages`

**Input:** `{ channelId: string, limit?: number, offset?: number }`
**Output:** Array of `StoredMessage`.

Already partially exists as `crypto:getMessages` — reuse it.

#### `crypto:hasSession`

**Input:** `{ userId: string, deviceId: string }`
**Output:** `{ exists: boolean }`

Fast lookup against in-memory session index (loaded at startup).

#### `crypto:loadSessionIndex`

Called at worker init (after DB init). Loads all `(userId, deviceId)` pairs from the sessions table into an in-memory `Set<string>` for fast `hasSession()` checks without DB round-trips.

### 5. Session Mutex in Worker

Add a per-session mutex to prevent concurrent encrypt/decrypt on the same Double Ratchet session:

```typescript
const sessionLocks = new Map<string, Promise<void>>()

function withSessionLock<T>(userId: string, deviceId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${userId}:${deviceId}`
  const prev = sessionLocks.get(key) || Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  sessionLocks.set(key, next.then(() => {}, () => {}))
  return next
}
```

All `encrypt_dm` and `decrypt_dm` operations for a given `(userId, deviceId)` session go through this lock. Different sessions can run in parallel.

### 6. Message Store — DM Extensions

**File:** `src/client/src/renderer/stores/messageStore.ts`

#### Updated `sendMessage()`:

```typescript
async sendMessage(channelId: string, content: string): Promise<void> {
  const dmChannel = useDmChannelStore.getState().dmChannels.get(channelId)

  if (dmChannel) {
    // DM path — encrypt via worker
    await sendDmMessage(channelId, dmChannel.recipient.id, content)
  } else {
    // Standard channel path — plaintext
    wsManager.send('message_send', { channel_id: channelId, content })
  }
}
```

#### `sendDmMessage()` helper:

1. Fetch recipient's device list from server (`GET /users/:id/devices`).
2. For each device, check `hasSession` via worker.
3. Devices with sessions: call `crypto:encryptDm`.
4. Devices without sessions: fetch key bundles via REST → call `crypto:establishAndEncryptDm`.
   - If TOFU fails (`IDENTITY_CHANGED`): show identity warning dialog, abort send.
5. Combine all recipient results.
6. Send via WebSocket: `wsManager.send('message_send', { dm_channel_id: channelId, recipients })`.
7. Persist sender's copy of plaintext to `messages.db` via `crypto:storeMessage`.
8. Add optimistic message to in-memory store.

#### Updated `handleMessageCreate()`:

```typescript
handleMessageCreate(event: MessageCreateEvent): void {
  if (event.dm_channel_id && event.ciphertext) {
    // DM message — decrypt via worker
    this.handleDmMessageCreate(event)
  } else if (event.channel_id && event.content != null) {
    // Standard channel message — plaintext
    // ... existing logic
  }
}
```

#### `handleDmMessageCreate()`:

1. Post `crypto:decryptDm` to worker with ciphertext, ratchet_header, x3dh_header.
2. On success: add decrypted message to in-memory store for `dm_channel_id`.
3. On `NO_SESSION` error: add placeholder message "This message could not be decrypted" to in-memory store.
4. On `DECRYPT_FAILED` error: add placeholder message "This message could not be decrypted" to in-memory store.

### 7. DM Message History (Local-First)

#### `fetchDmHistory(dmChannelId: string)`:

1. **Local first:** Call `crypto:getMessages` → load from `messages.db` → add to in-memory store immediately.
2. **Server catch-up:** Call `GET /dm/:id/messages?after=<last_known_id>` → for each new server message, call `crypto:decryptDm` → worker persists to `messages.db` → add to in-memory store.
3. **Merge:** Messages from both sources are already ordered by `created_at` in the store's duplicate-aware `addMessage()`.

### 8. DM Creation Flow

#### REST API addition:

**File:** `src/client/src/renderer/services/api.ts`

```typescript
export const dm = {
  create: (recipientId: string) =>
    request<DmChannelResponse>('/dm', {
      method: 'POST',
      body: JSON.stringify({ recipient_id: recipientId }),
    }),
  list: () => request<DmChannelResponse[]>('/dm'),
  getHistory: (dmChannelId: string, params?: MessageHistoryParams) => {
    const searchParams = new URLSearchParams()
    if (params?.before) searchParams.set('before', params.before)
    if (params?.after) searchParams.set('after', params.after)
    if (params?.limit) searchParams.set('limit', String(params.limit))
    const qs = searchParams.toString()
    return request<DmMessageResponse[]>(`/dm/${dmChannelId}/messages${qs ? `?${qs}` : ''}`)
  },
}
```

`DmMessageResponse` shape (from server):
```typescript
interface DmMessageResponse {
  id: string
  dm_channel_id: string
  sender_id: string
  sender_device_id: string | null
  ciphertext: string  // base64 from REST (not MessagePack binary)
  x3dh_header: string | null  // base64
  created_at: string
}
```

Note: REST responses use base64 for binary fields (unlike WebSocket which uses MessagePack binary). The renderer must decode base64 to `Uint8Array` before passing to the worker.

#### UI — New DM Button:

Add a "New DM" icon button to the Sidebar, above the server list. Clicking it opens a simple modal:
- Text input for username search.
- List of matching users (from server member lists or a user search endpoint if available).
- Clicking a user calls `POST /dm { recipient_id }` → adds the DM channel to `dmChannelStore` → navigates to the DM view.

#### UI — DM Channel List:

In the Sidebar (or a dedicated DM section), show all DM channels from `dmChannelStore`. Each entry shows the recipient's display name and avatar. Clicking a DM channel sets `activeDmChannelId` and loads the DM view.

### 9. READY Event Handling Update

**File:** `src/client/src/renderer/stores/authStore.ts` (or wherever READY is handled)

When `READY` event fires:
1. Existing: populate `serverStore` with servers and channels.
2. **New:** populate `dmChannelStore` with `event.dm_channels`.
3. The dm_channels shape from server:
```json
{
  "id": "uuid",
  "recipient": {
    "id": "uuid",
    "username": "bob",
    "display_name": "Bob",
    "avatar_url": null
  },
  "created_at": "2026-02-22T..."
}
```

### 10. Encryption Badge

In the DM channel header (and optionally in the DM list), show a shield icon with tooltip "End-to-end encrypted. Only you and the recipient can read these messages."

Implementation: Check if the active channel is a DM (exists in `dmChannelStore`). If so, render the shield badge in the channel header next to the recipient's name.

### 11. Worker-Renderer Communication

All crypto ops use the existing `parentPort`-based message passing between renderer → main → worker. The pattern:

**Renderer side (helper in a new `src/client/src/renderer/services/crypto.ts`):**
```typescript
function postCryptoOp(op: string, data: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `crypto-${++counter}`
    pendingOps.set(id, { resolve, reject })
    // Post via IPC to main, which forwards to worker
    window.electronAPI.postCryptoMessage({ op, id, data })
  })
}
```

**Zero-copy transfers:** When passing `Uint8Array` buffers between renderer and worker, use `postMessage(data, [data.buffer])` for zero-copy transfer. This applies to:
- Ciphertext buffers going to worker for decryption.
- Ciphertext buffers coming back from worker after encryption.
- Key bundle binary fields.

### 12. Message Model Update

**File:** `src/client/src/renderer/types/models.ts`

Add `dm_channel_id` to `Message`:
```typescript
export interface Message {
  id: string
  channel_id: string | null
  dm_channel_id?: string     // present for DM messages
  sender_id: string
  content: string | null
  message_type: string | null
  created_at: string | null
  edited_at: string | null
  // DM-specific: set when decryption fails
  decrypt_error?: 'NO_SESSION' | 'DECRYPT_FAILED'
  sender_username?: string
  sender_avatar_url?: string | null
}
```

### 13. Navigation / View Mode

Add a view mode concept: the user is either viewing a **server channel** or a **DM channel**. This determines:
- Which channel list to show (server channels vs DM list).
- Which message store key to use (`channel_id` vs `dm_channel_id`).
- Whether to show the encryption badge.
- Which history fetch method to call.

Implementation: Add a `viewMode: 'server' | 'dm'` field to a navigation store (or extend `serverStore`). Clicking a DM sets `viewMode = 'dm'` and `activeDmChannelId`. Clicking a server sets `viewMode = 'server'` and clears `activeDmChannelId`.

## Edge Cases

1. **First message to a device with no key bundle available:** If `GET /users/:id/devices/:deviceId/keys` returns 404 or empty — skip that device. If ALL devices fail, show "Cannot reach recipient's key server" error.

2. **TOFU identity change:** If the recipient's master verify key changes (different from stored trusted identity), show a warning dialog: "The security verification for [username] has changed. This could mean their account was compromised or they re-registered. Do you want to continue?" Options: "Send anyway" (updates trusted identity) or "Cancel". Message is NOT sent until the user explicitly approves.

3. **Decryption failure (AEAD auth error):** Display a "This message could not be decrypted" placeholder in the UI. The message is stored in the in-memory store with `decrypt_error` set. The ratchet state is NOT advanced (the error is thrown before session state is persisted).

4. **No session and no X3DH header:** If a message arrives from a device we have no session for and no `x3dh_header` is present — display "This message could not be decrypted" placeholder.

5. **Concurrent encrypt/decrypt on same session:** The per-session mutex ensures operations are serialized. Different sessions (different userId:deviceId pairs) can run in parallel.

6. **Offline message catch-up:** When the app launches, local `messages.db` provides instant history. Then `GET /dm/:id/messages?after=<last_known_id>` catches up messages received while offline. Each server message is decrypted via the worker.

7. **Recipient has multiple devices:** The sender encrypts separately for each device. Each device gets its own ciphertext in the `recipients` array.

8. **Self-DM:** User creates a DM with themselves — allowed. The recipients array contains only the sender's own devices (if any other devices exist).

9. **App crash mid-ratchet:** If the app crashes after `ratchetEncrypt` but before persisting the updated session, the next encrypt will re-derive the same message key (because the old session state is still in the DB). The message will have the same counter, which the recipient can handle via skipped keys.

10. **WebSocket reconnect mid-send:** If the WebSocket disconnects between encryption and send, the encrypted ciphertext is lost. The user must retry (send again). The ratchet state has already advanced, so the next message will use a new message key — this is fine, the recipient handles gaps via skipped key management.

## Acceptance Criteria

1. Alice sends a DM to Bob → Bob receives and reads it → server never stores plaintext.
2. First message triggers X3DH handshake transparently; subsequent messages use Double Ratchet only.
3. `x3dh_header` is present only on the first message to each device.
4. WebSocket `message_send` for DMs is sent as MessagePack binary frame.
5. WebSocket `MESSAGE_CREATE` for DMs is received as MessagePack binary frame and decoded correctly.
6. Non-message ops (heartbeat, identify, resume, typing) remain JSON text frames.
7. Ciphertext fields are `Uint8Array` throughout — never converted to base64 in the client pipeline.
8. All crypto operations run in the Worker thread — renderer never touches libsodium or private keys.
9. TOFU identity change shows warning dialog; message is not sent until user approves.
10. Decryption failures show "message could not be decrypted" placeholder, never silently drop messages.
11. DM channels appear in sidebar from READY event.
12. Opening a DM loads local history from `messages.db` first, then catches up from server.
13. Sender's own plaintext is persisted to `messages.db` after encryption.
14. Per-session mutex prevents concurrent ratchet operations on the same session.
15. Shield badge visible on all DM conversations.
16. All Vitest unit tests pass.
17. All Playwright E2E tests pass.

## Implementation Order

1. **WebSocket MessagePack** — update `websocket.ts` for hybrid framing.
2. **Types** — update `ws.ts`, `models.ts`, `api.ts` with DM types.
3. **DM Channel Store** — new `dmChannelStore.ts`.
4. **READY handler** — populate DM channels.
5. **Crypto Worker ops** — add `encryptDm`, `establishAndEncryptDm`, `decryptDm`, session mutex, session index.
6. **Crypto service** — renderer-side helper for posting to worker.
7. **DM API endpoints** — add `dm` namespace to `api.ts`.
8. **Message store DM extensions** — `sendDmMessage`, `handleDmMessageCreate`, `fetchDmHistory`.
9. **UI — DM list and creation** — sidebar DM section, new DM modal.
10. **UI — DM chat view** — reuse MessageList/MessageInput with DM routing.
11. **UI — Encryption badge** — shield icon in DM header.
12. **Tests** — Vitest unit tests + Playwright E2E tests.
