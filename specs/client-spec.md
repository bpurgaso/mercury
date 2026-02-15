# Mercury Client — Technical Specification

**Project Codename:** Mercury
**Component:** Desktop Client
**Version:** 0.1.0 (MVP)
**Framework:** Electron
**Platforms:** Windows, macOS, Linux

---

## 1. Project Overview

The Mercury client is a cross-platform desktop application built with Electron, providing text, voice, and video communication with full end-to-end encryption. The client is responsible for **all cryptographic operations** — the server never has access to plaintext content.

### 1.1 Design Principles

- **Client-side encryption is law:** All encryption/decryption happens locally. Private keys never leave the device.
- **Offline-capable crypto:** Key generation, ratchet state, and session management work offline. Messages queue for delivery.
- **Native feel:** Despite being Electron, the app should feel responsive with smooth animations, native OS integrations (notifications, tray icon, system theme), and minimal memory footprint.
- **Multi-device ready (future):** Data model and key management support multiple devices per user from day one, even though MVP targets single-device.

### 1.2 MVP Scope

| Feature | Status |
|---------|--------|
| User registration, login, session management | **MVP** |
| Server browser, join/create servers | **MVP** |
| Channel-based text chat (E2E encrypted) | **MVP** |
| Direct messages 1:1 (E2E encrypted) | **MVP** |
| Voice calls (channel + DM, E2E encrypted) | **MVP** |
| Video calls (channel + DM, E2E encrypted) | **MVP** |
| Presence & typing indicators | **MVP** |
| Server-configurable media quality | **MVP** |
| Block/mute users, DM privacy controls | **MVP** |
| Content reporting with optional evidence | **MVP** |
| Moderation dashboard (server owner) | **MVP** |
| Abuse signal alerts (server owner) | **MVP** |
| Message franking (cryptographic proof) | **v2** |
| Screen sharing | Future |
| File attachments | Future |
| Message search | Future |
| Rich text / markdown rendering | Future |
| Mobile client (React Native or separate) | Future |

---

## 2. Technology Stack

### 2.1 Core

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Shell | **Electron 33+** | Cross-platform, mature ecosystem, Discord-proven pattern |
| Renderer framework | **React 18+** | Component model, large ecosystem, excellent DevTools |
| Language | **TypeScript 5+** | Type safety across entire codebase |
| Build tool | **Vite** | Fast HMR, ESBuild-powered, excellent Electron integration via `electron-vite` |
| State management | **Zustand** | Lightweight, TypeScript-first, no boilerplate |
| Styling | **Tailwind CSS 4** + **CSS Modules** (escape hatch) | Utility-first, consistent design tokens, small bundle |
| Routing | **React Router 7** or **TanStack Router** | Client-side navigation between views |
| WebSocket client | **Custom (native WebSocket)** | Lightweight, full control over reconnection logic |
| WebRTC | **Native browser WebRTC APIs** | Electron ships Chromium's full WebRTC stack |
| Crypto (E2E text) | **@aspect-build/aspect-signal-protocol** or custom using **libsodium.js (libsodium-wrappers)** | Signal Protocol (X3DH + Double Ratchet) for message encryption |
| Crypto (E2E media) | **WebRTC Insertable Streams (Encoded Transform)** + **libsodium** | Frame-level encryption/decryption through the SFU |
| Local storage (crypto keys) | **Electron safeStorage** + **SQLite (better-sqlite3)** | OS-level encryption for key material; SQLite for structured local data |
| IPC | **Electron contextBridge + ipcRenderer/ipcMain** | Secure main↔renderer communication |
| Notifications | **Electron Notification API** + OS native | Desktop notifications for messages and calls |
| Auto-update | **electron-updater** | Background updates with differential downloads |
| Packaging | **electron-builder** | Cross-platform builds, code signing, installers |

### 2.2 Development & Testing

| Tool | Purpose |
|------|---------|
| `electron-vite` | Dev server with HMR for renderer + main process |
| `Vitest` | Unit and integration tests |
| `Playwright` | E2E UI testing |
| `ESLint` + `Prettier` | Linting and formatting |
| `electron-devtools-installer` | React DevTools in Electron |
| `Storybook` | Component development in isolation |

---

## 3. Architecture

### 3.1 High-Level Architecture

