# Mercury — Test Specification

**Version:** 1.0
**Spec ID:** `TESTSPEC-001`

This file is the authoritative definition of all tests that must exist for the Mercury project. Each test has a unique ID, a canonical name, an expected file location, a tier classification, and a precise description of what it asserts.

This file is a **reference spec**, not an instruction prompt. It should be committed to the repo and read by tooling as needed.

---

## Conventions

- **Server tests:** Rust, `cargo nextest run`, per-crate.
- **Client unit tests:** TypeScript, Vitest.
- **Client E2E tests:** TypeScript, Playwright + Electron.
- **Infrastructure tests:** Require Postgres + Redis (testcontainers or Docker Compose).
- **Determinism:** Every test is self-contained and idempotent. No inter-test dependencies.
- **Fresh state:** Tests requiring multiple users create them at runtime.

## Tiers

| Tier | What Runs | Infra Needed | Time Budget |
|------|-----------|--------------|-------------|
| `unit` | Pure logic, no I/O | None | < 30s total |
| `integration` | DB, Redis, cross-module | Docker Compose | < 5m |
| `e2e` | Full stack, Electron | Full stack running | < 15m |
| `security` | Security property verification | Varies | < 5m |
| `bench` | Performance measurement | Varies | < 10m |

---

## 1. Server Unit Tests

Infrastructure: None.

### 1.1 `mercury-core`

Location: `src/server/crates/mercury-core/src/` (inline `#[cfg(test)]`) or `tests/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| CORE-001 | `uuid_v7_is_time_sorted` | unit | Generate 1000 UUIDv7s in a loop. Each is lexicographically greater than the previous. |
| CORE-002 | `uuid_v7_is_valid_uuid` | unit | Generated UUIDv7 parses as valid UUID with version=7. |
| CORE-003 | `typed_id_serialization_roundtrip` | unit | `UserId`, `ServerId`, `ChannelId`, `MessageId`, `DeviceId` each survive JSON serialize → deserialize with equality. |
| CORE-004 | `typed_id_sqlx_type_compatible` | unit | All typed IDs implement `sqlx::Type` + `sqlx::Encode` + `sqlx::Decode`. Compile-time check is sufficient. |
| CORE-005 | `config_loads_default_toml` | unit | `config/default.toml` loads into config struct. `port = 8443`, `max_connections = 50`, `jwt_expiry_minutes = 60`. |
| CORE-006 | `config_env_override` | unit | Set `MERCURY_SERVER_PORT=9999` in env. Load config. `port == 9999`. |
| CORE-007 | `error_types_display` | unit | Each error variant `.to_string()` is human-readable. HTTP status codes: `NotFound` → 404, `Unauthorized` → 401, `RateLimited` → 429. |
| CORE-008 | `user_model_constraints` | unit | Username: 1–32 chars validated. Email: format validated. Status: restricted to `online`, `idle`, `dnd`, `offline`. |

### 1.2 `mercury-auth`

Location: `src/server/crates/mercury-auth/src/` + `tests/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| AUTH-001 | `argon2id_hash_and_verify` | unit | Hash a password. Verify correct password → success. |
| AUTH-002 | `argon2id_wrong_password_fails` | unit | Hash a password. Verify different password → failure. |
| AUTH-003 | `argon2id_hash_is_not_plaintext` | unit | Hash string does not contain the plaintext password as substring. |
| AUTH-004 | `argon2id_uses_configured_params` | unit | Hash with `memory: 65536`, `iterations: 3`, `parallelism: 4`. Parse hash string → params encoded correctly. |
| AUTH-005 | `jwt_generate_and_validate` | unit | Generate access token. Validate → claims contain correct `user_id`, `device_id`, `exp`, `jti`. |
| AUTH-006 | `jwt_expired_token_rejected` | unit | Token with 0s expiry. Wait 1s. Validation fails with expiration error. |
| AUTH-007 | `jwt_tampered_token_rejected` | unit | Valid token. Flip one char in signature. Validation fails. |
| AUTH-008 | `jwt_wrong_secret_rejected` | unit | Token signed with secret A. Validate with secret B → failure. |
| AUTH-009 | `refresh_token_is_distinct_from_access` | unit | Access and refresh tokens for same user: different strings, different `jti`, different expiry. |
| AUTH-010 | `turn_credential_generation` | unit | Generate TURN creds for a user. Username contains future timestamp. Credential is valid base64. TTL = 86400. |
| AUTH-011 | `turn_credential_hmac_verifiable` | unit | Generate TURN creds. Independently compute HMAC-SHA1 of username with shared secret. Credential matches. |

### 1.3 `mercury-crypto`

