# Phase 6b — Server-Side Key Bundle Endpoints

## Problem Statement

The client-side X3DH implementation (Phase 6b) requires server endpoints for uploading, fetching, and claiming cryptographic key material. Without these, clients cannot establish E2E encrypted sessions. The server currently has the database schema (migration 004) and core models (`Device`, `DeviceIdentityKey`, `OneTimePrekey`) but no handler code, database query functions, or integration tests.

## Proposed Solution

Implement the server-side REST endpoints and database layer for device registration and X3DH key bundle management, following the existing Axum handler + mercury-db pattern. Add a new migration to extend the schema with a missing `signed_prekey_id` column. All endpoints require JWT authentication; device mutation endpoints enforce ownership.

## Goals

- Clients can register devices, upload key bundles, fetch bundles for other users, and atomically claim one-time prekeys.
- One-time prekey claiming is atomic (no two clients can claim the same OTP).
- Device ownership is enforced — users can only mutate their own devices' keys.
- Integration tests cover the happy path, ownership boundaries, OTP atomicity, and error cases.

## Non-Goals

- Signed device list upload/verification (Phase 6c+).
- Key backup endpoints (Phase 6c+).
- WebSocket `KEY_BUNDLE_UPDATE` / `DEVICE_LIST_UPDATE` broadcast (exists in protocol enum, wiring deferred).
- Multi-device support beyond what the schema already provides (MVP is single device per user).

## Detailed Design

### 1. Database Migration (006)

Add `signed_prekey_id INT NOT NULL DEFAULT 0` to `device_identity_keys`. The client sends this value to identify which SPK version is active, and the server must store/return it.

```sql
ALTER TABLE device_identity_keys ADD COLUMN signed_prekey_id INT NOT NULL DEFAULT 0;
```

### 2. Update Core Model

Add `signed_prekey_id: i32` to `DeviceIdentityKey` in `mercury-core/src/models.rs`.

### 3. Database Functions (`mercury-db/src/devices.rs`)

New module with these functions:

| Function | SQL | Notes |
|---|---|---|
| `create_device(pool, id, user_id, device_name)` | `INSERT INTO devices ... RETURNING *` | |
| `list_devices_for_user(pool, user_id)` | `SELECT * FROM devices WHERE user_id = $1` | |
| `get_device(pool, device_id)` | `SELECT * FROM devices WHERE id = $1` | Returns `Option<Device>` |
| `delete_device(pool, device_id, user_id)` | `DELETE FROM devices WHERE id = $1 AND user_id = $2` | Ownership check in SQL |
| `upsert_identity_keys(pool, device_id, user_id, identity_key, signed_prekey, signed_prekey_id, prekey_signature)` | `INSERT ... ON CONFLICT (device_id) DO UPDATE SET ...` | Upsert; sets `updated_at = now()` |
| `insert_one_time_prekeys(pool, device_id, user_id, keys: &[(i32, &[u8])])` | Batch `INSERT ... ON CONFLICT DO NOTHING` | Idempotent; ignores re-uploaded key_ids |
| `get_key_bundle(pool, device_id)` | `SELECT ... FROM device_identity_keys WHERE device_id = $1` | Returns identity key row |
| `get_key_bundles_for_user(pool, user_id)` | Join `devices` + `device_identity_keys` on `user_id` | Returns `Vec<(Device, DeviceIdentityKey)>` |
| `claim_one_time_prekey(pool, device_id)` | `UPDATE one_time_prekeys SET used = TRUE WHERE id = (SELECT id FROM one_time_prekeys WHERE device_id = $1 AND used = FALSE ORDER BY key_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *` | Atomic claim with row-level lock; `SKIP LOCKED` prevents contention under concurrent claims |
| `count_unused_otps(pool, device_id)` | `SELECT COUNT(*) FROM one_time_prekeys WHERE device_id = $1 AND used = FALSE` | For low-OTP-count monitoring |

### 4. API Handlers (`mercury-api/src/handlers/devices.rs`)

#### `POST /devices` — Register a device

```
Request:  { "device_name": "MacBook Pro" }
Response: 201 { "device_id": "uuid", "device_name": "...", "created_at": "..." }
Auth:     JWT (AuthUser)
```

Creates a new `devices` row. Returns the device ID for the client to use in subsequent key upload calls.

#### `GET /devices` — List current user's devices

```
Response: 200 [{ "device_id": "...", "device_name": "...", "created_at": "...", "last_seen_at": "..." }]
Auth:     JWT (AuthUser)
```

#### `DELETE /devices/:deviceId` — Remove a device

```
Response: 204 No Content
Auth:     JWT (AuthUser) + ownership check
Error:    403 if device belongs to another user, 404 if not found
```

Cascade-deletes identity keys and OTPs via FK constraints.

#### `PUT /devices/:deviceId/keys` — Upload key bundle