```
┌───────────────────────────────────────────────────────────┐
│                     Electron App                          │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                 Main Process                         │  │
│  │                                                     │  │
│  │  ┌──────────┐ ┌───────────┐ ┌────────────────────┐  │  │
│  │  │ App      │ │ Crypto    │ │ Key Store          │  │  │
│  │  │ Lifecycle│ │ Engine    │ │ (safeStorage +     │  │  │
│  │  │          │ │ (libsodium│ │  better-sqlite3)   │  │  │
│  │  │ • Tray   │ │  + Signal │ │                    │  │  │
│  │  │ • Window │ │  Protocol)│ │ • Identity keys    │  │  │
│  │  │ • Update │ │           │ │ • Session state    │  │  │
│  │  │ • IPC    │ │ • Encrypt │ │ • Ratchet state    │  │  │
│  │  └──────────┘ │ • Decrypt │ │ • Sender keys      │  │  │
│  │               │ • X3DH    │ └────────────────────┘  │  │
│  │               │ • Ratchet │                         │  │
│  │               └───────────┘                         │  │
│  └───────────────────────┬─────────────────────────────┘  │
│                    IPC (contextBridge)                     │
│  ┌───────────────────────▼─────────────────────────────┐  │
│  │                Renderer Process                      │  │
│  │                                                     │  │
│  │  ┌───────────┐ ┌───────────┐ ┌──────────────────┐  │  │
│  │  │ React UI  │ │ WebSocket │ │ WebRTC Manager   │  │  │
│  │  │           │ │ Manager   │ │                  │  │  │
│  │  │ • Servers │ │           │ │ • PeerConnection │  │  │
│  │  │ • Channels│ │ • Connect │ │ • Insertable     │  │  │
│  │  │ • Chat    │ │ • Events  │ │   Streams (E2E)  │  │  │
│  │  │ • Calls   │ │ • Reconnect│ │ • getUserMedia  │  │  │
│  │  │ • DMs     │ │ • Queue   │ │ • Track mgmt    │  │  │
│  │  │ • Settings│ │           │ │ • Quality adapt  │  │  │
│  │  └───────────┘ └───────────┘ └──────────────────┘  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
└───────────────────────────────────────────────────────────┘
              │                           │
         WSS (TLS)                   DTLS-SRTP (UDP)
              │                           │
         ┌────▼───────────────────────────▼────┐
         │            Mercury Server               │
         └─────────────────────────────────────┘
```

### 3.2 Process Model & Security Boundaries

| Process | Role | Access |
|---------|------|--------|
| **Main** | App lifecycle, crypto engine, key storage, IPC bridge | Full Node.js, file system, OS APIs |
| **Renderer** | React UI, WebSocket, WebRTC, user interaction | Sandboxed, no Node.js, only exposed IPC APIs |
| **Preload** | contextBridge — exposes safe API surface to renderer | Limited: only whitelisted IPC methods |

**Critical rule:** Private keys NEVER enter the renderer process. All crypto operations go through IPC to the main process.

### 3.3 Project Structure

