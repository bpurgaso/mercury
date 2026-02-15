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

- **Client-side encryption where it matters:** DMs and private channels are fully E2E encrypted — all crypto happens locally, private keys never leave the device. Standard community channels use server-side encryption for full history and searchability. The encryption mode is visually clear to users at all times.
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
| Account recovery via recovery key | **MVP** |
| Per-device identity keys (single device MVP) | **MVP** |
| Tiered channel encryption (standard / private E2E / DM E2E) | **MVP** |
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
| WebSocket serialization | **@msgpack/msgpack** (message payloads) + **JSON** (control plane) | MessagePack for binary message payloads (~30% smaller than JSON+base64); JSON for human-readable control plane |
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
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Main Process                             │  │
│  │                                                            │  │
│  │  ┌──────────┐  ┌───────────────────────────────────────┐   │  │
│  │  │ App      │  │ IPC Router                            │   │  │
│  │  │ Lifecycle│  │                                       │   │  │
│  │  │          │  │ Renderer ←→ Main ←→ Crypto Worker     │   │  │
│  │  │ • Tray   │  │ (thin pass-through, no crypto here)   │   │  │
│  │  │ • Window │  │                                       │   │  │
│  │  │ • Update │  └──────────────────┬────────────────────┘   │  │
│  │  └──────────┘                     │                        │  │
│  │                          Worker Thread                     │  │
│  │                    ┌──────▼──────────────────────────┐     │  │
│  │                    │ Crypto Worker (Worker Thread)    │     │  │
│  │                    │                                  │     │  │
│  │                    │  ┌───────────┐ ┌─────────────┐  │     │  │
│  │                    │  │ Crypto    │ │ Key Store   │  │     │  │
│  │                    │  │ Engine    │ │ (SQLite +   │  │     │  │
│  │                    │  │           │ │  safeStorage│  │     │  │
│  │                    │  │ • Encrypt │ │  proxy)     │  │     │  │
│  │                    │  │ • Decrypt │ │             │  │     │  │
│  │                    │  │ • X3DH    │ │ • Keys      │  │     │  │
│  │                    │  │ • Ratchet │ │ • Sessions  │  │     │  │
│  │                    │  │ • Sender  │ │ • Ratchets  │  │     │  │
│  │                    │  │   Keys    │ │ • Backups   │  │     │  │
│  │                    │  └───────────┘ └─────────────┘  │     │  │
│  │                    └─────────────────────────────────┘     │  │
│  └────────────────────────────┬───────────────────────────────┘  │
│                       IPC (contextBridge)                         │
│  ┌────────────────────────────▼───────────────────────────────┐  │
│  │                   Renderer Process                          │  │
│  │                                                            │  │
│  │  ┌───────────┐ ┌───────────┐ ┌──────────────────┐         │  │
│  │  │ React UI  │ │ WebSocket │ │ WebRTC Manager   │         │  │
│  │  │           │ │ Manager   │ │                  │         │  │
│  │  │ • Servers │ │           │ │ • PeerConnection │         │  │
│  │  │ • Channels│ │ • Connect │ │ • Insertable     │         │  │
│  │  │ • Chat    │ │ • Events  │ │   Streams (E2E)  │         │  │
│  │  │ • Calls   │ │ • Reconnect│ │ • getUserMedia  │         │  │
│  │  │ • DMs     │ │ • Queue   │ │ • Track mgmt    │         │  │
│  │  │ • Settings│ │           │ │ • Quality adapt  │         │  │
│  │  └───────────┘ └───────────┘ └──────────────────┘         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
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
| **Main** | App lifecycle, IPC routing, safeStorage access, window management | Full Node.js, file system, OS APIs |
| **Crypto Worker** | All crypto operations, key storage (SQLite), session management | Node.js Worker Thread — separate event loop, no UI blocking |
| **Renderer** | React UI, WebSocket, WebRTC, user interaction | Sandboxed, no Node.js, only exposed IPC APIs |
| **Preload** | contextBridge — exposes safe API surface to renderer | Limited: only whitelisted IPC methods |

**Critical rules:**
- Private keys NEVER enter the renderer process. All crypto operations go through the crypto worker.
- The **Main process is a thin IPC router** — it does NOT perform crypto operations directly. This prevents heavy crypto work (e.g., lazy Sender Key rotation on first message after a member removal — up to 99 pairwise encryptions + SQLite writes) from blocking IPC handling, window dragging, or typing indicators.
- The crypto worker communicates with the Main process via `worker_threads` `MessagePort`. The Main process proxies `safeStorage` calls to the worker since `safeStorage` is only available on the main thread.

#### IPC Architecture: Direct MessagePort Channel

The naive approach — routing all crypto IPC through Main (`Renderer → Main → Worker → Main → Renderer`) — forces V8 Structured Clone serialization at each hop. For large binary payloads (message history, ciphertext arrays), this blocks the Main thread during memory copying, causing UI stutter.

