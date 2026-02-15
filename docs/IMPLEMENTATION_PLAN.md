# Mercury — Phased Implementation Plan

This document defines a staged implementation plan for building Mercury using Claude Code. Each phase produces a testable, verifiable deliverable. **Do not advance to the next phase until the current phase's verification criteria are met.**

The total plan consists of 10 phases, grouped into three milestones. Each phase includes context you should provide to Claude Code and specific verification steps.

---

## Guiding Principles

**One phase at a time.** Paste the relevant spec sections into Claude Code's context for each phase. Don't ask it to "build Mercury" — ask it to build one phase.

**Verify before advancing.** Each phase has explicit "you know it works when" criteria. Run them. If something fails, fix it in the current phase before moving on. Technical debt compounds fast across phases.

**Commit after each phase.** Each completed phase is a meaningful checkpoint you can roll back to. Tag them: `phase-01-skeleton`, `phase-02-database`, etc.

**Test in isolation first.** Write unit tests for each phase's code before wiring it into the larger system. Integration testing happens at milestone boundaries.

---

## Milestone 1: Foundation (Phases 1–4)

**Goal:** A running server that accepts authenticated WebSocket connections, and a client shell that connects to it. No encryption, no messaging — just the plumbing.

---

### Phase 1: Repository Skeleton

**What to build:**
- Full directory structure (per the monorepo layout)
- Rust virtual workspace with empty crates (`mercury-server`, `mercury-api`, `mercury-core`, `mercury-db`, `mercury-auth`, `mercury-crypto`, `mercury-media`) — each with a `Cargo.toml` and minimal `lib.rs`/`main.rs`
- `mercury-server/src/main.rs` with `#[global_allocator]` (jemalloc) and a placeholder Axum server that returns 200 on `GET /health`
- Client `package.json` with all dependencies from the client spec's tech stack, `electron.vite.config.ts`, `tsconfig.json`, `electron-builder.config.yml`
- Root `docker-compose.yml` (Postgres + Redis + coturn)
- `.env.example` with all environment variables
- `scripts/generate-certs.sh`, `scripts/reset-db.sh`
- `.editorconfig`, `.gitignore`, `.vscode/settings.json`, `.vscode/extensions.json`

**What to give Claude Code:**
- The monorepo layout from the getting started guide
- The server spec §2 (Technology Stack) and §3.3 (Crate/Module Structure)
- The client spec §2 (Technology Stack) and §3.3 (Project Structure)
- The `docker-compose.yml` from server spec §9

**Verification:**
```bash
# Rust workspace compiles
cd src/server && cargo build

# Server starts and responds to health check
cargo run &
curl -k https://localhost:8443/health   # → 200 OK

# Client installs and launches
cd src/client && pnpm install && pnpm run electron-rebuild
pnpm dev   # Electron window opens (blank is fine)

# Infrastructure runs
docker compose up -d
docker compose exec postgres pg_isready   # → accepting connections
docker compose exec redis redis-cli ping  # → PONG
```

**Commit tag:** `phase-01-skeleton`

---

### Phase 2: Database Schema and Migrations

**What to build:**
- All SQL migration files from server spec §4 (Data Models): `users`, `devices`, `device_lists`, `servers`, `channels`, `server_members`, `messages`, `message_recipients`, `dm_channels`, `dm_members`, `user_blocks`, `key_bundles`, `key_backups`, `reports`, `abuse_signals`, `audit_log`
- `mercury-db` crate: connection pool setup with `sqlx::PgPoolOptions` (including the 5-second `acquire_timeout`), basic CRUD functions for `users` and `servers`
- `mercury-core` crate: domain model structs (`User`, `Server`, `Channel`, `Message`, etc.) with `sqlx::FromRow` derives
- UUIDv7 generation utility using `uuid` crate with `v7` feature

**What to give Claude Code:**
- Server spec §4 (complete SQL schemas)
- Server spec §8.1 (configuration — `[database]` section with pool settings)
- The UUIDv7 convention note from the migrations header