```
mercury-client/
├── package.json
├── electron.vite.config.ts
├── electron-builder.config.yml
├── tsconfig.json
├── src/
│   ├── main/                          # Electron main process
│   │   ├── index.ts                   # App entry point, window management
│   │   ├── ipc/
│   │   │   ├── handlers.ts            # IPC handler registration
│   │   │   ├── crypto.ipc.ts          # Crypto operation handlers
│   │   │   └── keystore.ipc.ts        # Key storage operation handlers
│   │   ├── crypto/
│   │   │   ├── engine.ts              # Crypto engine orchestrator
│   │   │   ├── x3dh.ts               # X3DH key agreement
│   │   │   ├── double-ratchet.ts      # Double Ratchet implementation
│   │   │   ├── sender-keys.ts         # Group/channel sender keys
│   │   │   ├── media-keys.ts          # Media E2E frame encryption keys
│   │   │   ├── report-crypto.ts      # Encrypt report evidence to operator moderation key
│   │   │   └── utils.ts              # Key serialization, random bytes
│   │   ├── store/
│   │   │   ├── keystore.ts            # safeStorage-encrypted key persistence
│   │   │   ├── sessions.db.ts         # SQLite session/ratchet state
│   │   │   └── migrations/            # SQLite schema migrations
│   │   ├── updater.ts                 # Auto-update logic
│   │   └── tray.ts                    # System tray management
│   ├── preload/
│   │   ├── index.ts                   # contextBridge exposure
│   │   └── api.ts                     # Type-safe API surface definition
│   ├── renderer/                      # React application
│   │   ├── index.html
│   │   ├── main.tsx                   # React root
│   │   ├── App.tsx                    # Top-level layout + routing
│   │   ├── assets/                    # Static assets (icons, sounds)
│   │   ├── components/
│   │   │   ├── ui/                    # Base UI components
│   │   │   │   ├── Button.tsx
│   │   │   │   ├── Input.tsx
│   │   │   │   ├── Modal.tsx
│   │   │   │   ├── Avatar.tsx
│   │   │   │   ├── Tooltip.tsx
│   │   │   │   └── ContextMenu.tsx
│   │   │   ├── layout/
│   │   │   │   ├── Sidebar.tsx        # Server list sidebar
│   │   │   │   ├── ChannelList.tsx    # Channel sidebar
│   │   │   │   ├── MemberList.tsx     # Right sidebar - members
│   │   │   │   └── TitleBar.tsx       # Custom title bar (frameless window)
│   │   │   ├── chat/
│   │   │   │   ├── MessageList.tsx    # Virtualized message list
│   │   │   │   ├── MessageItem.tsx    # Single message render
│   │   │   │   ├── MessageInput.tsx   # Compose area
│   │   │   │   └── TypingIndicator.tsx
│   │   │   ├── voice/
│   │   │   │   ├── VoicePanel.tsx     # Connected voice channel panel
│   │   │   │   ├── VoiceControls.tsx  # Mute, deafen, disconnect
│   │   │   │   ├── ParticipantTile.tsx # Participant audio/video tile
│   │   │   │   └── CallOverlay.tsx    # Incoming/outgoing call overlay
│   │   │   ├── video/
│   │   │   │   ├── VideoGrid.tsx      # Video call grid layout
│   │   │   │   ├── VideoTile.tsx      # Single participant video
│   │   │   │   └── VideoControls.tsx  # Camera, quality selector
│   │   │   ├── server/
│   │   │   │   ├── ServerIcon.tsx
│   │   │   │   ├── CreateServerModal.tsx
│   │   │   │   ├── JoinServerModal.tsx
│   │   │   │   └── ServerSettings.tsx
│   │   │   ├── dm/
│   │   │   │   ├── DmList.tsx
│   │   │   │   └── DmConversation.tsx
│   │   │   ├── moderation/
│   │   │   │   ├── ReportDialog.tsx       # Report message/user modal
│   │   │   │   ├── BlockConfirmDialog.tsx # Block user confirmation
│   │   │   │   ├── ModerationDashboard.tsx # Server owner: reports, signals, bans
│   │   │   │   ├── ReportQueue.tsx        # Pending reports list
│   │   │   │   ├── ReportDetail.tsx       # Single report review + action
│   │   │   │   ├── AbuseSignalList.tsx    # Automated abuse flags
│   │   │   │   ├── BanList.tsx            # Manage server bans
│   │   │   │   ├── AuditLog.tsx           # Moderation action history
│   │   │   │   └── UserCard.tsx           # User info popover (block, mute, report actions)
│   │   │   └── settings/
│   │   │       ├── SettingsPage.tsx
│   │   │       ├── AudioSettings.tsx
│   │   │       ├── VideoSettings.tsx
│   │   │       ├── PrivacySettings.tsx    # Block list, DM policy
│   │   │       └── AccountSettings.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts        # WebSocket connection + events
│   │   │   ├── useWebRTC.ts          # WebRTC connection management
│   │   │   ├── useMediaDevices.ts     # Camera/mic enumeration + selection
│   │   │   ├── useCrypto.ts          # IPC bridge to crypto engine
│   │   │   ├── usePresence.ts        # User presence tracking
│   │   │   ├── useModeration.ts     # Block, mute, report actions
│   │   │   └── useNotifications.ts   # Desktop notification handling
│   │   ├── stores/
│   │   │   ├── authStore.ts          # Auth state, tokens
│   │   │   ├── serverStore.ts        # Servers, channels, members
│   │   │   ├── messageStore.ts       # Decrypted messages (in-memory only)
│   │   │   ├── callStore.ts          # Active call state
│   │   │   ├── presenceStore.ts      # Online/offline/idle status
│   │   │   ├── moderationStore.ts   # Blocks, reports, bans, abuse signals
│   │   │   └── settingsStore.ts      # User preferences
│   │   ├── services/
│   │   │   ├── api.ts                # REST API client (fetch wrapper)
│   │   │   ├── websocket.ts          # WebSocket manager (connect, reconnect, dispatch)
│   │   │   ├── webrtc.ts             # WebRTC manager (PeerConnection lifecycle)
│   │   │   ├── insertable-streams.ts # E2E media encryption via Encoded Transform
│   │   │   └── audio-processor.ts    # Voice activity detection, noise gate
│   │   ├── pages/
│   │   │   ├── LoginPage.tsx
│   │   │   ├── RegisterPage.tsx
│   │   │   ├── ServerPage.tsx        # Main server view (channels + chat)
│   │   │   ├── DmPage.tsx            # DM view
│   │   │   ├── ModerationPage.tsx   # Server moderation dashboard (owner only)
│   │   │   └── SettingsPage.tsx
│   │   ├── types/
│   │   │   ├── api.ts                # API request/response types
│   │   │   ├── ws.ts                 # WebSocket event types
│   │   │   ├── models.ts             # Domain models
│   │   │   ├── crypto.ts             # Crypto-related types
│   │   │   └── moderation.ts         # Report, ban, abuse signal types
│   │   └── utils/
│   │       ├── formatters.ts         # Date, time, file size formatting
│   │       ├── validators.ts         # Input validation
│   │       └── constants.ts          # App-wide constants
│   └── shared/                       # Types shared between main + renderer
│       ├── ipc-channels.ts           # IPC channel name constants
│       └── ipc-types.ts              # IPC message type definitions
├── resources/                         # App icons, platform assets
│   ├── icon.png
│   ├── icon.icns
│   └── icon.ico
└── tests/
    ├── unit/
    │   ├── crypto/                   # Crypto engine unit tests
    │   ├── stores/                   # Store logic tests
    │   └── services/                 # Service layer tests
    ├── integration/
    │   └── ipc.test.ts              # Main↔renderer IPC tests
    └── e2e/
        └── flows/                   # Full user flow tests (Playwright)
```

