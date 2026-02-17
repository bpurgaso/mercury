# Milestone 1 — Integration Test Specification

This document defines automated integration tests covering Phases 1–4. These tests
run against a live server with real Postgres and Redis, replacing the manual curl
and wscat verification steps.

## Test Architecture

Tests live in `src/server/tests/` (Rust integration tests, outside any crate). They
spin up the full Axum server on a random available port per test run, use a dedicated
test database, and clean up after themselves.

A shared test harness provides:
- `TestServer`: starts the Mercury server on a random port, returns base URL
- `TestClient`: HTTP client with helper methods (register, login, authed requests)
- `TestWsClient`: WebSocket client that connects, identifies, and exposes send/receive
- Database setup: runs migrations on a test database, truncates tables between tests
- Redis setup: flushes between tests

## Test Suite

### 1. Health Check (Phase 1)

```
test_health_returns_200
    GET /health → 200 OK
    Response body contains status indicator

test_health_requires_no_auth
    GET /health with no Authorization header → 200 (not 401)
```

### 2. Database Schema Validation (Phase 2)

```
test_uuid_v7_is_time_sorted
    Generate 100 UUIDv7s in sequence
    Assert each is lexicographically greater than the previous

test_channel_encryption_mode_constraint
    INSERT channel with encryption_mode = 'invalid' → fails
    INSERT channel with encryption_mode = 'standard' → succeeds
    INSERT channel with encryption_mode = 'private' → succeeds

test_server_members_is_moderator_default
    INSERT server_member → is_moderator defaults to false

test_channels_sender_key_epoch_default
    INSERT channel → sender_key_epoch defaults to 0

test_message_recipients_unique_constraint
    INSERT two message_recipients with same (message_id, device_id) → fails on second
```

### 3. Authentication (Phase 3)

```
test_register_success
    POST /auth/register with valid credentials → 201
    Response contains user_id, access_token, refresh_token, expires_in

test_register_duplicate_email
    Register user A
    Register user B with same email → 409

test_register_duplicate_username
    Register user A
    Register user B with same username → 409

test_login_success
    Register user, then POST /auth/login → 200
    Response contains valid JWT tokens

test_login_wrong_password
    Register user, login with wrong password → 401

test_login_nonexistent_user
    Login with email that was never registered → 401

test_refresh_token
    Register → use refresh_token at POST /auth/refresh → 200
    New access_token is different from the original

test_refresh_with_access_token_fails
    Register → use access_token (not refresh) at /auth/refresh → 401

test_logout_revokes_session
    Register → POST /auth/logout with access_token → 200
    Use same access_token on /users/me → 401

test_expired_token_rejected
    (If testable: generate a token with past expiry, verify 401)

test_authenticated_endpoint
    Register → GET /users/me with valid token → 200
    Response contains correct user info

test_unauthenticated_endpoint_rejected
    GET /users/me with no token → 401

test_rate_limiting_auth_endpoints
    Send 6 rapid POST /auth/register requests
    First 5 return non-429 status codes
    6th returns 429
    Response includes Retry-After header
```

### 4. WebSocket (Phase 4)

```
test_ws_connect_and_identify
    Connect to /ws?token={jwt}
    Send identify with token and device_id
    Receive READY event with: user info, session_id, heartbeat_interval, servers, dm_channels

test_ws_invalid_token_rejected
    Connect to /ws?token=garbage
    Connection closes with code 4008

test_ws_identify_required_first
    Connect with valid token
    Send heartbeat before identify
    Connection closes with error (must identify first)

test_ws_heartbeat_acknowledged
    Connect → identify → receive READY
    Send heartbeat with seq
    Receive HEARTBEAT_ACK

test_ws_missed_heartbeats_disconnect
    Connect → identify → receive READY
    Note the heartbeat_interval from READY
    Do NOT send any heartbeats
    Connection should close with code 4009 after ~3 missed intervals

test_ws_presence_online_on_identify
    Connect → identify → receive READY
    Receive PRESENCE_UPDATE with status "online" for own user

test_ws_presence_debounce_absorbs_reconnect
    Connect → identify → receive READY
    Disconnect
    Reconnect within 5 seconds → identify again
    Verify NO "offline" PRESENCE_UPDATE was broadcast
    (The flap should be absorbed silently)

test_ws_presence_goes_offline_after_debounce
    Connect → identify → receive READY
    Disconnect
    Wait 16 seconds (longer than 15s debounce)
    Verify presence in Redis shows "offline"

test_ws_resume_replays_missed_events
    User A and User B both connected
    Disconnect User B
    While B is disconnected, trigger an event (e.g., User A presence change)
    User B reconnects with resume (session_id + last seq)
    User B should receive the missed event(s)

test_ws_resume_expired_session
    Connect → identify → note session_id
    Disconnect → wait for session to expire (or manually delete from Redis)
    Attempt resume with old session_id
    Connection closes with code 4009 (must re-identify)

test_ws_upgrade_rate_limiting
    Send 201+ rapid WebSocket upgrade requests
    First 200 succeed (or fail for other reasons, but not 503)
    Subsequent requests receive 503 with Retry-After header

test_ws_cross_user_presence
    User A connects → identifies
    User B connects → identifies
    User B should receive PRESENCE_UPDATE for User A (already online)
    User A disconnects → wait for debounce
    User B receives PRESENCE_UPDATE with User A status "offline"
```

## Running the Tests

### Prerequisites

Docker Compose infrastructure must be running (`docker compose up -d`). Create the
test database (one-time setup):

```bash
docker compose exec postgres psql -U mercury -c "CREATE DATABASE mercury_test;"
```

### Run

From the workspace root (`src/server/`):

```bash
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury_test"
cargo test --test milestone_1 -- --test-threads=1
```

Or with nextest:

```bash
export DATABASE_URL="postgres://mercury:mercury@localhost:5432/mercury_test"
cargo nextest run --test milestone_1 -j 1
```

Tests **must** run sequentially because they share Postgres and Redis state. Each test
truncates tables and flushes Redis in its setup.

## Implementation Notes

- Use `reqwest` for HTTP client (with rustls, not native-tls, to match the server)
- Use `tokio-tungstenite` for WebSocket client
- Use `tokio::time::timeout` for asserting that events arrive within expected windows
- Each test should have a 30-second overall timeout to prevent hanging on failures
- The test server should bind to `127.0.0.1:0` (random port) to avoid conflicts
- The test harness should expose the bound port so clients know where to connect
