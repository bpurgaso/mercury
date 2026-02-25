# Phase 8 Session 3: Insertable Streams — Media E2E Encryption

## Problem Statement

Mercury's voice/video calls pass through an SFU (Selective Forwarding Unit) that routes media between participants. While DTLS-SRTP encrypts media in transit, the SFU can theoretically decrypt and inspect media content because it terminates the DTLS connection on each side. Users who communicate over Mercury expect true end-to-end encryption where the server (SFU) cannot access their media content.

**Who has this problem:** All Mercury users in voice/video calls. The SFU operator (or an attacker who compromises the SFU) could eavesdrop on calls without frame-level E2E encryption.

## Proposed Solution

Use the **Insertable Streams API** (`RTCRtpSender.createEncodedStreams()` / `RTCRtpReceiver.createEncodedStreams()`) to encrypt each media frame with a shared AES-256-GCM symmetric key before it reaches the SFU. The SFU forwards opaque encrypted payloads it cannot decrypt. Key distribution uses the existing Double Ratchet infrastructure (per-device E2E encrypted messaging).

## Goals

1. Every media frame (audio and video) is AES-256-GCM encrypted before leaving the sender, with a per-frame random IV.
2. The SFU can see only a 1-byte `key_epoch` tag (for routing/debugging) but cannot decrypt frame content.
3. Key rotation occurs on participant join/leave, with old keys retained for 5 seconds to handle late UDP packets.
4. Frames arriving with an unknown epoch are dropped silently (not garbled).
5. All crypto operations (AES-GCM for frame data) run in the Renderer via Web Crypto API for < 5ms latency per frame.
6. Media key distribution uses existing E2E encrypted signaling (crypto worker → Double Ratchet).

## Non-Goals

- SFU-side changes (SFU already forwards opaque payloads; no server code changes needed).
- End-to-end encryption for signaling metadata (SDP, ICE candidates) — already handled by DTLS.
- Forward secrecy on media keys (ratcheting the media key per-frame — too expensive for real-time media; instead we rotate on join/leave).
- UI for displaying encryption status indicators (separate session).
- Screenshare encryption (same mechanism, but screenshare tracks are not yet implemented).

## Detailed Design

### 1. MediaKeyRing Class

**File:** `src/client/src/renderer/services/media-key-ring.ts`

```typescript
class MediaKeyRing {
  private keys: Map<number, { key: CryptoKey; expiresAt: number }>;
  private cleanupTimers: Map<number, ReturnType<typeof setTimeout>>;
  currentEpoch: number;
  currentKey: CryptoKey | null;

  constructor();
  rotateKey(newKey: CryptoKey): void;
  getKeyForEpoch(epoch: number): CryptoKey | null;
  setInitialKey(key: CryptoKey, epoch: number): void;
  destroy(): void;
}
```

**Behavior:**
- `rotateKey(newKey)`: Increments `currentEpoch` (wraps 255 → 0), sets `currentKey = newKey`, stores in `keys` map with `expiresAt: Infinity`. Sets old key's `expiresAt` to `Date.now() + 5000` and schedules deletion via `setTimeout(5000)`.
- `getKeyForEpoch(epoch)`: Returns the CryptoKey if the epoch exists in the map AND `Date.now() <= expiresAt`. Returns `null` otherwise.
- `setInitialKey(key, epoch)`: Sets the very first key (epoch 0 at call start) without incrementing. Stores in map with `expiresAt: Infinity`.
- `destroy()`: Clears all keys and cleanup timers.

**Key zeroing:** CryptoKey objects are opaque handles in Web Crypto API — they cannot be read or zeroed from JavaScript. When we "delete" a key, we remove it from the Map, making it unreachable and eligible for GC. The underlying key material is managed by the browser's crypto subsystem. This is the standard approach for Web Crypto and matches how all major browsers handle CryptoKey lifecycle.

### 2. Sender Transform

**File:** `src/client/src/renderer/services/frame-crypto.ts`

```typescript
function createSenderTransform(keyRing: MediaKeyRing): TransformStream;
```

For each encoded frame:
1. Read `frame.data` as `Uint8Array`
2. Generate 12-byte random IV via `crypto.getRandomValues()`
3. Encrypt with `crypto.subtle.encrypt('AES-GCM', keyRing.currentKey, iv, frameData)`
4. Build output: `[keyRing.currentEpoch (1B)] [IV (12B)] [ciphertext (N bytes)]`
5. Set `frame.data = output.buffer`
6. Enqueue frame

If `keyRing.currentKey` is null (no key yet), drop the frame silently.

### 3. Receiver Transform

**File:** `src/client/src/renderer/services/frame-crypto.ts`

```typescript
function createReceiverTransform(keyRing: MediaKeyRing): TransformStream;
```

For each encoded frame:
1. Read `frame.data` as `Uint8Array`
2. Parse: `epoch = data[0]`, `iv = data.slice(1, 13)`, `ciphertext = data.slice(13)`
3. Look up key: `keyRing.getKeyForEpoch(epoch)`
4. If no key → drop frame silently (return without enqueuing)
5. Decrypt with `crypto.subtle.decrypt('AES-GCM', key, iv, ciphertext)`
6. Set `frame.data = decrypted`
7. Enqueue frame

If decryption fails (authentication tag mismatch), drop frame silently.

### 4. Applying Transforms to WebRTCManager

**File:** `src/client/src/renderer/services/webrtc.ts` (modify existing)