---

## 4. End-to-End Encryption (Client Implementation)

### 4.1 Key Management

#### Key Hierarchy

```
Master Password (user's login password)
  └─► KDF (Argon2id) ─► Master Key (256-bit)
       └─► HKDF ─► Key Encryption Key (KEK)
            └─► Encrypts:
                 ├── Identity Key (Ed25519 / X25519 long-term keypair)
                 ├── Signed Pre-Key (X25519, rotated weekly)
                 └── One-Time Pre-Keys (X25519, batch of 100)
```

#### Local Key Storage (Main Process)

Private keys are stored in a local SQLite database, encrypted at rest:

1. **Electron `safeStorage`** encrypts the database encryption key using the OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret).
2. **SQLite database** (`~/.mercury/keys.db`) stores encrypted key blobs.
3. On app unlock, the KEK is derived and held in memory for the session duration.

```typescript
// src/main/store/keystore.ts
interface KeyStore {
  // Identity
  getIdentityKeyPair(): Promise<KeyPair>;
  storeIdentityKeyPair(keyPair: KeyPair): Promise<void>;

  // Pre-keys
  getSignedPreKey(): Promise<SignedPreKey>;
  storeSignedPreKey(spk: SignedPreKey): Promise<void>;
  getOneTimePreKey(keyId: number): Promise<PreKey | null>;
  storeOneTimePreKeys(prekeys: PreKey[]): Promise<void>;
  markOneTimePreKeyUsed(keyId: number): Promise<void>;

  // Sessions (Double Ratchet state)
  getSession(userId: string): Promise<SessionState | null>;
  storeSession(userId: string, state: SessionState): Promise<void>;

  // Sender keys (group channels)
  getSenderKey(channelId: string, userId: string): Promise<SenderKey | null>;
  storeSenderKey(channelId: string, userId: string, key: SenderKey): Promise<void>;

  // Media keys
  getMediaKey(roomId: string): Promise<Uint8Array | null>;
  storeMediaKey(roomId: string, key: Uint8Array): Promise<void>;
}
```

### 4.2 Text Message Encryption Flow

#### Sending a Message

```
User types message
        │
        ▼
  Renderer Process                  Main Process (via IPC)
  ─────────────────                 ──────────────────────
  1. Call crypto.encrypt()  ──IPC──► 2. Load session for recipient
                                     3. Double Ratchet encrypt
                                     4. Return ciphertext + header
  5. Receive ciphertext    ◄──IPC── 
  6. Send via WebSocket
     { blob: <ciphertext>,
       ratchet_header: <...>,
       nonce: <...> }
```

#### Receiving a Message

```
  WebSocket receives event
        │
        ▼
  Renderer Process                  Main Process (via IPC)
  ─────────────────                 ──────────────────────
  1. Call crypto.decrypt()  ──IPC──► 2. Load session for sender
                                     3. Double Ratchet decrypt
                                     4. Return plaintext
  5. Receive plaintext     ◄──IPC── 
  6. Store in messageStore
     (in-memory only)
  7. Render in UI
```

#### First Message to New Contact (X3DH)

```
  Renderer Process                  Main Process                Server
  ─────────────────                 ────────────                ──────
  1. Initiate DM           ──IPC──► 2. Fetch recipient's       ──API──►
                                       key bundle
                            ◄──API── 3. Receive key bundle
                                     4. X3DH key agreement
                                     5. Initialize Double Ratchet
                                     6. Encrypt first message
  7. Receive ciphertext    ◄──IPC──
  8. Send via WebSocket ──────────────────────────────────────────►
```

### 4.3 Channel (Group) Encryption

Uses Sender Keys for efficiency (one encryption per message regardless of group size):

1. When joining a channel, generate a `SenderKey` (symmetric + chain key).
2. Distribute the SenderKey to all current members encrypted with pairwise sessions.
3. Messages are encrypted with the sender's SenderKey chain (AES-256-GCM).
4. On member leave/kick: all remaining members rotate their SenderKeys.
5. On member join: existing members share current SenderKeys with new member.

### 4.4 Media E2E Encryption

#### Insertable Streams (Encoded Transform)