**Solution:** The Main process creates a `MessageChannel` at startup and transfers one `MessagePort` to the Renderer (via `contextBridge`) and the other to the Crypto Worker. The hot path (ciphertext, decrypted content) flows **directly** between Worker and Renderer with zero-copy `ArrayBuffer` transfer semantics. The Main process only handles setup and `safeStorage` proxying.

```
                    ┌──────────────────────┐
                    │    Main Process       │
                    │                       │
                    │  • App lifecycle      │
                    │  • safeStorage proxy  │
                    │  • MessageChannel     │
                    │    factory (setup)    │
                    └──┬───────────────┬────┘
          safeStorage  │               │  safeStorage
          proxy only   │               │  proxy only
                    ┌──▼──┐         ┌──▼──────────┐
                    │Crypto│◄══════►│  Renderer    │
                    │Worker│ Direct │  (React UI)  │
                    │      │ Message│              │
                    │      │ Port   │              │
                    └──────┘ (zero- └──────────────┘
                             copy)
```

```typescript
// src/main/crypto-worker.ts (spawned at app launch)
import { Worker } from 'worker_threads';
import { MessageChannelMain } from 'electron';

const cryptoWorker = new Worker(
  path.join(__dirname, 'workers/crypto-worker-entry.ts'),
  { workerData: { dbPath: '~/.mercury/keys.db' } }
);

// Create a direct channel between Worker and Renderer
const { port1: workerPort, port2: rendererPort } = new MessageChannelMain();

// Transfer ports to their respective processes
cryptoWorker.postMessage({ op: 'init:port', port: workerPort }, [workerPort]);
mainWindow.webContents.postMessage('crypto:port', null, [rendererPort]);

// Main process ONLY handles safeStorage proxying (not crypto data)
cryptoWorker.on('message', (msg) => {
  if (msg.op === 'safeStorage:encrypt') {
    const encrypted = safeStorage.encryptString(msg.data);
    cryptoWorker.postMessage({ op: 'safeStorage:result', id: msg.id, data: encrypted });
  }
});
```

```typescript
// In Renderer: receive the direct port and use zero-copy transfers
ipcRenderer.on('crypto:port', (event) => {
  const [port] = event.ports;
  // Hot path: ciphertext and decrypted content flow directly
  // Use transferable ArrayBuffers to avoid copying: postMessage(data, [data.buffer])
  port.postMessage({ op: 'encrypt', plaintext: buffer }, [buffer]);
  port.onmessage = (e) => { /* receive ciphertext with zero copy */ };
});
```

### 3.3 Project Structure

```
src/client/                            # Electron frontend (within mercury/ monorepo)
├── package.json
├── electron.vite.config.ts
├── electron-builder.config.yml
├── tsconfig.json
├── src/
│   ├── main/                          # Electron main process (thin IPC router)
│   │   ├── index.ts                   # App entry point, window management
│   │   ├── ipc/
│   │   │   ├── handlers.ts            # IPC handler registration
│   │   │   └── router.ts             # Routes renderer IPC → crypto worker
│   │   ├── safe-storage.ts           # safeStorage proxy (main thread only)
│   │   ├── updater.ts                 # Auto-update logic
│   │   └── tray.ts                    # System tray management
│   ├── worker/                        # Crypto Worker Thread (separate event loop)
│   │   ├── crypto-worker-entry.ts     # Worker thread entry point
│   │   ├── message-handler.ts         # Dispatch incoming messages to crypto ops
│   │   ├── crypto/
│   │   │   ├── engine.ts              # Crypto engine orchestrator
│   │   │   ├── x3dh.ts               # X3DH key agreement (per-device)
│   │   │   ├── double-ratchet.ts      # Double Ratchet implementation
│   │   │   ├── sender-keys.ts         # Group/channel sender keys (≤100 members)
│   │   │   ├── media-keys.ts          # Media E2E frame encryption keys
│   │   │   ├── report-crypto.ts       # Encrypt report evidence to operator moderation key
│   │   │   ├── recovery.ts            # Recovery key generation, backup encrypt/decrypt
│   │   │   ├── device-list.ts         # Signed device list creation & verification
│   │   │   └── utils.ts              # Key serialization, random bytes
│   │   └── store/
│   │       ├── keystore.ts            # SQLite-encrypted key persistence
│   │       ├── safe-storage-proxy.ts  # Proxies safeStorage calls to main thread via MessagePort
│   │       ├── sessions.db.ts         # SQLite session/ratchet state
│   │       ├── messages.db.ts         # SQLite-encrypted E2E message plaintext storage
│   │       └── migrations/            # SQLite schema migrations
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
│   │   │   │   ├── CallOverlay.tsx    # Incoming/outgoing call overlay
│   │   │   │   └── ConnectivityDiag.tsx # ICE diagnostic panel (STUN/TURN status)
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
│   │   │   │   ├── ModerationDashboard.tsx # Owner/moderator: reports, signals, bans
│   │   │   │   ├── ReportQueue.tsx        # Pending reports list
│   │   │   │   ├── ReportDetail.tsx       # Single report review + action + framing warning
│   │   │   │   ├── UnverifiedReportBanner.tsx # "⚠️ Cannot be cryptographically verified" warning
│   │   │   │   ├── MetadataCorroboration.tsx  # Accused user's metadata context panel
│   │   │   │   ├── AbuseSignalList.tsx    # Automated abuse flags
│   │   │   │   ├── BanList.tsx            # Manage server bans
│   │   │   │   ├── AuditLog.tsx           # Moderation action history
│   │   │   │   └── UserCard.tsx           # User info popover (block, mute, report actions)
│   │   │   ├── channel/
│   │   │   │   ├── ChannelCreateModal.tsx  # Channel creation with encryption mode choice
│   │   │   │   ├── EncryptionBadge.tsx    # 🔒/🛡️ icon with tooltip per encryption mode
│   │   │   │   └── E2EJoinNotice.tsx      # "Messages before you joined are not visible"
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
│   │   │   ├── messageStore.ts       # Message cache: E2E from local SQLite, standard from server
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
│   │   │   ├── RecoveryPage.tsx      # Account recovery (enter recovery key)
│   │   │   ├── RecoveryKeyDisplay.tsx # Show recovery key on registration (must-save)
│   │   │   ├── SafetyNumberPage.tsx  # Verify contact identity (safety numbers)
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
    │   ├── crypto/                   # Crypto engine unit tests (runs in worker context)
    │   ├── stores/                   # Store logic tests
    │   └── services/                 # Service layer tests
    ├── integration/
    │   ├── ipc.test.ts              # Renderer → Main → Worker IPC round-trip tests
    │   └── worker.test.ts           # Crypto worker lifecycle & message handling
    └── e2e/
        └── flows/                   # Full user flow tests (Playwright)
```