Add methods:
```typescript
class WebRTCManager {
  private keyRing: MediaKeyRing | null = null;

  setMediaKeyRing(keyRing: MediaKeyRing): void;

  applySenderTransform(sender: RTCRtpSender): void;
  applyReceiverTransform(receiver: RTCRtpReceiver): void;
}
```

**Integration points:**
- After `pc.addTrack()` in `enableMicrophone()` and `enableCamera()`, call `applySenderTransform(sender)`.
- In `pc.ontrack`, call `applyReceiverTransform(event.receiver)` before notifying listeners.
- `leaveCall()` calls `keyRing.destroy()` and sets `keyRing = null`.

### 5. Key Generation and Distribution

**Key generation:**
```typescript
async function generateMediaKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,  // extractable (needed for distribution)
    ['encrypt', 'decrypt']
  );
}
```

**Key serialization for distribution:**
```typescript
async function exportMediaKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

async function importMediaKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', raw,
    { name: 'AES-GCM', length: 256 },
    false,  // non-extractable once imported for use
    ['encrypt', 'decrypt']
  );
}
```

**Distribution flow:**
1. Generate key → export to raw bytes → send to crypto worker as `encrypt_dm` with message type `media_key`.
2. Crypto worker encrypts via Double Ratchet per-device → sends via WebSocket.
3. Receiver's message handler detects `type: "media_key"` → imports raw key → calls `keyRing.rotateKey()` or `keyRing.setInitialKey()`.

### 6. Media Key Signaling

**Message format:**
```typescript
interface MediaKeyMessage {
  type: 'media_key';
  room_id: string;
  key: Uint8Array;  // 32 bytes raw AES-256 key
  epoch: number;
}
```

This message is encrypted per-device via Double Ratchet (same path as DMs) and transmitted through WebSocket. The receiver detects `type === 'media_key'` and routes to the MediaKeyRing instead of displaying in chat.

**Distribution via cryptoService:**
```typescript
// In crypto.ts, add:
distributeMediaKey(params: {
  roomId: string;
  recipientIds: string[];
  key: Uint8Array;
  epoch: number;
}): Promise<void>;
```

### 7. callStore Integration

**File:** `src/client/src/renderer/stores/callStore.ts` (modify existing)

Add to `joinCall()` flow:
1. After `webRTCManager.createPeerConnection()`, create a `MediaKeyRing` instance.
2. Call `webRTCManager.setMediaKeyRing(keyRing)`.
3. Generate initial media key, set epoch 0 via `keyRing.setInitialKey()`.
4. Distribute key to all participants.

Add WebSocket listener for `MEDIA_KEY` events:
- Parse the media key message.
- Import the raw key bytes.
- Call `keyRing.setInitialKey()` or `keyRing.rotateKey()` depending on whether this is the first key or a rotation.

Add to `leaveCall()`:
- `keyRing.destroy()` is called via `webRTCManager.leaveCall()`.

## Edge Cases

1. **Late UDP packets after key rotation:** Old key retained for 5 seconds. Frames with old epoch decrypt successfully during retention window; dropped silently after.

2. **Key not yet received:** Frames with unknown epoch are dropped silently. Audio/video briefly pauses (< 100ms for audio, one frame for video) rather than producing garbled output.

3. **Participant joins mid-call:** New key generated, epoch incremented, distributed to ALL participants (including joiner). Old key retained 5 seconds. Brief frame drops for the new participant until they receive and install the key.

4. **Participant leaves:** New key generated, epoch incremented, distributed to remaining participants ONLY. Leaver cannot decrypt new frames even if they somehow receive them.

5. **Epoch wrapping (255 → 0):** `currentEpoch = (currentEpoch + 1) % 256`. The key map is keyed by epoch number. When epoch wraps, the old epoch 0 key (if still retained) is overwritten — acceptable because the 5-second retention window will have long expired.

6. **Multiple rapid rotations:** Each rotation schedules its own 5-second cleanup. If multiple rotations happen within 5 seconds, multiple old keys coexist in the map briefly. The map correctly returns the right key for each epoch.

7. **Decryption failure (corrupted frame):** AES-GCM authentication tag check fails → `crypto.subtle.decrypt()` throws → catch and drop frame silently.

8. **No key set at call start:** `currentKey` starts as `null`. Sender transform checks for null and drops frames until a key is set. Prevents sending unencrypted frames.

## Acceptance Criteria

1. **MediaKeyRing:**
   - `rotateKey()` increments `currentEpoch` and wraps at 255 → 0.
   - Old key is retrievable via `getKeyForEpoch()` for 5 seconds after rotation.
   - Old key returns null after 5 seconds.
   - `getKeyForEpoch(unknownEpoch)` returns null.

2. **Sender transform:**
   - Output frame has layout: `[epoch (1B)] [IV (12B)] [ciphertext]`.
   - Epoch byte matches `keyRing.currentEpoch`.
   - Ciphertext decrypts to original frame data with the correct key and IV.

3. **Receiver transform:**
   - Frame with known epoch and valid ciphertext → decrypts correctly and is enqueued.
   - Frame with unknown epoch → dropped silently (not enqueued).
   - Frame with corrupted ciphertext → dropped silently.

4. **Key rotation during call:**
   - After rotation, new frames use new epoch.
   - Frames with old epoch still decrypt within 5-second window.
   - Frames with old epoch are dropped after 5-second window.

5. **Integration:**
   - Sender transforms applied to all outgoing senders.
   - Receiver transforms applied to all incoming receivers.
   - Key rotation events update the keyRing.
   - Media key distribution sends encrypted key to all participants.

6. **Tests:**
   - All unit tests pass for MediaKeyRing, sender/receiver transforms, key rotation, and distribution.