**Verification:**
```bash
# Migrations run cleanly
cd src/server
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury"
sqlx migrate run --source migrations/

# Verify all tables exist
docker compose exec postgres psql -U mercury -d mercury -c "\dt"

# Verify constraints work
docker compose exec postgres psql -U mercury -d mercury -c "
  INSERT INTO channels (id, server_id, name, encryption_mode)
  VALUES ('00000000-0000-0000-0000-000000000001', NULL, 'test', 'invalid');
"  # → Should fail (CHECK constraint on encryption_mode or FK violation)

# Unit tests pass for UUID generation and pool setup
cargo nextest run -p mercury-db
cargo nextest run -p mercury-core

# Verify UUIDv7 is time-sorted
cargo nextest run -p mercury-core -- uuid_v7_is_time_sorted
```

**Commit tag:** `phase-02-database`

---

### Phase 3: Authentication

**What to build:**
- `mercury-auth` crate: Argon2id password hashing, JWT generation/validation (access + refresh tokens), TURN credential generation
- REST endpoints in `mercury-api`: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
- Axum middleware: JWT extraction, authentication guard
- Redis session storage: `session:{jwt_id}` keys with TTL
- Rate limiting middleware: auth endpoints (5/min per IP) via Redis sliding window

**What to give Claude Code:**
- Server spec §5.1 (REST API — Auth section)
- Server spec §5.3 (Rate Limiting)
- Server spec §4 (`users` table schema)
- Server spec §4.2 (Redis key schema — session keys)
- Server spec §8.1 (`[auth]` configuration section)

**Verification:**
```bash
# Register a user
curl -k -X POST https://localhost:8443/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@example.com","password":"SecureP@ss1"}'
# → 201 with { user_id, access_token, refresh_token }

# Login
curl -k -X POST https://localhost:8443/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"SecureP@ss1"}'
# → 200 with tokens

# Authenticated request
curl -k https://localhost:8443/users/me \
  -H "Authorization: Bearer <access_token>"
# → 200 with user object

# Invalid token rejected
curl -k https://localhost:8443/users/me \
  -H "Authorization: Bearer garbage"
# → 401

# Rate limiting works
for i in {1..6}; do
  curl -k -s -o /dev/null -w "%{http_code}\n" -X POST \
    https://localhost:8443/auth/register \
    -H "Content-Type: application/json" \
    -d '{"username":"spam'$i'","email":"spam'$i'@x.com","password":"Test1234!"}'
done
# → First 5 return 201/409, 6th returns 429

# Unit tests
cargo nextest run -p mercury-auth
```

**Commit tag:** `phase-03-auth`

---

### Phase 4: WebSocket Foundation

**What to build:**
- WebSocket upgrade endpoint at `/ws?token={jwt}` in `mercury-api`
- Global WebSocket upgrade rate limiter (200/sec, returns 503 + Retry-After)
- Connection lifecycle: `identify` → `READY`, `heartbeat` → `HEARTBEAT_ACK`, `resume`
- Session tracking in Redis: `session:{jwt_id}` with connected device info
- Server-side presence: `presence:{user_id}` in Redis, with 15-second offline debounce
- JSON text frame encoding for all control plane messages
- Basic event fan-out: when a user's presence changes, notify relevant subscribers

**What to give Claude Code:**
- Server spec §5.2 (WebSocket Protocol — full op code and event tables)
- Server spec §5.3 (Rate Limiting — thundering herd section)
- Server spec §5.4 (Presence Debounce)
- Server spec §4.2 (Redis key schema — session, presence, presence_offline_pending)

**Verification:**
```bash
# Install wscat for WebSocket testing
npm install -g wscat

# Connect with valid JWT
wscat -c "wss://localhost:8443/ws?token=<jwt>" --no-check

# Send identify
> {"op":"identify","d":{"token":"<jwt>","device_id":"dev1"}}
# ← Should receive READY event with user info and session_id

# Send heartbeat
> {"op":"heartbeat","d":{"seq":0}}
# ← Should receive HEARTBEAT_ACK

# Verify presence in Redis
docker compose exec redis redis-cli GET "presence:<user_id>"
# → Should show status: "online"

# Disconnect and verify debounce
# (close wscat, wait 5 seconds, check Redis)
docker compose exec redis redis-cli GET "presence_offline_pending:<user_id>"
# → Should exist with TTL ~15s

# Wait 16 seconds, then:
docker compose exec redis redis-cli GET "presence:<user_id>"
# → Should show status: "offline" (or key should be gone)

# Unit and integration tests
cargo nextest run -p mercury-api -- websocket
```

**Commit tag:** `phase-04-websocket`

---

### 🏁 Milestone 1 Checkpoint