Location: `src/server/crates/mercury-crypto/src/` + `tests/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| CRYPTO-001 | `key_bundle_type_serialization` | unit | Key bundle struct (identity key, signed prekey, prekey signature) survives serialize → deserialize. |
| CRYPTO-002 | `signed_device_list_verification` | unit | Mock signed device list with valid Ed25519 signature. Verify → success. |
| CRYPTO-003 | `signed_device_list_tampered_fails` | unit | Signed device list. Modify one byte. Signature verify → failure. |
| CRYPTO-004 | `signed_device_list_wrong_key_fails` | unit | Device list signed with key A. Verify with key B → failure. |
| CRYPTO-005 | `key_upload_signature_validation` | unit | Signed prekey signed by device identity key. Verify → success. Tamper → failure. |
| CRYPTO-006 | `backup_blob_validation` | unit | Mock encrypted backup blob has expected structure. Blob bytes do not contain marker plaintext strings. |

### 1.4 `mercury-moderation`

Location: `src/server/crates/mercury-moderation/src/` + `tests/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| MOD-001 | `abuse_signal_rapid_messaging` | unit | 31 messages in 60s → `rapid_messaging` signal, severity ≥ `medium`. |
| MOD-002 | `abuse_signal_below_threshold` | unit | 29 messages in 60s → no signal. |
| MOD-003 | `abuse_signal_mass_dm` | unit | 21 new DM channels in 1h → `mass_dm` signal. |
| MOD-004 | `abuse_signal_join_spam` | unit | 11 server joins in 1h → `join_spam` signal. |
| MOD-005 | `abuse_signal_report_threshold` | unit | 6 reports from distinct users in 24h → `report_threshold` signal, severity `high`. |
| MOD-006 | `ban_expiry_logic` | unit | Ban with 1h expiry: `is_expired()` → false now, true after expiry. |
| MOD-007 | `ban_permanent_never_expires` | unit | Ban with no expiry: `is_expired()` → always false. |
| MOD-008 | `mute_expiry_logic` | unit | Channel mute with 30min expiry: time-based expiry works. |
| MOD-009 | `report_category_validation` | unit | Valid categories accepted: `spam`, `harassment`, `illegal`, `csam`, `other`. Invalid → error. |
| MOD-010 | `report_status_transitions` | unit | Valid: `pending` → `reviewed`/`actioned`/`dismissed`. Invalid (e.g., `dismissed` → `pending`) → rejected. |
| MOD-011 | `audit_log_entry_immutable` | unit | Create audit entry. No update/delete method exists (only append). |
| MOD-012 | `block_list_unidirectional` | unit | A blocks B: `is_blocked(A, B)` = true, `is_blocked(B, A)` = false. |

### 1.5 `mercury-media`

Location: `src/server/crates/mercury-media/src/` + `tests/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| MEDIA-001 | `room_create_destroy` | unit | Create room → unique ID, 0 participants, correct channel_id. Destroy → no longer exists. |
| MEDIA-002 | `room_add_remove_participant` | unit | Add 3 → count=3. Remove 1 → count=2. |
| MEDIA-003 | `room_max_participants_enforced` | unit | Config `max=5`. Add 5 → ok. Add 6th → rejected. |
| MEDIA-004 | `quality_config_parsing` | unit | `[media]` TOML section loads: audio/video bitrate, simulcast layers, bandwidth limits all correct. |
| MEDIA-005 | `simulcast_layer_selection` | unit | Receiver bandwidth=600kbps → `medium` layer selected (not `high` at 2500kbps). |
| MEDIA-006 | `bandwidth_budget_enforcement` | unit | Total upload=100Mbps. 30 users × 4000kbps → quality adaptation triggers (downgrade to medium). |

---

## 2. Server Integration Tests

Infrastructure: Postgres + Redis (testcontainers or Docker Compose).

### 2.1 Database Layer (`mercury-db`)

Location: `src/server/crates/mercury-db/tests/` or `src/server/tests/db/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| DB-001 | `migrations_run_cleanly` | integration | All migrations on fresh DB → no errors. Run again → idempotent. |
| DB-002 | `user_crud` | integration | Create → read by ID → update display_name → delete. Each step correct. |
| DB-003 | `user_unique_username` | integration | Two users with same username → second fails unique constraint. |
| DB-004 | `user_unique_email` | integration | Two users with same email → second fails. |
| DB-005 | `server_crud` | integration | Create with owner → read → update name → delete → cascade deletes channels/members. |
| DB-006 | `server_invite_code_unique` | integration | Two servers with same invite code → second fails. |
| DB-007 | `channel_crud` | integration | Create text channel → read → update name → delete → gone. |
| DB-008 | `channel_encryption_mode_immutable` | integration | Create `standard` channel. Update to `private` → rejected. |
| DB-009 | `channel_private_max_members_100` | integration | Private channel with `max_members=101` → CHECK constraint violation. |
| DB-010 | `channel_unique_name_per_server` | integration | Same name in same server → unique violation. Different servers → ok. |
| DB-011 | `server_member_join_leave` | integration | Add member → in list. Remove → not in list. |
| DB-012 | `message_insert_fetch_paginated` | integration | Insert 20 messages. Fetch page 1 (10) → correct. Fetch page 2 → remainder. Ordering: newest first. |
| DB-013 | `message_channel_or_dm_constraint` | integration | Both `channel_id` and `dm_channel_id` set → CHECK fails. Neither set → CHECK fails. Exactly one → ok. |
| DB-014 | `message_recipients_per_device` | integration | 3 recipients for 3 devices. Fetch by device A → only A's row returned. |
| DB-015 | `message_recipients_broadcast` | integration | Row with `device_id = NULL` (Sender Key). Fetch where `device_id IS NULL` → returned. |
| DB-016 | `dm_channel_crud` | integration | Create DM → add 2 members → count correct. List DMs for user → appears. |
| DB-017 | `device_registration` | integration | Register device → in devices table. Second device → both exist. |
| DB-018 | `device_identity_key_crud` | integration | Upload identity key + signed prekey → fetch by device → data matches. Update prekey → new value. |
| DB-019 | `one_time_prekey_claim_atomic` | integration | Upload 10 OTPs. Claim one → 9 remain. Re-claim same key_id → fails or returns nothing. |
| DB-020 | `one_time_prekey_batch_lifecycle` | integration | Upload 5. Claim 1 → marked used, removed from available pool. |
| DB-021 | `device_list_crud` | integration | Upload signed list → fetch by user → matches. Update → version incremented. |
| DB-022 | `key_backup_crud` | integration | Upload backup → fetch → matches. Update → version incremented. Delete → GET returns 404. |
| DB-023 | `user_blocks_crud` | integration | A blocks B → exists. Unblock → gone. Self-block → handled. |
| DB-024 | `server_bans_crud` | integration | Ban → exists. Unban → removed. Expiry time works. |
| DB-025 | `channel_mutes_crud` | integration | Mute → exists. Unmute → removed. |
| DB-026 | `reports_crud` | integration | Create report → fetch by server → present. Update to `actioned` → status changed, `reviewed_at` set. |
| DB-027 | `audit_log_append_only` | integration | Insert 5 entries → all exist chronologically. No UPDATE/DELETE path available. |
| DB-028 | `abuse_signals_crud` | integration | Insert signal → fetch unreviewed → present. Mark reviewed → no longer in unreviewed. |
| DB-029 | `cascade_delete_server` | integration | Server with channels, members, messages. Delete server → all related rows gone. |
| DB-030 | `pool_acquire_timeout` | integration | Pool `acquire_timeout=1s`, `max_connections=1`. Hold one. Second acquire → times out in ~1s, doesn't hang. |