WebRTC's `RTCRtpSender.createEncodedStreams()` / `RTCRtpReceiver.createEncodedStreams()` allow intercepting encoded frames before they're packetized:

```typescript
// src/renderer/services/insertable-streams.ts

interface MediaEncryptor {
  // Called when joining a call
  initialize(roomId: string): Promise<void>;

  // Apply to outgoing tracks
  encryptSender(sender: RTCRtpSender): void;

  // Apply to incoming tracks
  decryptReceiver(receiver: RTCRtpReceiver): void;

  // Key rotation (on participant change)
  rotateKey(newKey: Uint8Array): void;

  // Cleanup
  destroy(): void;
}

// Implementation sketch:
function setupSenderTransform(sender: RTCRtpSender, key: CryptoKey) {
  const senderStreams = sender.createEncodedStreams();
  const transformStream = new TransformStream({
    transform(frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame, controller) {
      // 1. Read frame data
      const data = new Uint8Array(frame.data);
      // 2. Generate IV (frame counter + SSRC)
      const iv = generateFrameIV(frame);
      // 3. Encrypt with AES-GCM using shared room key
      const encrypted = aesGcmEncrypt(key, iv, data);
      // 4. Replace frame data
      frame.data = encrypted.buffer;
      controller.enqueue(frame);
    }
  });
  senderStreams.readable
    .pipeThrough(transformStream)
    .pipeTo(senderStreams.writable);
}
```

#### Key Distribution for Calls

1. Call initiator generates a random 256-bit symmetric key.
2. Key is distributed to each participant via their existing encrypted DM/channel session.
3. When a participant joins or leaves, a new key is generated and distributed.
4. Old keys are retained briefly (2 seconds) for in-flight frame decryption during rotation.

---

## 5. WebSocket Manager

### 5.1 Connection Lifecycle

```
DISCONNECTED ──connect()──► CONNECTING ──identify──► CONNECTED
     ▲                          │                       │
     │                          │ (timeout/error)       │ (close/error)
     │                          ▼                       ▼
     └──────────────────── RECONNECTING ◄───────────────┘
                               │
                    (exponential backoff)
                               │
                               ▼
                          CONNECTING (resume)
```

### 5.2 Reconnection Strategy

```typescript
// src/renderer/services/websocket.ts

const RECONNECT_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.3,        // ±30% random jitter
  maxAttempts: Infinity,     // Never stop trying
};
```

On reconnection:
1. Attempt `resume` with last known `session_id` and `seq` number.
2. Server replays missed events since last `seq`.
3. If resume fails (session expired), do full `identify` and re-sync state.

### 5.3 Event Dispatch

```typescript
// Typed event system
type WSEventMap = {
  MESSAGE_CREATE: MessageCreateEvent;
  TYPING_START: TypingStartEvent;
  PRESENCE_UPDATE: PresenceUpdateEvent;
  VOICE_STATE_UPDATE: VoiceStateUpdateEvent;
  CALL_STARTED: CallStartedEvent;
  WEBRTC_SIGNAL: WebRTCSignalEvent;
  // ...
};

class WebSocketManager {
  private listeners = new Map<string, Set<Function>>();

  on<K extends keyof WSEventMap>(event: K, cb: (data: WSEventMap[K]) => void): () => void;
  emit<K extends keyof WSEventMap>(event: K, data: WSEventMap[K]): void;
  send(op: string, data: unknown): void;
}
```

---

## 6. WebRTC Manager

### 6.1 Connection Flow (SFU Model)

Each participant maintains **one PeerConnection** to the SFU:

```
Client A                         SFU                        Client B
   │                              │                            │
   │── createOffer() ────────────►│                            │
   │   (audio + video tracks)     │                            │
   │◄── answer (SDP) ────────────│                            │
   │                              │                            │
   │── ICE candidates ──────────►│◄── ICE candidates ─────────│
   │◄── ICE candidates ──────────│──── ICE candidates ────────►│
   │                              │                            │
   │══ Media flowing (SRTP) ═════╪════ Media flowing (SRTP) ══│
   │   (E2E encrypted frames)    │    (E2E encrypted frames)  │
```

### 6.2 Track Management

```typescript
// src/renderer/services/webrtc.ts

interface WebRTCManager {
  // Lifecycle
  joinCall(roomId: string, channelId: string): Promise<void>;
  leaveCall(): Promise<void>;

  // Local tracks
  enableMicrophone(deviceId?: string): Promise<void>;
  disableMicrophone(): void;
  enableCamera(deviceId?: string): Promise<void>;
  disableCamera(): void;

  // Remote tracks (events)
  onRemoteTrack: (callback: (userId: string, track: MediaStreamTrack) => void) => void;
  onRemoteTrackRemoved: (callback: (userId: string, trackId: string) => void) => void;

  // Quality
  setPreferredVideoQuality(quality: 'high' | 'medium' | 'low'): void;

  // Stats
  getConnectionStats(): Promise<RTCStatsReport>;
}
```

