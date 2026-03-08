# Mercury Test Audit

Generated: 2026-03-07
Total specs: 345
PASS: 275 | PARTIAL: 22 | STUB: 0 | MISSING: 42 | BLOCKED: 6

---

## Gaps

### BLOCKED

These tests cannot be written because the underlying crate has no production code.

| Spec ID | Name | Reason |
|---------|------|--------|
| CRYPTO-001 | `key_bundle_type_serialization` | mercury-crypto is a stub crate (no production code) |
| CRYPTO-002 | `signed_device_list_verification` | mercury-crypto is a stub crate |
| CRYPTO-003 | `signed_device_list_tampered_fails` | mercury-crypto is a stub crate |
| CRYPTO-004 | `signed_device_list_wrong_key_fails` | mercury-crypto is a stub crate |
| CRYPTO-005 | `key_upload_signature_validation` | mercury-crypto is a stub crate |
| CRYPTO-006 | `backup_blob_validation` | mercury-crypto is a stub crate |

### MISSING

| Spec ID | Name | File Where It Should Live |
|---------|------|--------------------------|
| KS-011 | `messages_db_encrypted_at_rest` | `src/client/tests/unit/store/messages.test.ts` |
| WSM-002 | `heartbeat_interval` | `src/client/tests/unit/services/websocket.test.ts` |
| WSM-006 | `extended_base_after_5s` | `src/client/tests/unit/services/websocket.test.ts` |
| WSM-007 | `retry_after_respected` | `src/client/tests/unit/services/websocket.test.ts` |
| WSM-008 | `resume_before_identify` | `src/client/tests/unit/services/websocket.test.ts` |
| WSM-009 | `event_dispatch_typed` | `src/client/tests/unit/services/websocket.test.ts` |
| WSM-013 | `send_control_as_json` | `src/client/tests/unit/services/websocket.test.ts` |
| ST-003 | `auth_refresh_on_401` | `src/client/tests/unit/stores/authStore.test.ts` |
| CI-002 | `initialize_identity` | `src/client/tests/integration/worker.test.ts` |
| CI-003 | `x3dh_session_via_worker` | `src/client/tests/integration/worker.test.ts` |
| CI-004 | `dm_flow_via_stores` | `src/client/tests/integration/worker.test.ts` |
| CI-005 | `private_channel_flow` | `src/client/tests/integration/worker.test.ts` |
| CI-006 | `message_persistence_restart` | `src/client/tests/integration/worker.test.ts` |
| CI-007 | `ipc_no_private_key_leak` | `src/client/tests/integration/worker.test.ts` |
| CI-008 | `media_key_via_session` | `src/client/tests/integration/worker.test.ts` |
| E2E-002 | `register_shows_recovery_key` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-003 | `login_wrong_password` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-004 | `session_persistence` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-005 | `logout_clears_session` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-007 | `join_by_invite` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-009 | `create_private_channel` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-010 | `leave_server` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-011 | `delete_server` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-013 | `history_standard` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-014 | `typing_indicator` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-017 | `dm_history_local` | `src/client/tests/e2e/flows/dm-messaging.test.ts` |
| E2E-020 | `private_channel_no_history_for_joiner` | `src/client/tests/e2e/flows/private-channel.test.ts` |
| E2E-021 | `encryption_badges` | `src/client/tests/e2e/flows/private-channel.test.ts` |
| E2E-022 | `server_blind_to_e2e` | `src/client/tests/e2e/flows/dm-messaging.test.ts` |
| E2E-025 | `mute_unmute` | `src/client/tests/e2e/flows/voice-channel.test.ts` |
| E2E-026 | `deafen` | `src/client/tests/e2e/flows/voice-channel.test.ts` |
| E2E-027 | `leave_voice` | `src/client/tests/e2e/flows/voice-channel.test.ts` |
| E2E-032 | `moderator_cannot_promote` | `src/client/tests/e2e/flows/moderation.test.ts` |
| E2E-033 | `block_user` | `src/client/tests/e2e/flows/moderation.test.ts` |
| E2E-036 | `audit_log` | `src/client/tests/e2e/flows/moderation.test.ts` |
| E2E-038 | `recovery_wrong_mnemonic` | `src/client/tests/e2e/flows/recovery-flow.test.ts` |
| E2E-039 | `recovery_no_backup` | `src/client/tests/e2e/flows/recovery-flow.test.ts` |
| E2E-040 | `reconnect_after_restart` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-041 | `missed_messages_on_reconnect` | `src/client/tests/e2e/flows/smoke.test.ts` |
| E2E-042 | `reconnecting_ui_state` | `src/client/tests/e2e/flows/smoke.test.ts` |
| PERF-006 | `bundle_size` | `src/client/tests/performance/bundle.test.ts` |
| PERF-008 | `message_history_query` | `src/server/benches/server_benchmarks.rs` |