At this point you have: a server that starts, accepts registrations, authenticates users, and maintains WebSocket connections with presence tracking. Everything is testable with `curl` and `wscat`. No client code beyond the shell is needed yet.

**Integration test:** Register two users, connect both via WebSocket, verify that User A sees User B's presence update.

---

## Milestone 2: Messaging (Phases 5–7)

**Goal:** Users can send and receive messages in both standard (plaintext) and E2E encrypted channels. The Electron client is fully functional for text chat.

---

### Phase 5: Electron Client Shell

**What to build:**
- Electron main process: app lifecycle, system tray, window management
- Crypto Worker Thread: spawns at app launch, MessagePort setup between Worker ↔ Renderer, safeStorage proxy from Worker → Main
- Linux safeStorage fallback: `isEncryptionAvailable()` check, `--password-store` flag detection, Argon2id app password fallback
- Preload script: contextBridge API surface with typed IPC channels
- React app shell: login page, registration page, basic layout (sidebar + channel list + chat area), Zustand stores (authStore, serverStore, settingsStore)
- WebSocket manager: connect, identify, heartbeat, reconnect with 120s max delay + jitter + Retry-After respect
- REST API client: fetch wrapper with JWT auth header injection and token refresh
- Standard channel messaging (plaintext): send via WebSocket, receive via WebSocket event, display in UI. No encryption yet.

**What to give Claude Code:**
- Client spec §3 (Architecture — the full Worker Thread architecture, MessagePort diagrams)
- Client spec §4.3 (Local Key Storage — safeStorage fallback section)
- Client spec §5 (WebSocket Manager — connection lifecycle, reconnection strategy, event dispatch with hybrid JSON/MessagePack)
- Client spec §9 (IPC API Surface)
- Client spec §10 (Zustand Stores — authStore, serverStore, messageStore interfaces)
- Server spec §5.1 (REST API — Server and Channel endpoints, so the client knows what to call)

**Verification:**
```
1. Launch the app → login screen appears
2. Register a new account → redirected to main UI
3. Create a server → appears in sidebar
4. Create a standard channel → appears in channel list
5. Send a message → appears in chat area
6. Open a second instance (or use wscat) → message appears in both
7. Kill the server → client shows reconnecting state
8. Restart the server → client reconnects automatically
9. On Linux without keyring → app password prompt appears
```

**Commit tag:** `phase-05-client-shell`

---

### Phase 6: E2E Crypto Engine

This is the hardest phase. Take it slow and test each primitive independently before composing them.

**What to build (in this order within the phase):**

**6a. Crypto primitives (Worker Thread):**
- Identity key generation (Ed25519 signing + X25519 key agreement)
- Signed pre-key generation and rotation
- One-time pre-key batch generation
- Key serialization/deserialization utilities
- SQLite encrypted key store (`keys.db`) — open with safeStorage-derived key
- SQLite encrypted message store (`messages.db`) — same encryption key

**6b. X3DH key agreement:**
- Key bundle upload: `POST /users/me/devices/:id/keys`
- Key bundle fetch: `GET /users/:id/devices/:id/keys`
- X3DH initiator (Alice) and responder (Bob) flows
- Session establishment from X3DH shared secret

**6c. Double Ratchet:**
- Symmetric ratchet (sending and receiving chains)
- DH ratchet (Diffie-Hellman ratchet step on each exchange)
- Skipped message keys (handle out-of-order delivery, store up to 1000)
- Session state persistence in `sessions.db`
- Ratchet state persistence is atomic (write before returning plaintext)

**6d. Sender Keys (for private channels):**
- SenderKey generation and chain ratcheting
- SenderKey distribution (encrypted pairwise via existing Double Ratchet sessions)
- Lazy rotation on member removal (check `sender_key_epoch`)
- Epoch validation (reject messages with stale epoch)

**6e. Device management:**
- Signed device list creation and verification
- Master Verify Key (trust-on-first-use)
- Safety number generation and display
- Recovery key generation (BIP-39 mnemonic), encrypted key backup upload/download

**What to give Claude Code:**
- Client spec §4 (entire E2E section — all subsections from 4.1 through 4.6)
- Server spec §6 (entire E2E section — architecture, key exchange, ratchet, trust model)
- Server spec §4 (key_bundles, key_backups, device_lists table schemas)
- Client spec §8 (Local Data Management — messages.db persistence, forward secrecy explanation)

**Verification:**

Test each sub-phase independently:

```
6a. Crypto primitives:
    - Generate identity key → verify it round-trips through SQLite
    - Generate 100 one-time pre-keys → verify they're stored and retrievable
    - Open keys.db with wrong password → verify it fails (not plaintext fallback)

6b. X3DH:
    - Unit test: Alice initiates X3DH with Bob's key bundle → both derive same shared secret
    - Integration test: Upload key bundle via REST → fetch it → perform X3DH → verify shared secret

6c. Double Ratchet:
    - Unit test: Alice sends 10 messages → Bob decrypts all 10 → verify plaintext matches
    - Unit test: Deliver messages 1, 3, 5 then 2, 4 → verify all decrypt correctly (skipped keys)
    - Unit test: Alice sends, Bob replies, Alice sends → verify ratchet advances (DH ratchet step)
    - Persistence test: Encrypt message, kill app, restart, encrypt another → verify ratchet state survived

6d. Sender Keys:
    - Unit test: Alice distributes SenderKey to Bob and Carol → Alice encrypts → both decrypt
    - Unit test: Remove Carol, Alice sends with new epoch → Bob decrypts, Carol's old key fails
    - Lazy rotation test: Remove member → next send generates new key → verify distribution

6e. Device management:
    - Generate recovery key → display as mnemonic → re-derive → verify same key
    - Encrypt key backup → upload → download → decrypt → verify contents match
    - Sign device list → verify signature → tamper with list → verify signature fails
```

**Commit tag:** `phase-06-crypto`

---

### Phase 7: E2E Messaging Integration

**What to build:**
- Wire the crypto engine into the message send/receive flow
- MessagePack binary encoding for `message_send` and `MESSAGE_CREATE` WebSocket frames
- Per-device ciphertext fan-out on send (writes to `message_recipients` table)
- Per-device ciphertext filtering on receive (server queries by `device_id`)
- E2E DM flow: X3DH session establishment → Double Ratchet encrypt/decrypt → display plaintext
- Private channel flow: Sender Key encrypt → broadcast ciphertext → decrypt → display
- Local message persistence: decrypted plaintext saved to `messages.db` after decryption
- History fetch: E2E channels load from local `messages.db` first, then fetch new ciphertexts from server
- Channel encryption mode UI: encryption badge (🔒/🛡️), E2E join notice, channel creation with mode selection

**What to give Claude Code:**
- Client spec §4.5 (Text Message Encryption Flow — send/receive diagrams)
- Client spec §4.6 (Channel Encryption — Tiered Model)
- Server spec §5.2 (WebSocket Protocol — hybrid JSON/MessagePack, message_send and MESSAGE_CREATE)
- Server spec §4 (`messages` and `message_recipients` table schemas)
- Client spec §8 (Local Data Management — messages.db forward secrecy)
- Client spec §10 (messageStore interface — dual-storage model)

**Verification:**
```
1. Two users (different Electron instances or one Electron + wscat)
2. User A starts a DM with User B:
   a. X3DH handshake occurs (check key bundle fetch in server logs)
   b. User A sends "hello" → User B sees "hello" (decrypted)
   c. User B replies "hi" → User A sees "hi"
   d. Close User A's app, reopen → message history loaded from local messages.db
   e. User A sends another message → verify ratchet advanced (not same ciphertext)

3. Create a private channel with 3 users:
   a. User A sends message → Users B and C both decrypt it
   b. Remove User C from channel
   c. User A sends another message → User B decrypts, User C cannot
   d. Verify lazy rotation: new SenderKey distributed only when User A sent

4. Create a standard channel:
   a. Messages appear as plaintext (no encryption badge)
   b. Server stores plaintext in `content` column (verify in psql)

5. MessagePack verification:
   - Capture WebSocket frames (Electron DevTools → Network tab)
   - message_send frames should be binary (not JSON text)
   - Control frames (heartbeat, presence) should be JSON text
```

**Commit tag:** `phase-07-messaging`

---

### 🏁 Milestone 2 Checkpoint

At this point you have a functional encrypted chat application. Two users can register, create servers, create channels (standard and E2E), and exchange messages that are end-to-end encrypted. Message history persists locally across app restarts.

**Integration test:** Full user journey — register, create server, invite second user, send messages in all three channel modes, verify encryption, restart both apps, verify history.

---

## Milestone 3: Voice, Moderation, and Polish (Phases 8–10)

**Goal:** Voice/video calls with E2E encryption, moderation tools, and production readiness.