### 6.3 Adapting to Server Quality Limits

On call join, the server sends its media configuration constraints:

```json
{
  "op": "CALL_CONFIG",
  "d": {
    "audio": { "max_bitrate_kbps": 128 },
    "video": {
      "max_bitrate_kbps": 2500,
      "max_resolution_height": 1080,
      "max_framerate": 30,
      "simulcast_enabled": true,
      "simulcast_layers": [
        { "rid": "high", "max_bitrate_kbps": 2500, "scale_down": 1.0 },
        { "rid": "medium", "max_bitrate_kbps": 500, "scale_down": 2.0 },
        { "rid": "low", "max_bitrate_kbps": 150, "scale_down": 4.0 }
      ]
    }
  }
}
```

The client:
1. Applies `getUserMedia` constraints based on server max values.
2. Configures simulcast layers on the `RTCRtpSender` to match server config.
3. Sets `maxBitrate` on each encoding via `sender.setParameters()`.
4. Respects server-directed quality changes (e.g., "switch to medium layer") received via signaling.

---

## 7. UI Design

### 7.1 Layout

```
┌────┬─────────────┬──────────────────────────────────┬────────────┐
│    │  # general   │  Message Area                     │ Members    │
│ S  │  # dev       │  ┌─────────────────────────────┐  │            │
│ e  │  # random    │  │  [Avatar] User1  12:34 PM   │  │ ● User1   │
│ r  │              │  │  Hello everyone!             │  │ ● User2   │
│ v  │  VOICE       │  │                             │  │ ○ User3   │
│ e  │  🔊 General  │  │  [Avatar] User2  12:35 PM   │  │           │
│ r  │    ● User1   │  │  Hey! How's it going?       │  │           │
│    │    ● User2   │  │                             │  │           │
│ L  │              │  │                             │  │           │
│ i  │              │  │                             │  │           │
│ s  │              │  └─────────────────────────────┘  │           │
│ t  │              │  ┌─────────────────────────────┐  │           │
│    │              │  │  📝 Message #general         │  │           │
│    │              │  └─────────────────────────────┘  │           │
├────┴──────────────┴──────────────────────────────────┴───────────┤
│ [🎤 Mute] [🔇 Deafen] [⚙️ Settings]                  User#1234 │
└──────────────────────────────────────────────────────────────────┘
```

### 7.2 Key Views

| View | Route | Description |
|------|-------|-------------|
| Login / Register | `/auth` | Authentication screens |
| Server view | `/servers/:serverId/:channelId` | Main view with channel list, messages, members |
| DM view | `/dm/:dmChannelId` | Direct message conversation |
| Video call (expanded) | `/call/:roomId` | Full-screen video grid |
| Settings | `/settings/:section` | User and app preferences |
| Moderation | `/servers/:serverId/moderation` | Reports, bans, abuse signals, audit log (owner only) |

### 7.3 Component Design Decisions

- **Virtualized message list:** Use `react-virtuoso` for efficient rendering of long message histories. Only render visible messages + buffer.
- **Custom title bar:** Frameless Electron window with custom title bar for consistent cross-platform appearance. Drag region, minimize/maximize/close buttons.
- **Theme:** Dark theme by default (standard for communication apps). Light theme as option. Theme tokens via CSS custom properties for easy customization.
- **Responsive panels:** Channel list and member list can be collapsed on smaller screens. Minimum window size: 940×500.
- **Context menus:** Right-click context menus on messages (copy, reply), users (DM, profile), channels (mute, edit).
- **Keyboard shortcuts:** Ctrl+K search, Ctrl+Shift+M mute toggle, Escape to close modals.

### 7.4 Audio/Video UI States

| State | UI Behavior |
|-------|-------------|
| Voice connected, no video | Voice panel in bottom of channel list. Participant names + speaking indicators (green border). |
| Video call (≤4 participants) | 2×2 grid of equal video tiles. |
| Video call (5–9 participants) | Active speaker large + filmstrip of others. |
| Video call (10+ participants) | Active speaker large + paginated grid below. |
| Screen sharing (future) | Screen share is primary large view + participant tiles strip. |

---

## 8. Local Data Management

### 8.1 What's Stored Locally

| Data | Storage | Encrypted | Persistence |
|------|---------|-----------|-------------|
| Private keys (identity, pre-keys) | SQLite (`keys.db`) | Yes (safeStorage) | Permanent |
| Session/ratchet state | SQLite (`sessions.db`) | Yes (safeStorage) | Permanent |
| Auth tokens (JWT, refresh) | Electron safeStorage | Yes (OS-level) | Until logout |
| Decrypted messages | In-memory (Zustand) | N/A (RAM only) | Session only |
| User preferences | `electron-store` (JSON) | No (non-sensitive) | Permanent |
| App cache (avatars, etc.) | Electron cache dir | No | Clearable |