---

## 4. End-to-End Encryption (Client Implementation)

### 4.1 Key Hierarchy & Identity Model

```
Recovery Key (256-bit, user-held, offline backup)
  └─► HKDF(salt, "mercury-backup-v1") ─► Backup Encryption Key
       └─► Encrypts full key backup blob (uploaded to server)

Master Verify Key (Ed25519 signing keypair, per-user)
  └─► Signs Device Lists (authorizes which devices belong to this user)

Per-Device:
  OS Keychain (via Electron safeStorage)
    └─► Database Encryption Key
         └─► Encrypts local SQLite key store (~/.mercury/keys.db):
              ├── Master Verify Key (private half)
              ├── Device Identity Key (X25519 keypair)
              ├── Signed Pre-Key (X25519, rotated weekly)
              ├── One-Time Pre-Keys (X25519, batch of 100)
              ├── Double Ratchet session states (per recipient device)
              ├── Sender Keys (for private channels ≤100 members)
```

### 4.2 Key Generation & Registration Flow

On first registration:

1. Client generates **Master Verify Key** (Ed25519 keypair). This is the root of user identity.
2. Client generates **Device Identity Key** (X25519 keypair) for this device.
3. Client generates **Signed Pre-Key** (X25519) and signs it with the Device Identity Key.
4. Client generates 100 **One-Time Pre-Keys** (X25519).
5. Client creates a **signed device list** containing this device's ID + identity key, signed by the Master Verify Key.
6. Client generates a **Recovery Key** (256-bit random, displayed as 24-word mnemonic).
7. Client encrypts a backup blob (master verify key + device identity key) with the recovery key.
8. Client uploads to server: device key bundle, signed device list, encrypted backup blob.
9. User is prompted to save the recovery key. **Registration cannot complete until the user confirms they've stored it.**

### 4.3 Local Key Storage (Crypto Worker Thread)

Private keys are stored in a local SQLite database, encrypted at rest:

1. **Electron `safeStorage`** encrypts the database encryption key using the OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret).
2. **SQLite database** (`~/.mercury/keys.db`) stores encrypted key blobs.
3. On app launch, the database is decrypted and keys are held in memory for the session.

#### Linux safeStorage Fallback

On Linux, `safeStorage` depends on `libsecret` (GNOME Keyring) or KWallet. On minimal window managers, headless setups, or if the keyring daemon is not running, `safeStorage.isEncryptionAvailable()` returns `false`. Mercury **must not fail open** (silently storing the encryption key in plaintext).

**AppImage caveat:** AppImage's sandbox isolation can prevent Electron from detecting or connecting to the host system's `libsecret` daemon even when GNOME Keyring is running perfectly. This causes false `safeStorage` failures. The **Flatpak** build target avoids this entirely — Flatpak's portal system (`org.freedesktop.secrets`) handles secure keystore access reliably across distros.

**Password store detection:** Before falling back to a manual password prompt, attempt to force the correct keychain backend:

```typescript
// src/main/safe-storage.ts — run BEFORE app.whenReady()
import { app } from 'electron';

function configureLinuxKeychain(): void {
  if (process.platform !== 'linux') return;

  const desktop = process.env.XDG_CURRENT_DESKTOP?.toLowerCase() || '';
  if (desktop.includes('gnome') || desktop.includes('unity') || desktop.includes('cinnamon')) {
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
  } else if (desktop.includes('kde') || desktop.includes('plasma')) {
    app.commandLine.appendSwitch('password-store', 'kwallet5');
  }
  // If neither detected, Electron will try its default detection
}
configureLinuxKeychain();
```

