# Phase 7c: Private Channel E2E Encryption & Messaging Polish

## Problem Statement

Mercury's E2E infrastructure supports DMs end-to-end (Phase 7b), and the server routes encrypted private-channel messages with epoch validation (Phase 7). The Sender Key crypto primitives are implemented and tested in isolation (Phase 6). However, nothing wires Sender Keys into the client message flow: the message store has no private-channel send/receive path, the crypto worker has no Sender Key ops, SenderKey distribution events aren't handled, the channel creation UI doesn't explain encryption trade-offs, and there are no encryption indicators for private channels.

Users cannot send or receive encrypted messages in private channels. This session completes the E2E story.

## Proposed Solution

1. Add Sender Key operations to the crypto worker (`encrypt_group`, `decrypt_group`, `receive_sender_key_distribution`).
2. Extend `messageStore` with a third send/receive path for private channels, alongside standard and DM.
3. Handle `SENDER_KEY_DISTRIBUTION` WebSocket events for key import.
4. Add queue-and-retry for messages received before the sender's key arrives.
5. Handle `MEMBER_ADD`/`MEMBER_REMOVE` for private channels (SenderKey distribution and stale marking).
6. Upgrade `EncryptionBadge` to support all three encryption modes with distinct icons/tooltips.
7. Add E2E join notice for private channels.
8. Add undecryptable message placeholder (unified for DMs and private channels).
9. Add pre-key replenishment after X3DH.
10. Write Vitest unit tests and Playwright E2E tests.

## Goals

- Alice sends a message to a private channel; Bob and Carol (members) see it decrypted. The server never sees plaintext.
- SenderKey generation, distribution, and rotation happen transparently on first send and membership changes.
- Messages received before the sender's key arrives are queued and retried when the distribution arrives.
- Stale SenderKey (epoch mismatch) triggers automatic rotation and retry (max 1 retry).
- Private channel history is local-first (messages.db), with server catch-up.
- Standard channel messages continue to work unchanged (plaintext, no encryption).
- DM messages continue to work unchanged (regression-safe).
- Encryption badges distinguish standard (none), private (lock), and DM (shield).
- Pre-key replenishment keeps OTP supply healthy after X3DH usage.
- All Vitest unit tests and Playwright E2E tests pass.

## Non-Goals

- Server-side changes (Phase 7 server routing is complete).
- Multi-device sender sync for private channels (sender encrypts once; their other devices receive via normal broadcast).
- File/media attachments in private channels.
- Message editing/deletion in private channels.
- Key verification UI (safety numbers) for channel members.
- Channel member invitation UI (members join via server membership; private channel membership = server membership for the channel).

## Detailed Design

### 1. Crypto Worker — New Sender Key Operations

**File:** `src/client/src/main/workers/crypto-worker-entry.ts`

#### `crypto:encryptGroup`

**Input:**
```typescript
{
  channelId: string
  plaintext: string
  channelEpoch: number
  memberDevices: Array<{ userId: string; deviceId: string }>
}
```

**Flow:**
1. Load our SenderKey for `(channelId, ourUserId, ourDeviceId)` from KeyStore.
2. If no SenderKey exists:
   a. Generate via `generateSenderKey(channelEpoch)`.
   b. Store in KeyStore.
   c. Distribute to all `memberDevices` (see distribution sub-flow below).
3. If SenderKey exists but `needsRotation(senderKey, channelEpoch)`:
   a. Generate new SenderKey with current `channelEpoch`.
   b. Store in KeyStore (replaces old).
   c. Distribute to all `memberDevices`.
4. `senderKeyEncrypt(senderKey, plaintextBytes, channelEpoch)` → `{ senderKey: updated, message }`.
5. Persist updated SenderKey to KeyStore.
6. Return `{ encrypted: { ciphertext, nonce, signature, iteration, epoch }, distributions? }`.