### 8.2 Security Constraints

- **No plaintext messages on disk.** Decrypted messages exist only in renderer memory. When the app closes, they're gone. Message history is re-fetched and re-decrypted on next launch.
- **Key material isolation.** All private keys in the main process only, accessed via IPC.
- **Screen capture protection.** Set `setContentProtection(true)` on BrowserWindow to prevent screen capture by other apps (OS-level, best-effort).

---

## 9. IPC API Surface

The preload script exposes a strictly typed API to the renderer:

```typescript
// src/preload/api.ts

export interface MercuryAPI {
  // Crypto
  crypto: {
    generateIdentityKeyPair(): Promise<{ publicKey: string }>;
    generatePreKeys(count: number): Promise<{ publicKeys: PublicPreKey[] }>;
    encryptMessage(recipientId: string, plaintext: string): Promise<EncryptedEnvelope>;
    decryptMessage(senderId: string, envelope: EncryptedEnvelope): Promise<string>;
    encryptGroupMessage(channelId: string, plaintext: string): Promise<EncryptedGroupEnvelope>;
    decryptGroupMessage(channelId: string, senderId: string, envelope: EncryptedGroupEnvelope): Promise<string>;
    generateMediaKey(): Promise<{ key: string }>;
    getMediaKey(roomId: string): Promise<string | null>;
    storeMediaKey(roomId: string, key: string): Promise<void>;
    initializeSession(userId: string, keyBundle: PublicKeyBundle): Promise<void>;
    hasSesssion(userId: string): Promise<boolean>;
  };

  // Key store
  keystore: {
    getPublicIdentityKey(): Promise<string>;
    getPublicKeyBundle(): Promise<PublicKeyBundle>;
    hasIdentityKey(): Promise<boolean>;
  };

  // App
  app: {
    getVersion(): string;
    getPlatform(): string;
    minimize(): void;
    maximize(): void;
    close(): void;
    setContentProtection(enabled: boolean): void;
  };

  // Notifications
  notifications: {
    show(title: string, body: string, onClick?: () => void): void;
  };

  // Safe storage (for auth tokens)
  safeStorage: {
    store(key: string, value: string): Promise<void>;
    retrieve(key: string): Promise<string | null>;
    remove(key: string): Promise<void>;
  };

  // Moderation (report evidence encryption)
  moderation: {
    // Encrypt decrypted message content to the server operator's moderation public key
    // so only the operator can read it. Used when submitting reports with evidence.
    encryptEvidence(
      plaintext: string,
      operatorModerationPubKey: string  // base64, fetched from server config
    ): Promise<string>;  // base64 encrypted blob
  };
}

// Exposed on window.mercuryAPI
```

---

## 10. State Management

### 10.1 Store Architecture (Zustand)

```typescript
// Each store is independent, subscribable, and supports selectors

// authStore — login state, current user
interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  login(email: string, password: string): Promise<void>;
  register(username: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refreshToken(): Promise<void>;
}

// serverStore — servers, channels, members
interface ServerState {
  servers: Map<string, Server>;
  channels: Map<string, Channel>;        // channelId → Channel
  members: Map<string, ServerMember[]>;   // serverId → members
  activeServerId: string | null;
  activeChannelId: string | null;
  fetchServers(): Promise<void>;
  fetchChannels(serverId: string): Promise<void>;
  createServer(name: string): Promise<Server>;
  joinServer(inviteCode: string): Promise<void>;
}

// messageStore — decrypted messages (in-memory only)
interface MessageState {
  messages: Map<string, Message[]>;       // channelId → messages (decrypted)
  sendMessage(channelId: string, content: string): Promise<void>;
  receiveMessage(event: MessageCreateEvent): Promise<void>;
  fetchHistory(channelId: string, before?: string): Promise<void>;
}

// callStore — active call state
interface CallState {
  activeCall: ActiveCall | null;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;  // userId → stream
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  joinCall(channelId: string): Promise<void>;
  leaveCall(): Promise<void>;
  toggleMute(): void;
  toggleDeafen(): void;
  toggleCamera(): void;
}

// presenceStore — user online status
interface PresenceState {
  presences: Map<string, UserPresence>;    // userId → presence
  updatePresence(userId: string, status: string): void;
}

// moderationStore — moderation state (server owners + user self-service)
interface ModerationState {
  // User-level
  blockedUserIds: Set<string>;
  dmPolicy: 'anyone' | 'mutual_servers' | 'nobody';
  blockUser(userId: string): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  setDmPolicy(policy: 'anyone' | 'mutual_servers' | 'nobody'): Promise<void>;

  // Reporting
  submitReport(report: {
    reportedUserId: string;
    messageId?: string;
    channelId?: string;
    category: 'spam' | 'harassment' | 'illegal' | 'csam' | 'other';
    description: string;
    includeEvidence: boolean;     // If true, decrypt + re-encrypt to operator key
  }): Promise<void>;

  // Server moderation (owner only)
  reports: Map<string, Report>;           // reportId → Report
  abuseSignals: AbuseSignal[];
  bans: Map<string, Ban>;                // serverId:userId → Ban
  auditLog: AuditLogEntry[];
  fetchReports(serverId: string): Promise<void>;
  reviewReport(reportId: string, action: string): Promise<void>;
  banUser(serverId: string, userId: string, reason: string, expiresAt?: Date): Promise<void>;
  unbanUser(serverId: string, userId: string): Promise<void>;
  kickUser(serverId: string, userId: string, reason: string): Promise<void>;
  muteInChannel(channelId: string, userId: string, duration?: number): Promise<void>;
  fetchAuditLog(serverId: string): Promise<void>;
}
```