```
Request: {
  "identity_key": "<base64>",
  "signed_prekey": "<base64>",
  "signed_prekey_id": 1,
  "prekey_signature": "<base64>",
  "one_time_prekeys": [{ "key_id": 0, "prekey": "<base64>" }, ...]
}
Response: 204 No Content
Auth:     JWT (AuthUser) + device ownership check
```

- Validates device belongs to caller.
- Decodes base64 fields → `Vec<u8>`.
- Upserts `device_identity_keys` row.
- Batch-inserts OTPs (idempotent via `ON CONFLICT DO NOTHING`).
- Validation: identity_key 32 bytes, signed_prekey 32 bytes, prekey_signature 64 bytes, each OTP prekey 32 bytes, max 100 OTPs per upload.

#### `GET /users/:userId/devices/:deviceId/keys` — Fetch a device's key bundle

```
Response: 200 {
  "identity_key": "<base64>",
  "signed_prekey": "<base64>",
  "signed_prekey_id": 1,
  "prekey_signature": "<base64>"
}
Auth:     JWT (any authenticated user)
Error:    404 if user or device not found
```

Does NOT include OTPs — those must be claimed separately via POST.

#### `GET /users/:userId/keys` — Fetch all device bundles for a user

```
Response: 200 {
  "devices": [{
    "device_id": "...",
    "device_name": "...",
    "identity_key": "<base64>",
    "signed_prekey": "<base64>",
    "signed_prekey_id": 1,
    "prekey_signature": "<base64>"
  }, ...]
}
Auth:     JWT (any authenticated user)
Error:    404 if user has no devices
```

#### `POST /users/:userId/devices/:deviceId/keys/one-time` — Claim a one-time prekey

```
Response: 200 { "key_id": 42, "prekey": "<base64>" }
Auth:     JWT (any authenticated user)
Error:    404 if device not found or no OTPs available
```

- Uses the atomic `claim_one_time_prekey` function (`FOR UPDATE SKIP LOCKED`).
- Returns the claimed OTP's `key_id` and `prekey` (public key).
- Returns 404 (not 200 with null) when no OTPs remain — the client falls back to 3-DH without OTP.

### 5. Router Wiring

Add two new route groups in `create_router`:

```rust
// Device routes — require authentication
let device_routes = Router::new()
    .route("/", post(handlers::devices::create_device))
    .route("/", get(handlers::devices::list_devices))
    .route("/{id}", delete(handlers::devices::delete_device))
    .route("/{id}/keys", put(handlers::devices::upload_keys));

// Add device_routes under /devices
// Add key-fetch routes under /users
```

Key-fetch routes are nested under `/users`:
- `GET /users/:userId/devices/:deviceId/keys`
- `GET /users/:userId/keys`
- `POST /users/:userId/devices/:deviceId/keys/one-time`

### 6. Integration Tests (`src/server/tests/phase_6b.rs`)

| Test | What it verifies |
|------|-----------------|
| `test_register_device` | POST /devices returns 201 with valid UUID |
| `test_list_devices` | GET /devices returns the registered device |
| `test_delete_device` | DELETE /devices/:id returns 204, subsequent list omits it |
| `test_delete_device_ownership` | DELETE someone else's device returns 403 |
| `test_upload_key_bundle` | PUT /devices/:id/keys returns 204 |
| `test_upload_key_bundle_validation` | Invalid key sizes → 400 |
| `test_upload_keys_wrong_owner` | PUT to another user's device → 403 |
| `test_fetch_key_bundle` | GET /users/:uid/devices/:did/keys returns uploaded bundle |
| `test_fetch_all_bundles` | GET /users/:uid/keys returns all device bundles |
| `test_fetch_bundle_not_found` | Non-existent user/device → 404 |
| `test_claim_otp` | POST .../one-time returns a valid OTP |
| `test_claim_otp_exhaustion` | Claim all OTPs, then claim again → 404 |
| `test_claim_otp_no_duplicate` | Concurrent claims return distinct OTPs |
| `test_unauthenticated_access` | All endpoints reject requests without JWT |

## Edge Cases

- **Concurrent OTP claims:** Two clients claim from the same device simultaneously. `FOR UPDATE SKIP LOCKED` ensures each gets a different row; no deadlocks.
- **Re-uploading key bundle:** Upsert overwrites identity keys + SPK. OTPs use `ON CONFLICT DO NOTHING` so re-uploading the same batch is idempotent.
- **Device deletion cascades:** FK `ON DELETE CASCADE` removes identity keys and OTPs automatically.
- **Empty OTP list in upload:** Valid — the device simply has no OTPs available. Callers doing X3DH will get 404 on claim and fall back to 3-DH.
- **Base64 decoding errors:** Return 400 with descriptive message.

## Acceptance Criteria

1. All 6 REST endpoints return correct status codes and response shapes.
2. `PUT /devices/:id/keys` rejects payloads with wrong key sizes (400).
3. Device mutation endpoints enforce ownership (403 for wrong user).
4. OTP claim is atomic — concurrent claims never return the same OTP.
5. All 14 integration tests pass with `cargo nextest run`.
6. Existing tests (milestone_1, phase_5) continue to pass.