**Fallback behavior (if keychain is genuinely unavailable):**

```typescript
async function getDatabaseEncryptionKey(): Promise<Buffer> {
  if (safeStorage.isEncryptionAvailable()) {
    // Happy path: OS keychain available (or forced via --password-store)
    return safeStorage.decryptString(storedEncryptedKey);
  }

  // Linux fallback: prompt user for a local app password
  // This password is NOT their Mercury account password
  const password = await showLocalPasswordPrompt(
    'Your system keychain is unavailable. Enter a local app password to protect your encryption keys.'
  );

  // Derive the database encryption key from the app password
  // Uses Argon2id with a persistent salt stored alongside the database
  const salt = await getOrCreateLocalSalt('~/.mercury/local.salt');
  return argon2id(password, salt, { memory: 65536, iterations: 3, hashLength: 32 });
}
```

**UX flow:**
- First launch on affected Linux systems: explain why a password is needed ("Your system doesn't provide a secure keychain..."), prompt for a local app password, store the Argon2id salt.
- Subsequent launches: prompt for the app password before the app unlocks.
- If the user later installs a keyring daemon, Mercury can detect `safeStorage` availability and offer to migrate.

```typescript
// src/worker/store/keystore.ts
interface KeyStore {
  // Master identity
  getMasterVerifyKeyPair(): Promise<SigningKeyPair>;
  storeMasterVerifyKeyPair(keyPair: SigningKeyPair): Promise<void>;

  // Device identity
  getDeviceId(): Promise<string>;
  getDeviceIdentityKeyPair(): Promise<KeyPair>;
  storeDeviceIdentityKeyPair(deviceId: string, keyPair: KeyPair): Promise<void>;

  // Pre-keys
  getSignedPreKey(): Promise<SignedPreKey>;
  storeSignedPreKey(spk: SignedPreKey): Promise<void>;
  getOneTimePreKey(keyId: number): Promise<PreKey | null>;
  storeOneTimePreKeys(prekeys: PreKey[]): Promise<void>;
  markOneTimePreKeyUsed(keyId: number): Promise<void>;

  // Sessions — keyed by (userId, deviceId) pair, NOT just userId
  getSession(userId: string, deviceId: string): Promise<SessionState | null>;
  storeSession(userId: string, deviceId: string, state: SessionState): Promise<void>;
  getAllSessionsForUser(userId: string): Promise<Map<string, SessionState>>;

  // Sender keys (group channels ≤100 members)
  getSenderKey(channelId: string, userId: string, deviceId: string): Promise<SenderKey | null>;
  storeSenderKey(channelId: string, userId: string, deviceId: string, key: SenderKey): Promise<void>;


  // Media keys
  getMediaKey(roomId: string): Promise<Uint8Array | null>;
  storeMediaKey(roomId: string, key: Uint8Array): Promise<void>;

  // Backup
  exportBackupBlob(): Promise<Uint8Array>;       // Serialize all restorable state
  importBackupBlob(blob: Uint8Array): Promise<void>;  // Restore from backup
}
```

### 4.4 Account Recovery Flow

#### Recovery Key Format

The recovery key is 256 bits of entropy encoded as a **24-word BIP39 mnemonic** (e.g., "abandon ability able about above absent absorb ..."). This is familiar to cryptocurrency users and easy to write down.

#### Backup & Restore

**Automatic backup** — the client uploads an updated encrypted backup to the server whenever significant crypto state changes (new session, sender key rotation, MLS epoch advance). Debounced to max once per 5 minutes.

```
Recovery Key (24 words → 256-bit entropy)
    │
    ├─ HKDF(server-stored salt, "mercury-backup-v1") ──► AES-256-GCM key
    │
    └─ Encrypt({
         masterVerifyKey,        // private half
         deviceIdentityKey,      // private half
         sessions,               // all Double Ratchet states
         senderKeys              // all private channel sender keys
       }) ──► encrypted_backup
    
    Upload encrypted_backup + salt to server (PUT /users/me/key-backup)
```

**Recovery flow** (device lost, fresh install):

```
  Fresh Client                     Server
  ────────────                     ──────
  1. Login (username + password) ──►  (auth is independent of E2E keys)
  2. No local keys detected
  3. Prompt: "Enter recovery key"
  4. Fetch encrypted backup     ◄── GET /users/me/key-backup
  5. Derive decryption key from
     recovery key + salt
  6. Decrypt backup blob
  7. Restore master verify key,
     device identity key, sessions
  8. Register new device         ──►  POST /devices
  9. Sign new device list        ──►  PUT /users/me/device-list
     (old device removed,
      new device added)
  10. Sessions resume — no
      re-establishment needed
```

**No recovery key available:**

- User's identity is effectively reset.
- New master verify key + device identity key generated.
- All contacts see a "safety number changed" warning.
- Server-side E2E ciphertext is permanently unreadable (no ratchet state to decrypt).
- Local message history (`messages.db`) is lost with the old device.
- This is by design — no backdoor exists.