---

## 11. Build & Distribution

### 11.1 Build Configuration

```yaml
# electron-builder.config.yml
appId: "com.mercury.app"
productName: "Mercury"
directories:
  output: dist
  buildResources: resources

mac:
  target:
    - target: dmg
      arch: [x64, arm64]
    - target: zip
      arch: [x64, arm64]
  category: public.app-category.social-networking
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist

win:
  target:
    - target: nsis
      arch: [x64, arm64]
    - target: portable
  sign: true

linux:
  target:
    - target: AppImage
      arch: [x64, arm64]
    - target: deb
    - target: rpm
  category: Network

publish:
  provider: generic
  url: "https://updates.your-server.com"
```

### 11.2 Entitlements (macOS)

```xml
<!-- build/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
</dict>
</plist>
```

### 11.3 Content Security Policy

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  connect-src wss://* https://*;
  media-src blob: mediastream:;
  img-src 'self' data: https://*;
">
```

---

## 12. Performance Targets

| Metric | Target |
|--------|--------|
| App launch to usable | < 3 seconds |
| Message send latency (type → delivered) | < 200ms (excluding network) |
| Message decrypt time | < 5ms per message |
| Voice join-to-speaking | < 2 seconds |
| Video frame render latency | < 100ms (E2E) |
| Memory usage (idle, 5 servers) | < 300 MB |
| Memory usage (active video call, 4 participants) | < 600 MB |
| CPU idle (no call, messages flowing) | < 5% |
| Bundle size (unpacked) | < 200 MB |

---

## 13. Testing Strategy

| Layer | Approach | Tools |
|-------|----------|-------|
| Unit | Crypto functions, store logic, utilities | Vitest |
| Component | UI component rendering + interaction | Vitest + React Testing Library |
| Integration | IPC round-trips, WebSocket mock flows | Vitest + custom mocks |
| E2E | Full user flows (login → send message → call) | Playwright + Electron |
| Crypto verification | Known-answer tests against Signal Protocol test vectors | Vitest |
| Performance | Message list scroll performance, memory profiling | Chrome DevTools, Electron profiler |
| Security | CSP validation, IPC surface audit, key isolation check | Manual + automated |

---

## 14. Accessibility

- **Keyboard navigation:** All interactive elements reachable via Tab. Focus rings visible.
- **Screen reader support:** ARIA labels on all controls. Live regions for new messages and call state changes.
- **Reduced motion:** Respect `prefers-reduced-motion`. Disable animations when set.
- **High contrast:** Theme variables support high-contrast mode.
- **Font scaling:** UI respects system font size settings up to 150%.

---

## 15. Future Considerations

These are **not in MVP** but the architecture should accommodate:

- **Message franking (v2):** Extend the encryption envelope to include a franking tag (HMAC commitment to plaintext). When a user reports a message, the franking tag + key are included so the server can cryptographically verify the report is authentic. Requires changes to `double-ratchet.ts` and `sender-keys.ts` to produce the franking commitment alongside the ciphertext.
- **Moderator role UI (v2):** When the server supports designated moderator roles, the client needs scoped moderation UI — moderators see the report queue and can act within their permissions, but don't see the full admin dashboard.
- **Multi-device sync:** Each device has its own identity key. Messages encrypted per-device. Session management across devices via a linked-devices protocol.
- **Mobile apps:** Consider extracting the crypto engine into a shared Rust library (compiled via wasm-pack for Electron, native for mobile) to avoid reimplementing Signal Protocol.
- **Plugin system:** Sandboxed renderer-side plugins for custom themes, bots, integrations.
- **Offline message queue:** Queue encrypted messages locally when disconnected; send on reconnect.
- **Rich embeds/markdown:** Render markdown in messages, URL preview embeds (fetched client-side to preserve privacy).
- **Voice processing:** Echo cancellation, noise suppression, auto-gain via Web Audio API or RNNoise WASM module.