### PARTIAL

| Spec ID | Name | Existing File | What's Missing |
|---------|------|---------------|----------------|
| DB-002 | `user_crud` | `src/server/tests/milestone_1.rs` | Create tested via register, but full read-by-ID → update → delete cycle not tested |
| DB-005 | `server_crud` | `src/server/tests/phase_5.rs` | Create/read/update/delete tested individually, but cascade delete of channels/members not verified |
| DB-008 | `channel_encryption_mode_immutable` | `src/server/tests/milestone_1.rs` | Tests creation constraint (rejects invalid modes) but not update immutability (standard → private rejected) |
| DB-009 | `channel_private_max_members_100` | `src/server/tests/milestone_1.rs` | Tests max_members CHECK constraint but may not test exactly 101 vs 100 boundary |
| DB-016 | `dm_channel_crud` | `src/server/tests/phase_8.rs` | DM created in call test but not full CRUD (create → add members → count → list for user) |
| API-015 | `get_users_me_invalid_token` | `src/server/tests/milestone_1.rs` | Tests expired token → 401 but not garbage/random Bearer token |
| API-030 | `create_channel_private` | `src/server/tests/phase_5.rs` | Standard channel tested explicitly; private mode creation may not verify `max_members ≤ 100` |
| API-034 | `encryption_mode_in_response` | `src/server/tests/phase_5.rs` | Channel response tested but `encryption_mode` field presence not explicitly asserted |
| API-048 | `delete_device_cascades_keys` | `src/server/tests/phase_6b.rs` | Device deletion tested but key cascade (keys also deleted) not verified after delete |
| API-076 | `submit_report_with_evidence` | `src/server/tests/phase_9b.rs` | Report creation tested but `evidence_blob` field not explicitly tested |
| SEC-013 | `banned_user_ws_rejected` | `src/server/tests/security_tests.rs` | Tests banned user message rejection, but does not verify WS identify itself fails for the banned server |
| WS-025 | `key_bundle_update_event` | `src/server/tests/ws_tests.rs` | Test exists but KEY_BUNDLE_UPDATE broadcast not yet wired up in REST handler; test documents current behavior |
| WS-026 | `device_list_update_event` | `src/server/tests/ws_tests.rs` | Test exists but DEVICE_LIST_UPDATE broadcast not yet wired up in REST handler; test documents current behavior |
| WS-030 | `abuse_signal_event_owner_only` | `src/server/tests/ws_tests.rs` | Test exists but abuse detector may not trigger within test window (background timer); owner assertion conditional |
| WSM-001 | `connect_and_identify` | `src/client/tests/unit/services/websocket.test.ts` | WebSocket manager tested for backoff but connect+identify flow not fully covered |
| WSM-003 | `reconnect_on_close` | `src/client/tests/unit/services/websocket.test.ts` | Reconnection logic tested via backoff but close-event → reconnect trigger not explicit |
| WSM-012 | `send_message_as_msgpack` | `src/client/tests/unit/services/msgpack-framing.test.ts` | MessagePack encode/decode tested but send-via-WS-as-binary not verified |
| ST-014 | `presence_update` | `src/client/tests/unit/stores/moderation-ws-events.test.ts` | Presence tested in blocking context but base `PRESENCE_UPDATE → presences map` not explicit |
| PERF-001 | `message_decrypt_time` | `src/client/tests/performance/benchmarks.test.ts` | Crypto benchmarks exist but may not assert < 5ms target or report avg + p99 |
| PERF-002 | `message_encrypt_time` | `src/client/tests/performance/benchmarks.test.ts` | Encryption benchmark exists but < 200ms target assertion may be missing |
| PERF-003 | `sender_key_rotation_99` | `src/client/tests/performance/benchmarks.test.ts` | Sender key benchmark exists but 99-session rotation with < 3s target may not be tested |
| PERF-009 | `x3dh_handshake_time` | `src/client/tests/performance/benchmarks.test.ts` | X3DH benchmark exists but 100-handshake avg with < 50ms target may not be tested |

### STUB

(none)

### PASS