**With recovery key:** The backup restores ratchet state, so **new messages** can be decrypted. However, the local `messages.db` (containing previously decrypted E2E plaintext) is still lost with the old device. The cross-device history sync protocol (future) addresses this by transferring history from another online device.

### 4.5 Text Message Encryption Flow

#### Sending a DM

```
User types message
        │
        ▼
  Renderer Process             Crypto Worker Thread (direct MessagePort)
  ─────────────────            ──────────────────────────────────────────
  1. postMessage(               2. Fetch recipient's device list
     { op: 'encrypt', ... },    3. For EACH device:
     [plaintext.buffer])            a. Load/establish session
     (zero-copy transfer) ─────►    b. Double Ratchet encrypt
                                    c. Persist ratchet state (SQLite)
                                 4. Return ciphertexts
  5. Receive ciphertexts  ◄─────    (zero-copy ArrayBuffer transfer)
  6. Send via WebSocket
     (MessagePack binary)
```

**MVP note:** With single-device, the `recipients` array always has one entry. The fan-out logic is already in place for multi-device.

#### Receiving a Message

```
  WebSocket receives event (binary MessagePack → decoded)
        │
        ▼
  Renderer Process             Crypto Worker Thread (direct MessagePort)
  ─────────────────            ──────────────────────────────────────────
  1. postMessage(               2. Load session for sender's device
     { op: 'decrypt', ... },    3. Double Ratchet decrypt
     [ciphertext.buffer])       4. Persist updated ratchet state
     (zero-copy transfer) ─────►   (SQLite write BEFORE returning)
                                 5. Return plaintext
  6. Receive plaintext    ◄─────    (zero-copy ArrayBuffer transfer)
  7. Store in messageStore
     (in-memory cache)
  8. Render in UI

  (Crypto Worker also persists
   plaintext to messages.db —
   forward secrecy means the
   ciphertext on the server
   cannot be re-decrypted later)
```

**Critical: Ratchet state persistence is atomic.** The worker writes the updated ratchet state to SQLite *before* returning the plaintext to the renderer. If the app crashes between decrypt and persist, the client re-requests the message and re-decrypts. Out-of-order or duplicate messages are handled by the Double Ratchet's built-in skipped message key mechanism (stores up to 1000 skipped keys).

#### First Message to New Contact (X3DH)

```
  Renderer              Crypto Worker (direct MessagePort)             Server
  ────────              ──────────────────────────────────             ──────
  1. postMessage ──────► 2. Request device list ──────────────────API──►
                          3. Verify signature (master key)       ◄──API──
                          4. For each device:
                            a. Fetch key bundle ──────────────────API──►
                            b. X3DH agreement                    ◄──API──
                            c. Init Double Ratchet
                          5. Encrypt first message (per-device)
  6. Receive     ◄──────
  7. Send via WebSocket (MessagePack binary) ─────────────────────────►
```

**Device list verification:** When fetching a user's device list for the first time, the client stores the master verify key (trust-on-first-use). On subsequent fetches, if the master verify key changes, the client shows a **safety number changed** warning — the user must manually approve the new identity.

### 4.6 Channel Encryption — Tiered Model

Mercury uses a per-channel encryption mode chosen at creation time. The client handles each mode differently:

#### Standard Channels (`standard`)

- Messages are sent as plaintext over the WebSocket (TLS-encrypted in transit).
- The server stores plaintext in the `content` column — full history, searchable, moderatable.
- New joiners see complete message history.
- No client-side encryption/decryption required beyond TLS.

#### Private E2E Channels (`private`, Sender Keys, ≤ 100 members)

1. When joining a private channel, generate a `SenderKey` (symmetric + chain key).
2. Distribute the SenderKey to all current members encrypted via pairwise Double Ratchet sessions (per-device fan-out).
3. Messages are encrypted once with the sender's SenderKey chain (AES-256-GCM).
4. On member leave/kick: **lazy rotation**. The server broadcasts the membership change and increments the channel's `sender_key_epoch`. Each remaining member generates a new Sender Key **only when they next send a message** — distributing it to the current member list before sending. This avoids the O(N²) storm of all members simultaneously rotating.
5. On member join: existing members share current SenderKeys with new member. **New joiner cannot see messages from before they joined.**
6. Hard cap of 100 members. If the channel is full, the server rejects additional joins.

#### E2E DMs (`e2e_dm`, Double Ratchet)

- Full per-device Double Ratchet as described in §4.5. Always E2E.

#### UI Requirements

The client must make encryption modes visually clear:

- **Standard channels:** No special indicator. Normal channel appearance.
- **Private E2E channels:** 🔒 lock icon next to channel name. Tooltip explains E2E encryption and the history limitation.
- **E2E DMs:** 🛡️ shield icon next to conversation name.
- **Channel creation flow:** When creating a channel, show a clear choice between "Community Channel" (standard — full history, searchable) and "Private Channel" (E2E — limited history, 100 member cap). Explain tradeoffs in plain language. The choice is permanent.
- **New joiner notice:** When a user joins a private E2E channel, display a system message: "Messages in this channel are end-to-end encrypted. You can only see messages sent after you joined."