---

### Phase 8: Voice and Video Calls

**What to build:**
- SFU in `mercury-media` crate: WebRTC signaling via WebSocket (`webrtc_signal`, `voice_state_update`), RTP packet forwarding with `str0m`, dedicated Tokio runtime with core affinity
- Client WebRTC manager: `PeerConnection` lifecycle, track management (add/remove audio/video), ICE candidate exchange, simulcast quality adaptation
- Insertable Streams: frame-level E2E encryption with `key_epoch` tagging, `MediaKeyRing` class, AES-GCM encrypt/decrypt, key rotation on participant join/leave, 5-second old key retention
- TURN credential generation: server-side REST endpoint, client-side ICE configuration
- UI: voice channel panel, mute/deafen controls, video grid, participant tiles, connectivity diagnostic panel
- Audio processing: voice activity detection, noise gate

**What to give Claude Code:**
- Server spec §7 (Media Server — SFU architecture, core affinity, str0m integration)
- Server spec §6.8 (Audio/Video Encryption — epoch tagging, frame layout)
- Client spec §4.7 (Media E2E Encryption — Insertable Streams, MediaKeyRing, key distribution)
- Client spec §6 (WebRTC Manager — connection flow, track management)
- Server spec §9.3 and §9.4 (TURN server, networking considerations, port forwarding guide)

**Verification:**
```
1. Two users join a voice channel:
   a. Audio flows in both directions (speak and hear)
   b. Mute button stops outgoing audio
   c. Deafen button stops incoming audio

2. Third user joins:
   a. Key rotation occurs (check key_epoch increment in Insertable Streams)
   b. All three hear each other
   c. Brief silence during rotation is acceptable; static/screeching is not

3. User leaves:
   a. Key rotation occurs again
   b. Remaining users still hear each other

4. Video call:
   a. Enable camera → video tiles appear for all participants
   b. Quality adapts if bandwidth is limited (simulcast layer switching)

5. TURN fallback:
   a. Simulate restrictive NAT (block direct UDP) → call still works via TURN relay
   b. If TURN fails → diagnostic panel shows which connectivity checks failed

6. Connectivity diagnostic:
   a. Kill coturn → attempt call → diagnostic panel shows TURN failure clearly
   b. Check server-side ICE_DIAGNOSTIC events in logs
```

**Commit tag:** `phase-08-voice-video`

---

### Phase 9: Moderation and Trust/Safety

**What to build:**
- Server-side moderation endpoints: ban, kick, mute, reports, audit log (owner + `is_moderator` auth)
- Moderator promotion/demotion: `PUT/DELETE /servers/:id/moderators/:userId` (owner-only)
- Report submission flow: user selects message → attaches evidence → encrypts to operator's moderation key → submits
- Report review dashboard: report queue, report detail with framing warnings for E2E reports, action buttons (ban/kick/mute/dismiss)
- Automated abuse signals: server-side heuristics (rapid messaging, mass DMs, join-spam), configurable thresholds
- User blocking: client and server-side enforcement (messages silently dropped, presence hidden)
- Audit log: all moderation actions logged with actor, target, action, timestamp
- UI: ReportDialog, BlockConfirmDialog, ModerationDashboard, ReportQueue, BanList, AuditLog, UnverifiedReportBanner

**What to give Claude Code:**
- Server spec §10 (entire Moderation & Trust/Safety section — all four layers)
- Server spec §5.1 (REST API — Moderation, Reporting, Abuse Signal endpoints)
- Client spec §4.6 (UI Requirements — encryption badges, framing warnings)
- Client spec §3.3 (Project Structure — moderation components list)

**Verification:**
```
1. Owner promotes User B to moderator
2. Moderator bans User C → User C is disconnected, cannot rejoin
3. Moderator cannot promote other moderators → 403
4. Moderator cannot delete server → 403

5. User reports a message:
   a. Standard channel: report includes plaintext evidence, marked "verified"
   b. E2E channel: report includes evidence, marked "unverified" with framing warning

6. Abuse signals:
   a. Send 50 messages in 1 minute → automated rate limit triggers
   b. Signal appears in operator dashboard

7. User blocks another user:
   a. Blocked user's messages stop appearing
   b. Blocked user cannot see blocker's presence
   c. Blocked user receives no indication they are blocked

8. Audit log:
   a. All ban/kick/mute actions appear with timestamps and actor info
```