**Distribution sub-flow:**
For each member device:
1. Check if a Double Ratchet session exists (via session index).
2. If session exists: `createDistributionMessage(senderKey)` → `ratchetEncrypt(session, distMsg)` → update session.
3. If no session: return the device in a `needsX3dh` list. The renderer must fetch key bundles, establish sessions (reusing the DM X3DH flow), then call `crypto:distributeSenderKeyToDevices` with established sessions.

**Output:**
```typescript
{
  encrypted: {
    ciphertext: number[]   // AES-256-GCM ciphertext
    nonce: number[]        // 12-byte nonce
    signature: number[]    // Ed25519 signature
    iteration: number
    epoch: number
    sender_device_id: string
  }
  distributions?: Array<{
    device_id: string
    ciphertext: number[]  // DR-encrypted distribution message
  }>
  needsX3dh?: Array<{ userId: string; deviceId: string }>
}
```

#### `crypto:distributeSenderKeyToDevices`

Called after the renderer establishes X3DH sessions for devices that didn't have DR sessions. Same distribution sub-flow but guaranteed to have sessions.

**Input:**
```typescript
{
  channelId: string
  devices: Array<{ userId: string; deviceId: string }>
}
```

**Output:**
```typescript
{
  distributions: Array<{
    device_id: string
    ciphertext: number[]
  }>
}
```

#### `crypto:decryptGroup`

**Input:**
```typescript
{
  channelId: string
  senderId: string
  senderDeviceId: string
  ciphertext: number[]
  nonce: number[]
  signature: number[]
  iteration: number
  epoch: number
  messageId: string
  createdAt: number
}
```

**Flow:**
1. Load sender's SenderKey from KeyStore by `(channelId, senderId, senderDeviceId)`.
2. If no SenderKey found → return `{ error: 'MISSING_SENDER_KEY' }`.
3. `senderKeyDecrypt(senderKey, message, minEpoch=0)` → `{ senderKey: updated, plaintext }`.
4. ATOMIC: persist updated SenderKey + insert plaintext into messages.db (use a transaction).
5. Return `{ plaintext: string, messageId }`.

**Error handling:**
- `MISSING_SENDER_KEY` → renderer queues the message for retry.
- Decryption failure → return `{ error: 'DECRYPT_FAILED' }`.

#### `crypto:receiveSenderKeyDistribution`

**Input:**
```typescript
{
  channelId: string
  senderId: string
  senderDeviceId: string
  ciphertext: number[]  // DR-encrypted distribution message
}
```