### 4.7 Media E2E Encryption

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
```

#### Key Rotation Epoch Tagging

Because WebRTC media travels over UDP, packets arrive out of order during key rotation. Without epoch tagging, the receiver may try to decrypt a frame with the wrong key, producing severe audio artifacts (static, robotic screeching) or frozen video.

**Frame layout:** Each encrypted frame carries an unencrypted `key_epoch` byte so the receiver knows which key to use:

```
┌──────────────────┬──────────┬──────────────────────────┐
│  key_epoch (1B)  │  IV (12B) │  AES-GCM ciphertext     │
│  (unencrypted)   │           │  (encrypted frame data)  │
└──────────────────┴──────────┴──────────────────────────┘
```

```typescript
// Sender transform: prepend key_epoch to every frame
function setupSenderTransform(sender: RTCRtpSender, keyRing: MediaKeyRing) {
  const senderStreams = sender.createEncodedStreams();
  const transformStream = new TransformStream({
    transform(frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame, controller) {
      const data = new Uint8Array(frame.data);
      const iv = generateFrameIV(frame);
      const encrypted = aesGcmEncrypt(keyRing.currentKey, iv, data);

      // Prepend 1-byte key_epoch (unencrypted, visible to SFU but useless without key)
      const output = new Uint8Array(1 + iv.length + encrypted.length);
      output[0] = keyRing.currentEpoch;       // uint8, wraps at 255
      output.set(iv, 1);
      output.set(encrypted, 1 + iv.length);

      frame.data = output.buffer;
      controller.enqueue(frame);
    }
  });
  senderStreams.readable
    .pipeThrough(transformStream)
    .pipeTo(senderStreams.writable);
}

// Receiver transform: read key_epoch to select correct decryption key
function setupReceiverTransform(receiver: RTCRtpReceiver, keyRing: MediaKeyRing) {
  const receiverStreams = receiver.createEncodedStreams();
  const transformStream = new TransformStream({
    transform(frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame, controller) {
      const data = new Uint8Array(frame.data);
      const epoch = data[0];
      const iv = data.slice(1, 13);
      const ciphertext = data.slice(13);

      const key = keyRing.getKeyForEpoch(epoch);
      if (!key) {
        // New key not yet received via signaling — drop frame silently.
        // A few dropped frames (< 100ms audio) are imperceptible;
        // garbled decryption output is not.
        return;
      }

      const decrypted = aesGcmDecrypt(key, iv, ciphertext);
      frame.data = decrypted.buffer;
      controller.enqueue(frame);
    }
  });
  receiverStreams.readable
    .pipeThrough(transformStream)
    .pipeTo(receiverStreams.writable);
}

// Key ring: holds current + previous keys for graceful rotation
class MediaKeyRing {
  private keys = new Map<number, { key: CryptoKey; expiresAt: number }>();
  currentEpoch: number = 0;
  currentKey: CryptoKey;

  rotateKey(newKey: CryptoKey): void {
    const oldEpoch = this.currentEpoch;
    this.currentEpoch = (this.currentEpoch + 1) % 256;
    this.currentKey = newKey;
    this.keys.set(this.currentEpoch, { key: newKey, expiresAt: Infinity });

    // Retain old key for 5 seconds to decrypt late-arriving UDP packets
    if (this.keys.has(oldEpoch)) {
      this.keys.get(oldEpoch)!.expiresAt = Date.now() + 5000;
      setTimeout(() => this.keys.delete(oldEpoch), 5000);
    }
  }

  getKeyForEpoch(epoch: number): CryptoKey | null {
    const entry = this.keys.get(epoch);
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.key;
  }
}
```

#### Key Distribution for Calls

1. Call initiator generates a random 256-bit symmetric key and sets `key_epoch = 0`.
2. Key is distributed to each participant's devices via their existing encrypted sessions (Double Ratchet per-device fan-out).
3. When a participant joins or leaves, a new key is generated, `key_epoch` is incremented, and the new key + epoch are distributed via signaling.
4. Old keys are retained for **5 seconds** for in-flight frame decryption during rotation, then securely wiped from memory.

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
  maxDelayMs: 120000,            // 2 minutes (NOT 30s — prevents thundering herd)
  backoffMultiplier: 2,
  jitterFactor: 0.25,            // ±25% random jitter (disperses simultaneous reconnects)
  maxAttempts: Infinity,         // Never stop trying
  extendedBaseThresholdMs: 5000, // If disconnected > 5s, start at 5s base instead of 1s
};
```

On reconnection:
1. Attempt `resume` with last known `session_id` and `seq` number.
2. Server replays missed events since last `seq`.
3. If resume fails (session expired), do full `identify` and re-sync state.
4. **If server returns `503` with `Retry-After` header**, use the provided delay instead of the backoff calculation. This handles server-side throttling during mass reconnection events.