CORE-001, CORE-002, CORE-003, CORE-004, CORE-005, CORE-006, CORE-007, CORE-008, AUTH-001, AUTH-002, AUTH-003, AUTH-004, AUTH-005, AUTH-006, AUTH-007, AUTH-008, AUTH-009, AUTH-010, AUTH-011, MOD-001, MOD-002, MOD-003, MOD-004, MOD-005, MOD-006, MOD-007, MOD-008, MOD-009, MOD-010, MOD-011, MOD-012, MEDIA-001, MEDIA-002, MEDIA-003, MEDIA-004, MEDIA-005, MEDIA-006, DB-001, DB-003, DB-004, DB-006, DB-007, DB-010, DB-011, DB-012, DB-013, DB-014, DB-015, DB-017, DB-018, DB-019, DB-020, DB-021, DB-022, DB-023, DB-024, DB-025, DB-026, DB-027, DB-028, DB-029, DB-030, API-001, API-002, API-003, API-004, API-005, API-006, API-007, API-008, API-009, API-010, API-011, API-012, API-013, API-014, API-016, API-017, API-018, API-019, API-020, API-021, API-022, API-023, API-024, API-025, API-026, API-027, API-028, API-029, API-031, API-032, API-033, API-035, API-036, API-037, API-038, API-039, API-040, API-041, API-042, API-043, API-044, API-045, API-046, API-047, API-049, API-050, API-051, API-052, API-053, API-054, API-055, API-056, API-057, API-058, API-059, API-060, API-061, API-062, API-063, API-064, API-065, API-066, API-067, API-068, API-069, API-070, API-071, API-072, API-073, API-074, API-075, API-077, API-078, API-079, API-080, API-081, API-082, API-083, API-084, API-085, API-086, API-087, API-088, API-089, WS-001, WS-002, WS-003, WS-004, WS-005, WS-006, WS-007, WS-008, WS-009, WS-010, WS-011, WS-012, WS-013, WS-014, WS-015, WS-016, WS-017, WS-018, WS-019, WS-020, WS-021, WS-022, WS-023, WS-024, WS-027, WS-028, WS-029, WS-031, SEC-001, SEC-002, SEC-003, SEC-004, SEC-005, SEC-006, SEC-007, SEC-008, SEC-009, SEC-010, SEC-011, SEC-012, SEC-014, SEC-015, CC-001, CC-002, CC-003, CC-004, CC-005, CC-006, CC-007, CC-008, CC-009, CC-010, CC-011, CC-012, CC-013, CC-014, CC-015, CC-016, CC-017, CC-018, CC-019, CC-020, CC-021, CC-022, CC-023, CC-024, CC-025, CC-026, CC-027, CC-028, CC-029, CC-030, CC-031, KS-001, KS-002, KS-003, KS-004, KS-005, KS-006, KS-007, KS-008, KS-009, KS-010, WSM-004, WSM-005, WSM-010, WSM-011, ST-001, ST-002, ST-004, ST-005, ST-006, ST-007, ST-008, ST-009, ST-010, ST-011, ST-012, ST-013, ST-015, ST-016, ST-017, ST-018, ST-019, ST-020, RC-001, RC-002, RC-003, CI-001, E2E-001, E2E-006, E2E-008, E2E-012, E2E-015, E2E-016, E2E-018, E2E-019, E2E-023, E2E-024, E2E-028, E2E-029, E2E-030, E2E-031, E2E-034, E2E-035, E2E-037, PERF-004, PERF-005, PERF-007

---

## Coverage by Category

| Category | Total | PASS | PARTIAL | STUB | MISSING | BLOCKED |
|----------|-------|------|---------|------|---------|---------|
| CORE (server unit) | 8 | 8 | 0 | 0 | 0 | 0 |
| AUTH (server unit) | 11 | 11 | 0 | 0 | 0 | 0 |
| CRYPTO (server unit) | 6 | 0 | 0 | 0 | 0 | 6 |
| MOD (server unit) | 12 | 12 | 0 | 0 | 0 | 0 |
| MEDIA (server unit) | 6 | 6 | 0 | 0 | 0 | 0 |
| DB (integration) | 30 | 25 | 5 | 0 | 0 | 0 |
| API (integration) | 89 | 84 | 5 | 0 | 0 | 0 |
| WS (integration) | 31 | 28 | 3 | 0 | 0 | 0 |
| CC (client crypto) | 31 | 31 | 0 | 0 | 0 | 0 |
| KS (client keystore) | 11 | 10 | 0 | 0 | 1 | 0 |
| WSM (client websocket) | 13 | 4 | 3 | 0 | 6 | 0 |
| ST (client stores) | 20 | 18 | 1 | 0 | 1 | 0 |
| RC (client REST) | 3 | 3 | 0 | 0 | 0 | 0 |
| CI (client integration) | 8 | 1 | 0 | 0 | 7 | 0 |
| E2E (end-to-end) | 42 | 17 | 0 | 0 | 25 | 0 |
| SEC (security) | 15 | 14 | 1 | 0 | 0 | 0 |
| PERF (benchmarks) | 9 | 3 | 4 | 0 | 2 | 0 |
| **TOTAL** | **345** | **275** | **22** | **0** | **42** | **6** |