**Flow:**
1. Load DR session for `(senderId, senderDeviceId)` from KeyStore.
2. If no session → return `{ error: 'NO_SESSION' }` (shouldn't happen in normal flow).
3. `ratchetDecrypt(session, deserializedMsg)` → distribution plaintext.
4. `importDistributionMessage(plaintext)` → received SenderKey.
5. Store SenderKey in KeyStore by `(channelId, senderId, senderDeviceId)`.
6. Persist updated DR session.
7. Return `{ stored: true, channelId, senderId, senderDeviceId }`.

#### `crypto:markSenderKeyStale`

**Input:**
```typescript
{
  channelId: string
}
```

**Flow:**
1. Load our SenderKey for `(channelId, ourUserId, ourDeviceId)`.
2. If exists, mark it as needing rotation by deleting it (lazy rotation — new key generated on next send with updated epoch).
3. Return `{ marked: true }`.

### 2. Renderer Crypto Service Extensions

**File:** `src/client/src/renderer/services/crypto.ts`

Add new methods to `cryptoService`:

```typescript
encryptGroup(params: {
  channelId: string
  plaintext: string
  channelEpoch: number
  memberDevices: Array<{ userId: string; deviceId: string }>
}): Promise<EncryptGroupResult>

decryptGroup(params: {
  channelId: string
  senderId: string
  senderDeviceId: string
  ciphertext: number[]
  nonce: number[]
  signature: number[]
  iteration: number
  epoch: number
  messageId: string
  createdAt: number
}): Promise<DecryptGroupResult>

receiveSenderKeyDistribution(params: {
  channelId: string
  senderId: string
  senderDeviceId: string
  ciphertext: number[]
}): Promise<{ stored: boolean }>

distributeSenderKeyToDevices(params: {
  channelId: string
  devices: Array<{ userId: string; deviceId: string }>
}): Promise<DistributeSenderKeyResult>

markSenderKeyStale(channelId: string): Promise<{ marked: boolean }>

generateOneTimePreKeys(count?: number): Promise<GenerateOtpResult>
```

### 3. Message Store — Private Channel Path

**File:** `src/client/src/renderer/stores/messageStore.ts`

#### Updated `sendMessage()`

```typescript
async sendMessage(channelId: string, content: string): Promise<void> {
  const dmChannel = useDmChannelStore.getState().dmChannels.get(channelId)
  if (dmChannel) {
    await sendDmMessage(channelId, dmChannel.recipient.id, content, get().addMessage)
    return
  }

  const channel = useServerStore.getState().channels.get(channelId)
  if (channel?.encryption_mode === 'private') {
    await sendPrivateChannelMessage(channelId, channel, content, get().addMessage)
    return
  }

  // Standard channel — plaintext
  wsManager.send('message_send', { channel_id: channelId, content })
}
```

#### `sendPrivateChannelMessage()` helper

1. Get the channel's `sender_key_epoch` from the channel record (available via server store or cached).
2. Get the channel's member list with their devices:
   - For each member (excluding self), fetch their device list.
   - Collect all `(userId, deviceId)` pairs.
3. Post `crypto:encryptGroup` to worker with `{ channelId, plaintext, channelEpoch, memberDevices }`.
4. If `needsX3dh` is returned:
   a. For each device without a session, perform X3DH (reuse DM flow: verify device list, fetch key bundle, claim OTP, call `crypto:establishAndEncryptDm` for session establishment only).
   b. Then call `crypto:distributeSenderKeyToDevices` for those devices.
5. Send distributions via WebSocket: `wsManager.send('sender_key_distribute', { channel_id, distributions })`.
6. Send encrypted message via WebSocket: `wsManager.send('message_send', { channel_id, encrypted })`.
7. Store sender's plaintext copy to messages.db via `crypto:storeMessage`.
8. Add optimistic message to in-memory store.

**Error handling:**
- If server returns `STALE_SENDER_KEY` error → call `crypto:markSenderKeyStale`, then retry send once (with `channelEpoch + 1`). Cap at 1 retry.
- If distribution fails for some devices → send the message anyway; those devices will request re-distribution later.

#### Updated `handleMessageCreate()`

```typescript
handleMessageCreate(event: MessageCreateEvent): void {
  if (event.dm_channel_id && event.ciphertext) {
    handleDmMessageCreate(event, get().addMessage)
  } else if (event.channel_id && event.encrypted) {
    handlePrivateChannelMessageCreate(event, get().addMessage)
  } else if (event.channel_id && event.content != null) {
    // Standard channel — plaintext
    get().addMessage(event.channel_id, { ... })
  }
}
```

#### `handlePrivateChannelMessageCreate()`

1. Extract `{ ciphertext, nonce, signature, sender_device_id, iteration, epoch }` from `event.encrypted`.
2. Skip decryption if sender is self (we already stored plaintext on send).
3. Post `crypto:decryptGroup` to worker.
4. On success: add decrypted message to store.
5. On `MISSING_SENDER_KEY`: add to pending queue (`pendingSenderKeyMessages`), show "Waiting for encryption key..." placeholder.
6. On `DECRYPT_FAILED`: show undecryptable placeholder.

#### `fetchPrivateChannelHistory(channelId)`

Same dual-storage pattern as DMs:
1. Load from messages.db first.
2. Fetch from server: `GET /channels/:id/messages?after=<last>`.
3. For each new message from server: decrypt via `crypto:decryptGroup`.
4. Merge into store (duplicate-aware).

### 4. Pending Message Queue

**In-memory Map in messageStore:** `pendingSenderKeyMessages: Map<string, PendingMessage[]>` keyed by `${channelId}:${senderId}:${senderDeviceId}`.

When a `SENDER_KEY_DISTRIBUTION` event arrives and `crypto:receiveSenderKeyDistribution` succeeds:
1. Check `pendingSenderKeyMessages` for the `(channelId, senderId, senderDeviceId)` key.
2. For each queued message, retry `crypto:decryptGroup`.
3. On success: update the placeholder message in the store with decrypted content.
4. On failure: leave as undecryptable placeholder.
5. Clear the queue entry.

### 5. WebSocket Event Handling — SENDER_KEY_DISTRIBUTION

**File:** `src/client/src/renderer/types/ws.ts`

Add new event type:
```typescript
export type ServerEventType = ... | 'SENDER_KEY_DISTRIBUTION'

export interface SenderKeyDistributionEvent {
  channel_id: string
  sender_id: string
  sender_device_id: string
  ciphertext: Uint8Array
}

export interface WSEventMap {
  ...
  SENDER_KEY_DISTRIBUTION: SenderKeyDistributionEvent
}
```

**File:** `src/client/src/renderer/services/websocket.ts`

Add case in `handleMessage()`:
```typescript
case 'SENDER_KEY_DISTRIBUTION': {
  this.emit('SENDER_KEY_DISTRIBUTION', envelope.d as SenderKeyDistributionEvent)
  break
}
```

**File:** `src/client/src/renderer/App.tsx`

Wire the event:
```typescript
const unsubSKD = wsManager.on('SENDER_KEY_DISTRIBUTION', (data) => {
  useMessageStore.getState().handleSenderKeyDistribution(data)
})
```

### 6. MessageCreateEvent Extension

**File:** `src/client/src/renderer/types/ws.ts`

Add `encrypted` field to `MessageCreateEvent`:
```typescript
export interface MessageCreateEvent {
  id: string
  channel_id?: string
  dm_channel_id?: string
  sender_id: string
  sender_device_id?: string
  content?: string | null
  ciphertext?: Uint8Array        // DM
  ratchet_header?: Uint8Array    // DM
  x3dh_header?: { ... }         // DM
  encrypted?: {                  // Private channel (new)
    ciphertext: Uint8Array
    nonce: Uint8Array
    signature: Uint8Array
    sender_device_id: string
    iteration: number
    epoch: number
  }
  created_at: string
}
```

### 7. MEMBER_ADD / MEMBER_REMOVE Handling for Private Channels

**File:** `src/client/src/renderer/App.tsx`

Extend existing handlers:

**MEMBER_ADD:**
```typescript
wsManager.on('MEMBER_ADD', async (data) => {
  useServerStore.getState().addMember(data.server_id, data.user_id)

  // For private channels: distribute our SenderKey to the new member
  const channels = useServerStore.getState().getServerChannels(data.server_id)
  for (const channel of channels) {
    if (channel.encryption_mode === 'private') {
      await useMessageStore.getState().distributeSenderKeyToNewMember(
        channel.id, data.user_id
      )
    }
  }

  // Display system message in private channels
  for (const channel of channels) {
    if (channel.encryption_mode === 'private') {
      useMessageStore.getState().addSystemMessage(
        channel.id,
        `${data.user_id} joined the channel.`
      )
    }
  }
})
```

**MEMBER_REMOVE:**
```typescript
wsManager.on('MEMBER_REMOVE', async (data) => {
  useServerStore.getState().removeMember(data.server_id, data.user_id)

  // For private channels: mark SenderKey as stale (lazy rotation on next send)
  const channels = useServerStore.getState().getServerChannels(data.server_id)
  for (const channel of channels) {
    if (channel.encryption_mode === 'private') {
      await cryptoService.markSenderKeyStale(channel.id)

      useMessageStore.getState().addSystemMessage(
        channel.id,
        `${data.user_id} was removed from the channel.`
      )
    }
  }
})
```

### 8. System Messages

Add to `messageStore`:

```typescript
addSystemMessage(channelId: string, text: string): void {
  const message: Message = {
    id: `system-${Date.now()}-${Math.random()}`,
    channel_id: channelId,
    sender_id: 'system',
    content: text,
    message_type: 'system',
    created_at: new Date().toISOString(),
    edited_at: null,
  }
  get().addMessage(channelId, message)
}
```

These are local-only (not sent to server). The `MessageItem` component renders them with distinct styling (centered, muted text, no avatar).

### 9. E2E Join Notice

When a user opens a private channel for the first time (no local history in messages.db and no messages in store), display a system message:

"Messages in this channel are end-to-end encrypted. You can only see messages sent after you joined."

This is injected in `fetchPrivateChannelHistory()` when the local message count is 0.

### 10. EncryptionBadge Upgrade

**File:** `src/client/src/renderer/components/dm/EncryptionBadge.tsx`

Rename/move to `src/client/src/renderer/components/common/EncryptionBadge.tsx`.

Update to accept `mode` prop:

```typescript
interface EncryptionBadgeProps {
  mode: 'standard' | 'private' | 'e2e_dm'
}

export function EncryptionBadge({ mode }: EncryptionBadgeProps): React.ReactElement | null {
  if (mode === 'standard') return null

  if (mode === 'private') {
    // Lock icon + "Encrypted" with tooltip about private channel
    return (
      <span title="End-to-end encrypted. Only channel members can read messages.">
        {/* Lock SVG */} Encrypted
      </span>
    )
  }

  if (mode === 'e2e_dm') {
    // Shield icon + "Encrypted" with tooltip about DM
    return (
      <span title="End-to-end encrypted. Only you and the recipient can read these messages.">
        {/* Shield SVG */} Encrypted
      </span>
    )
  }

  return null
}
```

**Usage in ServerPage.tsx:**
- DM view: `<EncryptionBadge mode="e2e_dm" />`
- Private channel view: `<EncryptionBadge mode="private" />`
- Standard channel view: no badge

**Usage in ChannelList.tsx:**
- Private channels: show small lock icon next to channel name.

### 11. Undecryptable Message Placeholder

**File:** `src/client/src/renderer/components/chat/MessageItem.tsx`

Update the `decrypt_error` rendering:

```typescript
if (message.decrypt_error) {
  if (message.decrypt_error === 'MISSING_SENDER_KEY') {
    return <div className="italic text-text-muted">Waiting for encryption key...</div>
  }
  return (
    <div className="flex items-center gap-1 italic text-text-muted">
      {/* Lock icon */}
      This message could not be decrypted.
    </div>
  )
}
```

Also add system message rendering:
```typescript
if (message.message_type === 'system') {
  return (
    <div className="flex justify-center py-2">
      <span className="text-xs text-text-muted">{message.content}</span>
    </div>
  )
}
```

### 12. Pre-Key Replenishment

After any X3DH session establishment (in `sendDmMessage` and `sendPrivateChannelMessage` when establishing sessions for distribution):

```typescript
// Background pre-key replenishment
async function maybeReplenishPreKeys(): Promise<void> {
  try {
    const publicKeys = await cryptoService.getPublicKeys()
    if (publicKeys.unusedPreKeyCount < 30) {
      const result = await cryptoService.generateOneTimePreKeys(100)
      await devices.uploadKeyBundle(publicKeys.deviceId, {
        one_time_prekeys: result.keys,
      })
    }
  } catch (err) {
    console.warn('[PreKeys] Replenishment failed (will retry later):', err)
  }
}
```

This runs as a fire-and-forget background task. It does not block the message flow. Failure is non-fatal.

### 13. Channel Epoch Tracking

The channel's `sender_key_epoch` is needed for encryption. This comes from the server:
- In the `READY` event, channels include `sender_key_epoch` (if 0, no messages have been sent yet).
- On `MEMBER_ADD`/`MEMBER_REMOVE`, the epoch may increment (server handles this).
- The `Channel` type in `models.ts` needs a `sender_key_epoch` field.

Add to `Channel` type:
```typescript
export interface Channel {
  ...
  sender_key_epoch?: number  // present for private channels
}
```

### 14. Private Channel History API

Use the existing `GET /channels/:id/messages` endpoint. For private channels, the server returns messages with `encrypted` payloads (ciphertext, nonce, signature, iteration, epoch, sender_device_id). The client decrypts each message via the worker.

No new API endpoints needed — the server already handles this (Phase 7).

## Edge Cases

1. **First message to a new private channel**: No SenderKey exists yet → generate, distribute to all members, then encrypt. If some members have no DR sessions, establish via X3DH first.

2. **Message before SenderKey distribution arrives**: Receiver has no SenderKey for the sender → queue message with `MISSING_SENDER_KEY` status → retry when distribution arrives.

3. **Stale epoch (server rejects)**: Server returns `STALE_SENDER_KEY` → client marks key stale, generates new key, distributes, retries send. Max 1 retry to avoid infinite loops.

4. **Member removed while message in flight**: The message was encrypted with the old key (pre-removal). It will still decrypt for remaining members. The removed member may also decrypt it if they received it. Future messages use a rotated key (lazy rotation on next send).

5. **Member added**: Current members distribute their SenderKeys to the new member. The new member can only decrypt messages sent after they receive the distributions. History before join is inaccessible.

6. **Offline member**: When a member comes back online, they receive queued `SENDER_KEY_DISTRIBUTION` events. Queued messages are retried after distributions are processed.

7. **Self-echo skip**: After encrypting, the sender's chain advances past the message. When the server echoes back the message, the sender skips decryption (already has plaintext from local storage).

8. **Concurrent sends**: The worker's per-session mutex protects DR sessions during distribution. SenderKey encryption is single-threaded (one channel operation at a time via worker message queue).

9. **100-member cap**: The `distributeSenderKey` function enforces max 99 devices (100 members minus self). The UI prevents inviting beyond 100 members. The server also enforces via CHECK constraint.

10. **Distribution failure for some devices**: Send the message anyway. Those devices will show "Waiting for encryption key..." and receive the distribution when re-sent or when they reconnect.

11. **App crash mid-encryption**: If the app crashes after SenderKey ratchet but before WebSocket send, the next send will use the advanced chain key. The skipped iteration is handled by receivers via the skipped-keys mechanism.

12. **No DR session for distribution**: If we need to distribute to a member's device that has no DR session, we must first establish one via X3DH. This is the same flow as DM session establishment.

## Acceptance Criteria

1. Alice sends a message to a private channel → Bob and Carol (members) see it decrypted. Server stores only ciphertext.
2. SenderKey is generated and distributed transparently on first send.
3. SenderKey rotates on membership change (lazy — on next send after a member is removed).
4. Messages received before SenderKey distribution show "Waiting for encryption key..." and auto-resolve when distribution arrives.
5. Stale epoch triggers automatic rotation and retry (max 1 retry).
6. `MEMBER_ADD` → distribute SenderKey to new member + system message.
7. `MEMBER_REMOVE` → mark SenderKey stale + system message.
8. Private channel history loads from messages.db first, then server catch-up.
9. E2E join notice appears as first message for new channel members.
10. Standard channels continue to work unchanged (plaintext, no crypto).
11. DM channels continue to work unchanged (no regression).
12. EncryptionBadge shows: nothing for standard, lock for private, shield for DM.
13. Lock icon appears next to private channel names in the channel list.
14. Undecryptable messages show lock icon + "This message could not be decrypted."
15. System messages render centered with muted styling.
16. Pre-key replenishment fires after X3DH when OTP count < 30.
17. Create Channel modal shows encryption mode choices with trade-off descriptions.
18. All Vitest unit tests pass.
19. All Playwright E2E tests pass.

## Implementation Order

1. **Types** — Update `ws.ts` (SenderKeyDistributionEvent, encrypted field on MessageCreateEvent), `models.ts` (sender_key_epoch, decrypt_error extension).
2. **Crypto worker ops** — Add `crypto:encryptGroup`, `crypto:decryptGroup`, `crypto:receiveSenderKeyDistribution`, `crypto:distributeSenderKeyToDevices`, `crypto:markSenderKeyStale`, `crypto:generateOneTimePreKeys` (already exists).
3. **Crypto service** — Add renderer-side methods for new worker ops.
4. **Message store — private channel send** — `sendPrivateChannelMessage()` with distribution flow.
5. **Message store — private channel receive** — `handlePrivateChannelMessageCreate()` with pending queue.
6. **Message store — SenderKey distribution handler** — `handleSenderKeyDistribution()` with queue retry.
7. **Message store — private channel history** — `fetchPrivateChannelHistory()`.
8. **WebSocket event handling** — Add `SENDER_KEY_DISTRIBUTION` case.
9. **App.tsx wiring** — Wire `SENDER_KEY_DISTRIBUTION`, extend `MEMBER_ADD`/`MEMBER_REMOVE`.
10. **EncryptionBadge** — Upgrade with mode prop, move to common.
11. **MessageItem** — System message rendering, undecryptable placeholder.
12. **ServerPage** — Show EncryptionBadge for private channels.
13. **ChannelList** — Lock icon for private channels.
14. **E2E join notice** — System message on first private channel open.
15. **Pre-key replenishment** — Background task after X3DH.
16. **Vitest unit tests**.
17. **Playwright E2E tests**.

## Test Plan

### Vitest Unit Tests

1. **Private channel send flow**: Mock worker → verify `senderKeyEncrypt` called with correct epoch → verify WebSocket payload has `{ channel_id, encrypted: { ciphertext, nonce, signature, sender_device_id, iteration, epoch } }`.

2. **Private channel receive flow**: Mock worker → post `MESSAGE_CREATE` with `encrypted` field → verify `crypto:decryptGroup` called → verify messages.db write → verify message appears in store.

3. **SenderKey distribution receive**: Mock `SENDER_KEY_DISTRIBUTION` event → verify `crypto:receiveSenderKeyDistribution` called → verify KeyStore updated.

4. **Missing SenderKey → queue → retry**: Receive message before distribution → verify `MISSING_SENDER_KEY` error → verify message queued → receive distribution → verify retry → verify successful decrypt.

5. **Stale SenderKey**: Mock epoch mismatch error from server → verify `markSenderKeyStale` called → verify rotation on next send → verify distribution → verify retry.

6. **EncryptionBadge**: Render with `mode='standard'` → null. Render with `mode='private'` → lock icon + correct tooltip. Render with `mode='e2e_dm'` → shield icon + correct tooltip.

7. **Channel creation**: Select "Private Channel" in modal → submit → verify `createChannel` called with `encryption_mode: 'private'`.

8. **Pre-key replenishment**: Mock OTP count < 30 → verify `crypto:generateOneTimePreKeys` called → verify upload.

9. **System messages**: Call `addSystemMessage()` → verify message in store with `message_type: 'system'`.

10. **Self-echo skip**: Send private channel message → receive echo with own sender_id → verify no decrypt attempt.

### Playwright E2E Tests

1. **Private channel round-trip**: Register Alice, Bob, Carol. Create a private channel with all three. Alice sends message → Bob and Carol see it decrypted.

2. **Member removal**: Remove Carol from channel. Alice sends another message → Bob sees it. Carol does not.

3. **Standard channel no encryption**: Create standard channel → send message → verify content visible (no encryption).

4. **DM regression**: Send DM between Alice and Bob → verify it still works.

5. **History persistence**: Alice sends DM → close app → reopen → DM history loads from local db.

6. **Mixed channel types**: One standard and one private channel on same server → messages in each use correct path.