**Thundering herd scenario:** If the server restarts and 5,000 clients reconnect, the 2-minute max delay with 25% jitter spreads the reconnection wave over ~2.5 minutes instead of ~30 seconds. The server's global WebSocket upgrade rate limiter (200/sec) returns `503 + Retry-After` to excess clients, ensuring the auth pool is never overwhelmed.

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

  // Hybrid wire format: JSON for control plane, MessagePack for message payloads
  send(op: string, data: unknown): void {
    if (op === 'message_send') {
      // Binary frame: encode as MessagePack (ciphertext as raw bytes, no base64 bloat)
      this.ws.send(msgpack.encode({ op, d: data }));
    } else {
      // Text frame: standard JSON
      this.ws.send(JSON.stringify({ op, d: data, seq: this.seq++ }));
    }
  }

  private onMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      // Binary frame → MessagePack (MESSAGE_CREATE events)
      const envelope = msgpack.decode(new Uint8Array(event.data));
      this.dispatch(envelope);
    } else {
      // Text frame → JSON (all other events)
      this.dispatch(JSON.parse(event.data));
    }
  }
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
| **E2E messages (decrypted plaintext)** | **SQLite (`messages.db`)** | **Yes (safeStorage)** | **Permanent** |
| Standard channel messages | In-memory (Zustand) | N/A (RAM only) | Session only |
| Auth tokens (JWT, refresh) | Electron safeStorage | Yes (OS-level) | Until logout |
| User preferences | `electron-store` (JSON) | No (non-sensitive) | Permanent |
| App cache (avatars, etc.) | Electron cache dir | No | Clearable |

### 8.2 Security Constraints

- **E2E plaintext MUST be stored locally.** The Double Ratchet and Sender Key protocols provide **forward secrecy** — once a message is decrypted, the ratchet advances and the decryption key is mathematically destroyed. The ciphertext on the server **cannot be re-decrypted** on next launch. If decrypted plaintext were held only in RAM, users would lose their entire E2E message history every time they close the app. Therefore, decrypted E2E messages are persisted to a local SQLite database (`~/.mercury/messages.db`), encrypted at rest using the same `safeStorage`-derived key that protects `keys.db` and `sessions.db`.
- **Standard channel messages remain in-memory only.** Since the server holds the plaintext for standard channels, they can always be re-fetched. Local caching to disk is a future optimization for offline access.
- **Key material isolation.** All private keys live in the Crypto Worker Thread only, accessed via MessagePort.
- **Screen capture protection.** Set `setContentProtection(true)` on BrowserWindow to prevent screen capture by other apps (OS-level, best-effort).
- **Local message database security:** The `messages.db` file is encrypted with the same AES-256 key derived from `safeStorage` (or the Linux app password fallback). Without the OS keychain or app password, the file is an opaque blob. Users can delete `messages.db` to purge all local E2E history without affecting their encryption keys or sessions.

---

## 9. IPC API Surface

The preload script exposes a strictly typed API to the renderer:

```typescript
// src/preload/api.ts

export interface MercuryAPI {
  // Crypto — all operations run in the Crypto Worker Thread, routed via Main process IPC
  crypto: {
    // Registration (generates all keys, returns public halves)
    initializeIdentity(): Promise<{
      masterVerifyKey: string;           // Public master verify key (base64)
      deviceId: string;
      deviceIdentityKey: string;         // Public device identity key (base64)
      signedPreKey: PublicSignedPreKey;
      oneTimePreKeys: PublicPreKey[];
      signedDeviceList: string;          // Signed JSON blob (base64)
    }>;

    // Per-device message encryption (fan-out to all recipient devices)
    encryptMessage(recipientId: string, plaintext: string): Promise<PerDeviceEnvelope[]>;
    decryptMessage(senderDeviceId: string, envelope: EncryptedEnvelope): Promise<string>;

    // Group encryption (Sender Keys for private E2E channels)
    encryptGroupMessage(channelId: string, plaintext: string): Promise<EncryptedGroupEnvelope>;
    decryptGroupMessage(channelId: string, senderDeviceId: string, envelope: EncryptedGroupEnvelope): Promise<string>;


    // Session management
    initializeSession(userId: string, deviceId: string, keyBundle: PublicKeyBundle): Promise<void>;
    hasSession(userId: string, deviceId: string): Promise<boolean>;
    getAllDeviceSessions(userId: string): Promise<string[]>;  // Returns device IDs with active sessions

    // Device list verification
    verifyDeviceList(userId: string, signedList: string, masterVerifyKey: string): Promise<DeviceListInfo>;
    getSafetyNumber(userId: string): Promise<string>;  // Displayable safety number

    // Media keys
    generateMediaKey(): Promise<{ key: string }>;
    getMediaKey(roomId: string): Promise<string | null>;
    storeMediaKey(roomId: string, key: string): Promise<void>;

    // Pre-key management
    generatePreKeys(count: number): Promise<{ publicKeys: PublicPreKey[] }>;
    rotateSignedPreKey(): Promise<PublicSignedPreKey>;
  };

  // Recovery
  recovery: {
    generateRecoveryKey(): Promise<{ mnemonic: string }>;  // 24-word BIP39
    createBackup(recoveryKey: string): Promise<Uint8Array>; // Encrypted backup blob
    restoreFromBackup(recoveryKey: string, encryptedBackup: Uint8Array): Promise<void>;
    hasRecoveryKey(): Promise<boolean>;
  };

  // Key store
  keystore: {
    getDeviceId(): Promise<string>;
    getPublicMasterVerifyKey(): Promise<string>;
    getPublicDeviceIdentityKey(): Promise<string>;
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
    encryptEvidence(
      plaintext: string,
      operatorModerationPubKey: string
    ): Promise<string>;
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

// messageStore — dual-storage message management
// E2E messages: persisted to local encrypted SQLite (messages.db) via Crypto Worker
// Standard messages: in-memory only (re-fetched from server on launch)
interface MessageState {
  messages: Map<string, Message[]>;       // channelId → messages (in-memory cache)
  sendMessage(channelId: string, content: string): Promise<void>;
  // For standard channels: sends plaintext via WS, server stores it
  // For private channels: encrypts via MessagePort (Sender Keys), sends ciphertext,
  //   ALSO persists decrypted plaintext to local messages.db
  // For DMs: encrypts via MessagePort (Double Ratchet per-device), sends ciphertext,
  //   ALSO persists decrypted plaintext to local messages.db
  receiveMessage(event: MessageCreateEvent): Promise<void>;
  // E2E messages: decrypt via Crypto Worker, persist plaintext to messages.db,
  //   then update in-memory cache
  fetchHistory(channelId: string, before?: string): Promise<void>;
  // Standard channels: fetch from server (server returns plaintext)
  // E2E channels: load from LOCAL messages.db first (fast, offline-capable),
  //   then fetch any new ciphertext from server since last sync
  // E2E channels: history only available from user's join point forward
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
    - target: flatpak             # Preferred for keychain reliability (org.freedesktop.secrets portal)
  category: Network
  # Flatpak's portal system handles secure keystore access (GNOME Keyring, KWallet)
  # far more reliably than AppImage's sandbox isolation across distros

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
| Sender Key lazy rotation (first message after member removal, 99 recipients) | < 3 seconds total (worker thread, non-blocking to UI) |
| Voice join-to-speaking | < 2 seconds |
| Video frame render latency | < 100ms (E2E) |
| UI responsiveness during heavy crypto | 0 dropped frames (crypto runs on worker thread) |
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

- **Multi-device activation:** Per-device identity keys and signed device lists are already in the MVP data model. Activation requires: a linked-device pairing flow (QR code scanned on existing device to authorize new device), cross-device session fan-out (already supported by per-device encryption format), read-state sync, and a device management settings page.
- **Cross-device E2E history sync (required for multi-device):** A newly authorized device cannot decrypt historical E2E messages (those ciphertexts were encrypted to device keys that didn't exist yet). An existing online device must package its local `messageStore` history, encrypt it to the new device's identity key, and transfer it. This is a significant protocol to design — the payload can be large (months of history), must be resumable if interrupted, and must handle the case where no other device is currently online (queue on server for later sync). Must be designed at multi-device activation time.
- **Social recovery:** Alternative to recovery key. Split the recovery secret into k-of-n shares (Shamir's Secret Sharing) distributed to trusted contacts. Requires a share distribution ceremony UI and a recovery ceremony where k contacts provide their shares.
- **Message franking (v2):** Extend the encryption envelope to include a franking tag (HMAC commitment to plaintext). When a user reports a message, the franking tag + key are included so the server can cryptographically verify the report is authentic. Requires changes to `double-ratchet.ts` and `sender-keys.ts` to produce the franking commitment alongside the ciphertext.
- **Scoped moderator UI (v2):** MVP shows the full moderation dashboard to both owners and moderators (`is_moderator = true`). When v2 adds scoped RBAC permissions, the client needs to conditionally show/hide moderation actions based on the moderator's specific permissions (e.g., can see report queue but "Ban" button is disabled).
- **MLS for large private channels:** If demand exists for E2E channels larger than 100 members, implement MLS (RFC 9420) client-side via WASM build of `openmls`. Adds a new `mls-client.ts` module. The 100-member Sender Key cap remains; MLS channels are a distinct encryption mode.
- **Mobile apps:** Extract the crypto engine into a shared Rust library (compiled via wasm-pack for Electron, native for mobile via FFI). Per-device identity model already supports this — each mobile device gets its own device identity key. Push notifications for standard channels can include message content; E2E channel/DM notifications are metadata-only ("New message from Alice") unless a Notification Service Extension (iOS) or background service (Android) decrypts the preview.
- **Server-side search (standard channels):** Standard channels store plaintext, so full-text search can be implemented server-side. E2E channels require client-side search (either local indexing or searchable encryption — much harder).
- **Plugin system:** Sandboxed renderer-side plugins for custom themes, bots, integrations.
- **Offline message queue:** Queue encrypted messages locally when disconnected; send on reconnect. Requires careful handling of ratchet state for queued messages.
- **Rich embeds/markdown:** Render markdown in messages, URL preview embeds (fetched client-side to preserve privacy).
- **Voice processing:** Echo cancellation, noise suppression, auto-gain via Web Audio API or RNNoise WASM module.