---

## Notes

### Where Tests Live

Server tests are organized across both phase files and domain-based files:

**Phase files (existing):**
- `milestone_1.rs` — auth, WS connection, presence, health, rate limiting (38 tests)
- `phase_5.rs` — servers, channels, messaging, member events (26 tests)
- `phase_6b.rs` — device management, key bundles, OTP claiming (25 tests)
- `phase_6e.rs` — device lists, key backup, TOFU, identity reset (10 tests)
- `phase_7.rs` — E2E message routing, DM history, device filter (14 tests)
- `phase_8.rs` — SFU media, voice calls, WebRTC signaling (13 tests)
- `phase_9a.rs` — blocks, bans, kicks, mutes, moderation, audit log (26 tests)
- `phase_9b.rs` — abuse detection, reporting (16 tests)
- `phase_10.rs` — observability, metrics, security headers (9 tests)

**Domain files (new):**
- `unit_tests.rs` — CORE-001..008, AUTH-001..011, MOD-001..012, MEDIA-001..006 (37 unit tests)
- `security_tests.rs` — SEC-001..006, SEC-011..015 (11 security tests)
- `db_tests.rs` — DB-001, DB-006, DB-010, DB-013..015, DB-029, DB-030 (8 integration tests)
- `api_tests.rs` — API-004..006, API-017..018, API-031, API-036, API-053, API-056, API-069, API-074, API-084 (12 integration tests)
- `ws_tests.rs` — WS-011, WS-018, WS-020, WS-022, WS-025, WS-026, WS-030 (7 integration tests)

Client unit tests have excellent file organization matching the spec layout.

### Changes Since Last Audit

**63 specs moved from MISSING to PASS:**
- CORE: +6 (CORE-002, 004, 005, 006, 007, 008)
- AUTH: +2 (AUTH-003, AUTH-007)
- MOD: +12 (MOD-001 through MOD-012)
- MEDIA: +6 (MEDIA-001 through MEDIA-006)
- DB: +8 (DB-001, 006, 010, 013, 014, 015, 029, 030)
- API: +16 (API-004, 005, 006, 017, 018, 031, 036, 038, 039, 053, 055, 056, 069, 074, 080, 084)
- SEC: +9 (SEC-001, 002, 004, 005, 006, 011, 012, 014, 015)
- WS: +4 (WS-011, 018, 020, 022)

**3 specs moved from MISSING to PARTIAL:**
- WS-025 (KEY_BUNDLE_UPDATE not yet broadcast from REST handler)
- WS-026 (DEVICE_LIST_UPDATE not yet broadcast from REST handler)
- WS-030 (abuse detector timing-dependent in test environment)

**3 specs moved from PARTIAL to PASS:**
- AUTH-002 (standalone test now exists in unit_tests.rs)
- API-065 (covered in phase_9a.rs with explicit 403 assertion)
- SEC-013 moved from PARTIAL(phase_9a.rs) to PARTIAL(security_tests.rs) with better coverage

**6 CRYPTO specs reclassified from MISSING to BLOCKED.**

### Remaining Gaps

1. **Client integration (CI-*)**: Only 1 of 8 tests implemented. Missing worker initialization, cross-module crypto flows, persistence, and IPC security tests.

2. **E2E tests**: 25 of 42 MISSING. Auth edge cases, resilience/reconnection, voice controls, and several UI verification tests absent.

3. **Client WebSocket Manager (WSM-*)**: 6 of 13 MISSING. Heartbeat interval, reconnection edge cases, and control frame handling untested.

4. **CRYPTO-* (server)**: All 6 BLOCKED pending mercury-crypto crate implementation.

5. **Performance**: 2 of 9 MISSING (bundle_size, message_history_query).