### 2.2 REST API (`mercury-api`)

Location: `src/server/crates/mercury-api/tests/` or `src/server/tests/api/`

#### 2.2.1 Authentication

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-001 | `register_success` | integration | POST `/auth/register` valid data → 201, body has `user_id`, `access_token`, `refresh_token`. |
| API-002 | `register_duplicate_email` | integration | Register twice same email → second returns 409. |
| API-003 | `register_duplicate_username` | integration | Register twice same username → second returns 409. |
| API-004 | `register_weak_password` | integration | Password "123" → 400 validation error. |
| API-005 | `register_invalid_email` | integration | `email: "notanemail"` → 400. |
| API-006 | `register_missing_fields` | integration | Empty body → 400 or 422. |
| API-007 | `login_success` | integration | Register then login correct creds → 200 with tokens. |
| API-008 | `login_wrong_password` | integration | Register then login wrong password → 401. |
| API-009 | `login_nonexistent_user` | integration | Login unknown email → 401 (not 404 — don't leak existence). |
| API-010 | `refresh_token_success` | integration | Login, use refresh token → 200 with new tokens. |
| API-011 | `refresh_with_access_token_fails` | integration | Use access token as refresh → 401. |
| API-012 | `logout_invalidates_session` | integration | Login, logout, use access token → 401. |
| API-013 | `get_users_me` | integration | Login, GET `/users/me` → 200 with correct user. |
| API-014 | `get_users_me_no_auth` | integration | GET `/users/me` no auth → 401. |
| API-015 | `get_users_me_invalid_token` | integration | GET `/users/me` garbage Bearer → 401. |

#### 2.2.2 Rate Limiting

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-016 | `auth_rate_limit` | integration | 6 register requests same IP → first 5 succeed, 6th → 429 with `Retry-After`. |
| API-017 | `general_api_rate_limit` | integration | 61 GET `/users/me` → 61st → 429. |
| API-018 | `rate_limit_per_user_not_global` | integration | Two users each send 60 requests → both succeed. |

#### 2.2.3 Servers

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-019 | `create_server` | integration | POST `/servers` → 201 with `invite_code`. |
| API-020 | `list_servers` | integration | Create 3 servers. GET `/servers` → all 3. |
| API-021 | `get_server_detail` | integration | Create, GET `/servers/:id` → full details. |
| API-022 | `get_server_non_member` | integration | User B (non-member) GET `/servers/:id` → 403. |
| API-023 | `update_server_owner_only` | integration | Owner PATCH → 200. Non-owner PATCH → 403. |
| API-024 | `delete_server_owner_only` | integration | Owner DELETE → 200. Non-owner DELETE → 403. |
| API-025 | `join_server_by_invite` | integration | User B joins via invite code → 200, appears in member list. |
| API-026 | `join_server_invalid_invite` | integration | Bogus invite code → 404. |
| API-027 | `leave_server` | integration | Member leaves → 200, no longer in member list. |
| API-028 | `owner_cannot_leave` | integration | Owner tries to leave → 403. |

#### 2.2.4 Channels

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-029 | `create_channel_standard` | integration | `encryption_mode: 'standard'` → 201. |
| API-030 | `create_channel_private` | integration | `encryption_mode: 'private'` → 201, `max_members ≤ 100`. |
| API-031 | `create_channel_non_owner` | integration | Non-owner → 403. |
| API-032 | `list_channels` | integration | Create 3 → list → all 3. |
| API-033 | `delete_channel` | integration | Owner DELETE → 200. |
| API-034 | `encryption_mode_in_response` | integration | Standard and private channels each return correct `encryption_mode`. |

#### 2.2.5 Messages

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-035 | `fetch_history_paginated` | integration | 50 messages → fetch 25 → cursor present → fetch 25 more → remainder. |
| API-036 | `fetch_history_empty` | integration | Empty channel → 200 empty array. |
| API-037 | `fetch_history_non_member` | integration | Non-member → 403. |
| API-038 | `fetch_dm_history` | integration | DM with messages → fetch → correct messages. |
| API-039 | `history_device_filter` | integration | E2E message with 2 recipient rows. Fetch with device A's token → only A's ciphertext returned. |

#### 2.2.6 Devices & Keys

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-040 | `register_device` | integration | POST `/devices` → 201 with `device_id`. |
| API-041 | `list_devices` | integration | Register 2 → GET → both. |
| API-042 | `upload_key_bundle` | integration | PUT identity key + signed prekey + 100 OTPs → 200. |
| API-043 | `fetch_key_bundle` | integration | User A uploads. User B fetches → 200 with bundle. |
| API-044 | `claim_one_time_prekey` | integration | Upload 100 OTPs. Claim → 200 with prekey. Claim again → different prekey. 100 claims → graceful degradation (bundle without OTP). |
| API-045 | `fetch_all_device_keys` | integration | User A has 1 device with keys. User B GET `/users/:id/keys` → array of bundles. |
| API-046 | `upload_device_list` | integration | PUT signed list → 200. |
| API-047 | `fetch_device_list` | integration | Upload, another user fetches → 200 with signed data. |
| API-048 | `delete_device_cascades_keys` | integration | Register device, upload keys, DELETE device → keys cascade-deleted. |

#### 2.2.7 Key Backup

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-049 | `upload_key_backup` | integration | PUT encrypted blob + salt → 200. |
| API-050 | `download_key_backup` | integration | Upload then GET → same blob and salt. |
| API-051 | `update_key_backup` | integration | Upload, upload again → version incremented. |
| API-052 | `delete_key_backup` | integration | Upload, DELETE → GET returns 404. |
| API-053 | `download_nonexistent_backup` | integration | GET without upload → 404. |

#### 2.2.8 DMs

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-054 | `create_dm` | integration | POST `/dm` with target user → 201 with dm_channel_id. |
| API-055 | `create_dm_idempotent` | integration | Same user pair twice → same dm_channel_id. |
| API-056 | `list_dms` | integration | Create 3 DMs → GET → all 3. |
| API-057 | `dm_policy_nobody` | integration | User B sets `nobody`. User A creates DM with B → 403. |
| API-058 | `dm_policy_mutual_servers` | integration | B sets `mutual_servers_only`. A (no shared server) → 403. A joins B's server → 201. |

#### 2.2.9 User Controls

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-059 | `block_user` | integration | PUT block → 200. GET blocks → user in list. |
| API-060 | `unblock_user` | integration | Block then unblock → removed from list. |
| API-061 | `block_prevents_dm` | integration | A blocks B. B creates DM with A → 403 or silent failure. |
| API-062 | `set_dm_policy` | integration | PUT `mutual_servers_only` → 200. Policy persisted. |

#### 2.2.10 Moderation

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-063 | `owner_bans_user` | integration | Owner bans C → 200. C in ban list. |
| API-064 | `moderator_bans_user` | integration | Owner promotes B. B bans C → 200. |
| API-065 | `regular_member_cannot_ban` | integration | Non-mod bans → 403. |
| API-066 | `moderator_cannot_ban_owner` | integration | Mod bans owner → 403. |
| API-067 | `moderator_cannot_promote` | integration | Mod promotes → 403. |
| API-068 | `owner_promotes_moderator` | integration | Owner promotes → `is_moderator = true`. |
| API-069 | `owner_demotes_moderator` | integration | Owner demotes → `is_moderator = false`. |
| API-070 | `kick_user` | integration | Owner kicks → user removed from server_members. |
| API-071 | `channel_mute_user` | integration | Mod mutes → 200. |
| API-072 | `unban_user` | integration | Ban then unban → removed from list. |
| API-073 | `audit_log_populated` | integration | Several mod actions → GET audit log → all present with actor, target, timestamps. |
| API-074 | `moderator_cannot_delete_server` | integration | Mod DELETE `/servers/:id` → 403. |

#### 2.2.11 Reporting

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-075 | `submit_report` | integration | POST `/reports` with category + description → 201. |
| API-076 | `submit_report_with_evidence` | integration | POST with `evidence_blob` → 201, blob stored. |
| API-077 | `list_reports` | integration | 3 reports → owner GET → all 3. |
| API-078 | `review_report` | integration | Submit, owner PATCHes `actioned` → status updated, `reviewed_by`/`reviewed_at` set. |
| API-079 | `non_mod_cannot_view_reports` | integration | Regular member GET reports → 403. |
| API-080 | `report_invalid_category` | integration | `category: 'invalid'` → 400. |

#### 2.2.12 Abuse Signals

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-081 | `list_abuse_signals` | integration | Insert signals → GET → present. |
| API-082 | `mark_signal_reviewed` | integration | PATCH reviewed=true → 200. |

#### 2.2.13 Health & Metrics (Phase 10)

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| API-083 | `health_check_all_healthy` | integration | All services up → 200, all "connected"/"reachable". |
| API-084 | `health_check_db_down` | integration | Postgres down → 200 with `"database": "unreachable"`. |
| API-085 | `health_check_includes_uptime` | integration | `uptime_seconds` is positive number. |
| API-086 | `metrics_endpoint_format` | integration | GET `/metrics` → 200, Prometheus format, contains `mercury_connected_clients`. |
| API-087 | `metrics_no_auth_required` | integration | GET `/metrics` without auth → 200 (not 401). |
| API-088 | `metrics_request_duration_recorded` | integration | 5 REST requests → `mercury_api_request_duration_seconds_count ≥ 5`. |
| API-089 | `hsts_header_present` | integration | Any request → `Strict-Transport-Security` header, `max-age ≥ 31536000`. |

### 2.3 WebSocket Protocol

Location: `src/server/tests/websocket/`

Test harness: `tokio-tungstenite` WebSocket clients.

#### 2.3.1 Connection Lifecycle

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-001 | `connect_valid_jwt` | integration | `/ws?token={valid}` → HTTP 101 upgrade. |
| WS-002 | `connect_invalid_jwt` | integration | Garbage token → rejected (401 or close). |
| WS-003 | `connect_expired_jwt` | integration | Expired token → rejected. |
| WS-004 | `identify_returns_ready` | integration | Send `identify` → receive `READY` with `user`, `servers`, `dm_channels`, `session_id`. |
| WS-005 | `heartbeat_ack` | integration | Send `heartbeat` → receive `HEARTBEAT_ACK`. |
| WS-006 | `heartbeat_timeout_disconnect` | integration | Connect, don't heartbeat → server disconnects after ~45s. |
| WS-007 | `resume_after_disconnect` | integration | Connect+identify (note session_id/seq). Disconnect. Reconnect, send `resume` → `RESUMED` with replayed count. |
| WS-008 | `resume_expired_session` | integration | Disconnect, wait for session expiry. Resume → fails, must re-identify. |

#### 2.3.2 Messaging

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-009 | `message_send_standard` | integration | A sends JSON `message_send` (plaintext). B receives `MESSAGE_CREATE` with content. |
| WS-010 | `message_send_e2e_msgpack` | integration | A sends binary (MessagePack) `message_send`. Frame accepted. B receives binary `MESSAGE_CREATE`. |
| WS-011 | `typing_start_relay` | integration | A sends `typing_start`. B receives `TYPING_START` with correct channel/user. |

#### 2.3.3 Presence

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-012 | `presence_online_broadcast` | integration | A connects → B receives `PRESENCE_UPDATE` status=online. |
| WS-013 | `presence_offline_debounce` | integration | A disconnects → B does NOT see offline immediately. Wait 16s → B sees offline. |
| WS-014 | `presence_resume_cancels_offline` | integration | A disconnects. Within 10s, A resumes → B never sees offline. |

#### 2.3.4 Voice & Signaling

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-015 | `voice_state_update_relay` | integration | A sends `voice_state_update` to join → B receives event. |
| WS-016 | `webrtc_signal_relay` | integration | A sends `webrtc_signal` targeting B → B receives with `from_user = A`. |
| WS-017 | `call_config_on_join` | integration | Join call → receive `CALL_CONFIG` with `turn_urls`, `username`, `credential`, `ttl`. |

#### 2.3.5 Rate Limiting

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-018 | `message_rate_limit` | integration | 11 messages in 1s → first 10 ok, 11th rejected. |
| WS-019 | `ws_upgrade_rate_limit` | integration | 201+ upgrades rapidly → some return 503 with `Retry-After`. |

#### 2.3.6 Moderation Enforcement

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-020 | `banned_user_rejected` | integration | Ban user. User identifies → messages to that server rejected. |
| WS-021 | `muted_user_rejected` | integration | Mute user in channel. `message_send` to channel → rejected with error code. |
| WS-022 | `blocked_user_msg_dropped` | integration | A blocks B. B sends DM to A → B gets ack, A gets nothing. |

#### 2.3.7 Membership Events

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-023 | `member_add_on_join` | integration | B joins server → connected members receive `MEMBER_ADD`. |
| WS-024 | `member_remove_on_leave` | integration | B leaves → `MEMBER_REMOVE` broadcast. |

#### 2.3.8 Key & Device Events

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-025 | `key_bundle_update_event` | integration | A updates keys → users with sessions see `KEY_BUNDLE_UPDATE`. |
| WS-026 | `device_list_update_event` | integration | A uploads device list → `DEVICE_LIST_UPDATE` broadcast. |

#### 2.3.9 Moderation Events

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-027 | `ban_event_broadcast` | integration | Owner bans C → `USER_BANNED` broadcast + C disconnected. |
| WS-028 | `kick_event_broadcast` | integration | Owner kicks C → `USER_KICKED` + C disconnected. |
| WS-029 | `report_event_owner_only` | integration | User reports → owner receives `REPORT_CREATED`. Regular members do NOT. |
| WS-030 | `abuse_signal_event_owner_only` | integration | Abuse signal → owner receives `ABUSE_SIGNAL`. Others do NOT. |

#### 2.3.10 READY Payload

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WS-031 | `ready_populates_servers` | integration | User in 3 servers with channels. Identify → `READY` contains all 3 servers with channels. |

---

## 3. Client Unit Tests

Infrastructure: None. Vitest.

### 3.1 Crypto Engine

Location: `src/client/src/worker/crypto/__tests__/`

All tests use real crypto implementations, not mocks.

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| CC-001 | `generate_identity_keypair` | unit | Ed25519 keypair: public and private keys are 32 bytes, different from each other. |
| CC-002 | `generate_device_identity_keypair` | unit | X25519 keypair: correct lengths. |
| CC-003 | `generate_signed_prekey` | unit | Signed prekey signature verifies with device identity key. |
| CC-004 | `generate_otp_batch_100` | unit | 100 OTPs: all unique key_ids, all valid X25519 public keys. |
| CC-005 | `x3dh_shared_secret` | unit | Alice and Bob X3DH → both derive same shared secret. |
| CC-006 | `x3dh_without_otp` | unit | X3DH without one-time prekey → still succeeds (fallback). |
| CC-007 | `x3dh_wrong_identity_fails` | unit | X3DH with fake identity key → mismatch detected. |
| CC-008 | `ratchet_encrypt_decrypt_10` | unit | Alice sends 10 messages → Bob decrypts all 10 → correct plaintext. |
| CC-009 | `ratchet_bidirectional` | unit | A sends 3, B replies 3, A sends 3 → all decrypt correctly both sides. |
| CC-010 | `ratchet_out_of_order` | unit | Deliver messages 1,3,5,2,4 → all 5 decrypt (skipped keys). |
| CC-011 | `ratchet_skipped_key_limit` | unit | 1001 messages unread → skipped key buffer doesn't exceed 1000. |
| CC-012 | `ratchet_forward_secrecy` | unit | Decrypt message. Old key cannot decrypt new message. |
| CC-013 | `ratchet_state_persistence` | unit | Encrypt, serialize state, deserialize, encrypt again → second decrypts correctly. |
| CC-014 | `sender_key_group_encrypt_decrypt` | unit | Distribute SenderKey to B and C. A encrypts → B and C decrypt. |
| CC-015 | `sender_key_chain_ratchet` | unit | 5 messages → each uses different key (chain advances). All decrypt. |
| CC-016 | `sender_key_rotation_on_removal` | unit | Remove C. A generates new key (new epoch). B decrypts. C's old key fails on new epoch. |
| CC-017 | `sender_key_epoch_validation` | unit | Message with epoch=2 to recipient with only epoch=1 → epoch mismatch error. |
| CC-018 | `sender_key_lazy_rotation` | unit | Remove member (epoch increments). Next *send* (not removal) triggers new key + distribution. |
| CC-019 | `sender_key_max_100` | unit | Distribute to 101 recipients → rejected. |
| CC-020 | `recovery_key_generation` | unit | Recovery key = 24 BIP-39 words. Re-encode words → same 256-bit key. |
| CC-021 | `backup_encrypt_decrypt` | unit | Encrypt backup with recovery key. Decrypt with same key → original matches. |
| CC-022 | `backup_wrong_key_fails` | unit | Encrypt with key A. Decrypt with key B → decryption error. |
| CC-023 | `backup_blob_contents` | unit | Backup contains: master verify key, device identity key, session states, sender keys. |
| CC-024 | `device_list_sign_verify` | unit | Sign device list. Verify → success. |
| CC-025 | `device_list_tamper_detection` | unit | Sign list. Modify one entry. Verify → failure. |
| CC-026 | `safety_number_symmetric` | unit | `safety_number(A, B) == safety_number(B, A)`. |
| CC-027 | `safety_number_changes_on_key_change` | unit | Different user key → different safety number. |
| CC-028 | `media_frame_encrypt_decrypt` | unit | Encrypt mock audio frame. Decrypt → original matches. |
| CC-029 | `media_epoch_tagging` | unit | Frames at epoch=1. Rotate (epoch=2). New frames have epoch=2 byte. |
| CC-030 | `media_key_ring_rotation` | unit | Set key epoch=0. Rotate to epoch=1. `getKey(0)` returns old (within 5s). After 6s → null. `getKey(1)` → current. |
| CC-031 | `media_key_unknown_epoch` | unit | `getKey(99)` on fresh ring → null. |

### 3.2 Key Store (SQLite)

Location: `src/client/src/worker/store/__tests__/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| KS-001 | `open_correct_password` | unit | Create keystore. Close. Reopen with same key → success. |
| KS-002 | `open_wrong_password_fails` | unit | Create keystore. Reopen wrong key → failure (not plaintext fallback). |
| KS-003 | `store_retrieve_identity_key` | unit | Store master verify keypair → retrieve → match. |
| KS-004 | `store_retrieve_device_key` | unit | Store device keypair by device_id → retrieve → match. |
| KS-005 | `store_retrieve_prekeys` | unit | Store 100 OTPs. Retrieve by key_id. Mark one used → 99 available. |
| KS-006 | `session_crud` | unit | Store session for (userId, deviceId) → retrieve → update → retrieve → updated. |
| KS-007 | `sender_key_crud` | unit | Store SenderKey for (channelId, userId, deviceId) → retrieve → match. |
| KS-008 | `export_import_backup` | unit | Store keys/sessions. Export blob. New keystore. Import → all data restored. |
| KS-009 | `messages_db_store_retrieve` | unit | Store E2E message → retrieve by channel_id → content matches. |
| KS-010 | `messages_db_pagination` | unit | 50 messages → retrieve limit=20 → correct count + cursor. |
| KS-011 | `messages_db_encrypted_at_rest` | unit | Write messages. Raw file bytes do NOT contain plaintext content. |

### 3.3 WebSocket Manager

Location: `src/client/src/renderer/services/__tests__/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| WSM-001 | `connect_and_identify` | unit | Mock WS. `connect()` → `identify` sent. Simulate READY → state=CONNECTED. |
| WSM-002 | `heartbeat_interval` | unit | Connected → heartbeats sent every ~30s (verify over 3 cycles). |
| WSM-003 | `reconnect_on_close` | unit | Simulate close → reconnection attempted after backoff. |
| WSM-004 | `exponential_backoff` | unit | Delays: 1s → 2s → 4s → ... → 120s max. |
| WSM-005 | `backoff_jitter` | unit | 100 calculations → variance exists (not all identical). |
| WSM-006 | `extended_base_after_5s` | unit | Disconnect >5s → next reconnect starts at 5s base. |
| WSM-007 | `retry_after_respected` | unit | 503 with `Retry-After: 15` → next delay is 15s. |
| WSM-008 | `resume_before_identify` | unit | Reconnect → first op is `resume`. If resume fails → `identify`. |
| WSM-009 | `event_dispatch_typed` | unit | Register listener for `MESSAGE_CREATE`. Simulate event → listener called with typed data. |
| WSM-010 | `msgpack_binary_decode` | unit | Binary frame → decoded as MessagePack → dispatched correctly. |
| WSM-011 | `json_text_decode` | unit | Text frame → parsed as JSON → dispatched. |
| WSM-012 | `send_message_as_msgpack` | unit | `send('message_send', ...)` → binary frame sent (not text). |
| WSM-013 | `send_control_as_json` | unit | `send('heartbeat', ...)` → text frame sent. |

### 3.4 Zustand Stores

Location: `src/client/src/renderer/stores/__tests__/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| ST-001 | `auth_login` | unit | `login()` → `isAuthenticated=true`, `user` and `accessToken` set. |
| ST-002 | `auth_logout` | unit | Login then logout → state resets. |
| ST-003 | `auth_refresh_on_401` | unit | 401 → refresh → retry → token updated transparently. |
| ST-004 | `server_fetch` | unit | API returns 3 servers → `servers` map has 3. |
| ST-005 | `server_create` | unit | `createServer()` → server added to map. |
| ST-006 | `server_join` | unit | `joinServer(invite)` → server added. |
| ST-007 | `server_active_selection` | unit | Set `activeServerId` → channels loaded for that server. |
| ST-008 | `message_send_standard` | unit | Standard channel → WS `message_send` called with plaintext. |
| ST-009 | `message_send_e2e` | unit | E2E channel → crypto worker `encryptMessage` called, WS sends ciphertext. |
| ST-010 | `message_receive_standard` | unit | `MESSAGE_CREATE` for standard → message in map. |
| ST-011 | `message_receive_e2e` | unit | Encrypted `MESSAGE_CREATE` → `decryptMessage` called → plaintext in map. |
| ST-012 | `message_history_standard` | unit | `fetchHistory()` standard → API called → messages populated. |
| ST-013 | `message_history_e2e` | unit | `fetchHistory()` E2E → local messages.db first, then server for new ciphertexts. |
| ST-014 | `presence_update` | unit | `PRESENCE_UPDATE` → `presences` map updated. |
| ST-015 | `call_join_leave` | unit | `joinCall()` → `activeCall` set. `leaveCall()` → cleared. |
| ST-016 | `call_toggle_mute` | unit | `toggleMute()` → `isMuted` flips. |
| ST-017 | `moderation_block` | unit | `blockUser()` → user in `blockedUserIds`. |
| ST-018 | `moderation_submit_report` | unit | `submitReport()` → API called with correct payload. |
| ST-019 | `moderation_fetch_reports` | unit | API returns reports → `reports` map populated. |
| ST-020 | `moderation_ban` | unit | `banUser()` → API called, `bans` map updated. |

### 3.5 REST API Client

Location: `src/client/src/renderer/services/__tests__/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| RC-001 | `injects_auth_header` | unit | Request via client → `Authorization: Bearer <token>` present. |
| RC-002 | `auto_refresh_on_401` | unit | 401 → refresh → retry with new token → success. |
| RC-003 | `refresh_failure_logs_out` | unit | 401 on request + 401 on refresh → user logged out. |

---

## 4. Client Integration Tests

Infrastructure: Crypto worker running, mock or real API as needed.

Location: `src/client/tests/integration/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| CI-001 | `crypto_worker_lifecycle` | integration | Spawn worker. Send ping via MessagePort → pong response. |
| CI-002 | `initialize_identity` | integration | `initializeIdentity()` via IPC → returns master verify key, device ID, identity key, signed prekey, 100 OTPs, signed device list. All non-empty. |
| CI-003 | `x3dh_session_via_worker` | integration | Alice worker inits + uploads bundle. Bob worker fetches bundle + X3DH. Bob encrypts → Alice decrypts → plaintext matches. |
| CI-004 | `dm_flow_via_stores` | integration | Two users' stores + workers. A sends DM (X3DH + Double Ratchet). B receives + decrypts → correct. |
| CI-005 | `private_channel_flow` | integration | 3 users. A sends (Sender Key) → B+C decrypt. Remove C. A sends → B decrypts, C fails. |
| CI-006 | `message_persistence_restart` | integration | Send E2E messages → in messages.db. Destroy in-memory state. Reload from DB → messages restored. |
| CI-007 | `ipc_no_private_key_leak` | integration | Multiple IPC calls from renderer side. No response contains raw private key bytes. |
| CI-008 | `media_key_via_session` | integration | A generates media key → encrypts to B via Double Ratchet. B decrypts. Both configure MediaKeyRing. Both encrypt/decrypt mock frames. |

---

## 5. End-to-End Tests

Infrastructure: Full stack (server + Postgres + Redis + Electron). Playwright.

Location: `src/client/tests/e2e/`

### 5.1 Auth & Onboarding

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| E2E-001 | `register_and_login` | e2e | Register → main UI. Close, relaunch → login → main UI. |
| E2E-002 | `register_shows_recovery_key` | e2e | Register → recovery mnemonic displayed (24 words). Must acknowledge before proceeding. |
| E2E-003 | `login_wrong_password` | e2e | Wrong password → error message displayed. |
| E2E-004 | `session_persistence` | e2e | Login → close (not logout) → relaunch → auto-login. |
| E2E-005 | `logout_clears_session` | e2e | Logout → login screen. Relaunch → login screen. |

### 5.2 Servers & Channels

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| E2E-006 | `create_server` | e2e | Create server → appears in sidebar. |
| E2E-007 | `join_by_invite` | e2e | A creates server. B enters invite → server in B's sidebar. |
| E2E-008 | `create_standard_channel` | e2e | Standard channel → in channel list, no lock icon. |
| E2E-009 | `create_private_channel` | e2e | Private channel → 🔒 lock icon. |
| E2E-010 | `leave_server` | e2e | Leave → server removed from sidebar. |
| E2E-011 | `delete_server` | e2e | Owner deletes → disappears for all. |

### 5.3 Standard Messaging

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| E2E-012 | `send_receive_standard` | e2e | A sends in standard channel → B sees it real-time. |
| E2E-013 | `history_standard` | e2e | 5 messages → close → reopen → all visible (fetched from server). |
| E2E-014 | `typing_indicator` | e2e | A types → B sees indicator. A stops → indicator gone. |

### 5.4 E2E Messaging

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| E2E-015 | `dm_encrypted` | e2e | A DMs B "hello" → B sees "hello". DB: `messages.content IS NULL`, `ciphertext` non-empty blob. |
| E2E-016 | `dm_bidirectional` | e2e | A→B, B→A → both correct. |
| E2E-017 | `dm_history_local` | e2e | DM messages → close → reopen → visible (from local messages.db). |
| E2E-018 | `private_channel_group` | e2e | A, B, C in private channel. A sends → B and C see decrypted. |
| E2E-019 | `private_channel_rotation` | e2e | Remove C. A sends → B sees. C cannot decrypt (new epoch). |
| E2E-020 | `private_channel_no_history_for_joiner` | e2e | A sends 5 msgs. D joins → D sees only post-join messages. |
| E2E-021 | `encryption_badges` | e2e | Standard: no badge. Private: 🔒. DM: 🛡️. |
| E2E-022 | `server_blind_to_e2e` | e2e | Send E2E DM. Query Postgres: `messages.content IS NULL`, `ciphertext` is opaque. |

### 5.5 Voice & Video

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| E2E-023 | `join_voice` | e2e | A joins → voice panel shows A's name. |
| E2E-024 | `two_users_voice` | e2e | A+B join → both in participant list. No errors/crashes. |
| E2E-025 | `mute_unmute` | e2e | Mute → icon. Unmute → icon gone. |
| E2E-026 | `deafen` | e2e | Deafen → both mute + deafen icons. |
| E2E-027 | `leave_voice` | e2e | Leave → removed from list. |
| E2E-028 | `key_rotation_on_join` | e2e | A+B in call. C joins → key_epoch increments. |
| E2E-029 | `key_rotation_on_leave` | e2e | A+B+C in call. C leaves → key_epoch increments. |

### 5.6 Moderation

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| E2E-030 | `owner_bans_user` | e2e | Owner bans C → C disconnected, cannot rejoin. |
| E2E-031 | `moderator_bans` | e2e | Owner promotes B. B bans C → C disconnected. |
| E2E-032 | `moderator_cannot_promote` | e2e | B (mod) promotes another → fails or button absent. |
| E2E-033 | `block_user` | e2e | A blocks B → B's messages hidden for A. B sees no indication. |
| E2E-034 | `report_standard_verified` | e2e | Report in standard channel → dashboard shows "Verified". |
| E2E-035 | `report_e2e_unverified` | e2e | Report in E2E channel → dashboard shows "Unverified" banner. |
| E2E-036 | `audit_log` | e2e | Ban + kick + mute → audit log has all entries. |

### 5.7 Recovery

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| E2E-037 | `full_recovery_flow` | e2e | Register → save recovery key → exchange E2E msgs → delete local data → restore → login → send new E2E msg. |
| E2E-038 | `recovery_wrong_mnemonic` | e2e | Wrong 24 words → clear error, no crash. |
| E2E-039 | `recovery_no_backup` | e2e | No backup on server → clear error. |

### 5.8 Resilience

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| E2E-040 | `reconnect_after_restart` | e2e | Server restart → client reconnects automatically. |
| E2E-041 | `missed_messages_on_reconnect` | e2e | A offline. B sends. A reconnects → A gets messages. |
| E2E-042 | `reconnecting_ui_state` | e2e | Kill server → "Reconnecting..." shown. Restart → normal state. |

---

## 6. Security Tests

These verify security invariants. Any failure is a vulnerability.

Location: `src/server/tests/security/` and `src/client/tests/security/`

| ID | Name | Tier | Assertion |
|----|------|------|-----------|
| SEC-001 | `no_plaintext_in_e2e_messages` | security | All messages where `channel.encryption_mode != 'standard'` have `content IS NULL`. |
| SEC-002 | `no_private_keys_on_server` | security | `device_identity_keys` and `one_time_prekeys` contain only public keys. |
| SEC-003 | `otp_atomic_claim` | security | Two concurrent claims for same OTP → only one succeeds. |
| SEC-004 | `rate_limit_header_spoofing` | security | Spoofed `X-Forwarded-For` → rate limit still applied to real IP. |
| SEC-005 | `sql_injection_rejected` | security | Username `"'; DROP TABLE users;--"` → rejected or safely parameterized (table still exists). |
| SEC-006 | `jwt_algorithm_confusion` | security | JWT signed HMAC with public key → validation rejects. |
| SEC-007 | `electron_no_node_in_renderer` | security | `require('fs')` in renderer → ReferenceError. |
| SEC-008 | `electron_context_isolation` | security | `window.process` undefined in renderer. |
| SEC-009 | `csp_blocks_inline_script` | security | Injected `<script>` in renderer → blocked by CSP. |
| SEC-010 | `no_wildcard_ipc` | security | Preload script: no generic `ipcRenderer.send(channel)` with variable channel. All hardcoded. |
| SEC-011 | `blocked_user_no_presence` | security | A blocks B → B does not receive A's presence updates. |
| SEC-012 | `blocked_user_silent_drop` | security | B messages A (blocked) → B gets normal ack, A gets nothing. |
| SEC-013 | `banned_user_ws_rejected` | security | Banned user WS connect → rejected or identify fails for that server. |
| SEC-014 | `sender_key_epoch_enforced` | security | `message_send` with stale epoch for private channel → server rejects. |
| SEC-015 | `encryption_mode_immutable` | security | PATCH channel `encryption_mode` → 400 or field ignored. |

---

## 7. Performance Benchmarks

Not pass/fail. Measure and report against targets.

Location: `src/server/benches/` and `src/client/tests/performance/`

| ID | Name | Tier | Target | Method |
|----|------|------|--------|--------|
| PERF-001 | `message_decrypt_time` | bench | < 5ms | Decrypt 100 messages, report avg + p99. |
| PERF-002 | `message_encrypt_time` | bench | < 200ms | Encrypt for 1 device, time crypto worker call. |
| PERF-003 | `sender_key_rotation_99` | bench | < 3s | Lazy rotation with 99 mock sessions, time total. |
| PERF-004 | `app_launch_to_login` | bench | < 3s | Process spawn → `DOMContentLoaded` + login form visible. |
| PERF-005 | `memory_idle_5_servers` | bench | < 300 MB | Load 5 servers mock data, wait 10s, read `rss`. |
| PERF-006 | `bundle_size` | bench | < 200 MB | Build, measure unpacked `dist/` size. |
| PERF-007 | `jwt_validation_throughput` | bench | > 10k/s | Validate 10k JWTs, report ops/sec. |
| PERF-008 | `message_history_query` | bench | < 50ms | Paginated query from 10k-message table. |
| PERF-009 | `x3dh_handshake_time` | bench | < 50ms | 100 X3DH handshakes, report avg. |