**Commit tag:** `phase-09-moderation`

---

### Phase 10: Production Hardening

**What to build:**
- Observability: Prometheus metrics endpoint (`/metrics`), all metrics from server spec §12 (connection counts, message throughput, pool stats, acquire timeouts, SFU jitter)
- Docker production deployment: `docker-compose.prod.yml` with Mercury server container, health checks, restart policies
- Electron packaging: builds for all platforms (macOS dmg/zip, Windows nsis/portable, Linux AppImage/deb/rpm/Flatpak), code signing configuration, auto-updater
- Security hardening: HSTS headers, CSP in Electron, `nodeIntegration: false` verification, `webSecurity: true`, `contextIsolation: true`
- Performance validation: measure against all targets in client spec §12 (launch time, message latency, decrypt time, memory usage, CPU idle)
- Recovery flow: full test of recovery key generation → backup → restore on new device
- Operator guide: port forwarding instructions, scaling triggers, backup procedures

**What to give Claude Code:**
- Server spec §11 (Security — server-side hardening checklist)
- Server spec §12 (Observability — full metrics list)
- Server spec §9 (Docker Deployment — production compose, networking)
- Client spec §11 (Build & Distribution — electron-builder config, entitlements, Flatpak)
- Client spec §12 (Performance Targets — all metrics)
- Client spec §7 (Security Hardening — Electron settings)

**Verification:**
```
1. Prometheus: curl https://localhost:8443/metrics → valid Prometheus format
2. Docker prod: docker compose -f docker-compose.prod.yml up → full stack starts
3. Packaging: pnpm run build:mac / build:win / build:linux → installers created
4. Security: Run electron-security-checklist against the built app
5. Performance: 
   - App launch < 3 seconds
   - Message send latency < 200ms
   - Message decrypt < 5ms
   - Memory idle < 300MB
6. Recovery: Register → save recovery key → delete app data → restore → verify sessions resume
```

**Commit tag:** `phase-10-production`

---

## Phase Dependency Graph

```
Phase 1 (Skeleton)
    │
    ▼
Phase 2 (Database) ──────────────────────────────────┐
    │                                                 │
    ▼                                                 │
Phase 3 (Auth)                                        │
    │                                                 │
    ▼                                                 │
Phase 4 (WebSocket) ─── Milestone 1 ✓                │
    │                                                 │
    ├──────────────┐                                  │
    ▼              ▼                                  │
Phase 5        Phase 6                                │
(Client)       (Crypto Engine)                        │
    │              │                                  │
    └──────┬───────┘                                  │
           ▼                                          │
    Phase 7 (E2E Messaging) ─── Milestone 2 ✓        │
           │                                          │
           ├──────────────┐                           │
           ▼              ▼                           │
    Phase 8           Phase 9                         │
    (Voice/Video)     (Moderation) ◄──────────────────┘
           │              │
           └──────┬───────┘
                  ▼
           Phase 10 (Production) ─── Milestone 3 ✓
```

Note that **Phases 5 and 6 can be worked in parallel** — the client shell (Phase 5) doesn't depend on the crypto engine (Phase 6), and vice versa. They converge in Phase 7. Similarly, **Phases 8 and 9 can be worked in parallel** after Phase 7 is complete.

---

## Tips for Working with Claude Code

**Scope each prompt tightly.** Don't say "implement Phase 6." Say "implement the X3DH key agreement in `src/client/src/worker/crypto/x3dh.ts` per the attached spec section." Small, focused prompts produce better code.

**Paste spec sections as context.** Claude Code doesn't have the Mercury specs in memory. Copy-paste the relevant sections for each task. The specs are detailed enough that Claude Code should produce accurate implementations.

**Ask for tests alongside implementation.** End each prompt with "and write unit tests in the appropriate test file." This keeps test coverage from falling behind.

**Review the crypto code especially carefully.** Phases 6 and 7 are where subtle bugs cause silent security failures. Don't trust AI-generated crypto without reading it line by line. Consider running the crypto test vectors from the Signal Protocol documentation.

**Use the server spec's code examples.** The spec includes Rust code snippets for the rate limiter, TURN credentials, pool setup, and jemalloc. These are meant to be used directly — they're not pseudocode.

**Don't skip the electron-rebuild step.** After every `pnpm install` or Electron version change, run `pnpm run electron-rebuild`. The "module version mismatch" crash is the most common time-waster in Electron development.
