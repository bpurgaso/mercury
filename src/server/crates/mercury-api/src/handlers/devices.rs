use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use mercury_core::{
    error::MercuryError,
    ids::{DeviceId, UserId},
};
use serde::{Deserialize, Serialize};

use crate::extractors::AuthUser;
use crate::state::AppState;

// ── Request/Response types ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateDeviceRequest {
    pub device_name: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceResponse {
    pub device_id: String,
    pub device_name: String,
    pub created_at: Option<String>,
    pub last_seen_at: Option<String>,
}

impl From<mercury_core::models::Device> for DeviceResponse {
    fn from(d: mercury_core::models::Device) -> Self {
        DeviceResponse {
            device_id: d.id.to_string(),
            device_name: d.device_name,
            created_at: d.created_at.map(|t| t.to_rfc3339()),
            last_seen_at: d.last_seen_at.map(|t| t.to_rfc3339()),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct UploadKeysRequest {
    pub identity_key: String,
    pub signed_prekey: String,
    pub signed_prekey_id: i32,
    pub prekey_signature: String,
    #[serde(default)]
    pub one_time_prekeys: Vec<OtpUpload>,
}

#[derive(Debug, Deserialize)]
pub struct OtpUpload {
    pub key_id: i32,
    pub prekey: String,
}

#[derive(Debug, Serialize)]
pub struct KeyBundleResponse {
    pub identity_key: String,
    pub signed_prekey: String,
    pub signed_prekey_id: i32,
    pub prekey_signature: String,
}

#[derive(Debug, Serialize)]
pub struct UserKeyBundlesResponse {
    pub devices: Vec<DeviceKeyBundleResponse>,
}

#[derive(Debug, Serialize)]
pub struct DeviceKeyBundleResponse {
    pub device_id: String,
    pub device_name: String,
    pub identity_key: String,
    pub signed_prekey: String,
    pub signed_prekey_id: i32,
    pub prekey_signature: String,
}

#[derive(Debug, Serialize)]
pub struct ClaimOtpResponse {
    pub key_id: i32,
    pub prekey: String,
}

// ── Handlers ───────────────────────────────────────────────

/// POST /devices — Register a new device.
pub async fn create_device(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<CreateDeviceRequest>,
) -> Result<(StatusCode, Json<DeviceResponse>), MercuryError> {
    if req.device_name.is_empty() || req.device_name.len() > 64 {
        return Err(MercuryError::BadRequest(
            "device_name must be 1-64 characters".into(),
        ));
    }

    // Enforce per-user device limit
    let count = mercury_db::devices::count_devices_for_user(&state.db, auth_user.user_id).await?;
    if count >= mercury_db::devices::MAX_DEVICES_PER_USER {
        return Err(MercuryError::BadRequest(format!(
            "maximum {} devices per user",
            mercury_db::devices::MAX_DEVICES_PER_USER,
        )));
    }

    let device_id = DeviceId::new();
    let device =
        mercury_db::devices::create_device(&state.db, device_id, auth_user.user_id, &req.device_name)
            .await?;

    Ok((StatusCode::CREATED, Json(DeviceResponse::from(device))))
}

/// GET /devices — List current user's devices.
pub async fn list_devices(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<Vec<DeviceResponse>>, MercuryError> {
    let devices =
        mercury_db::devices::list_devices_for_user(&state.db, auth_user.user_id).await?;
    Ok(Json(devices.into_iter().map(DeviceResponse::from).collect()))
}

/// DELETE /devices/:id — Remove a device (must be owned by caller).
pub async fn delete_device(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(device_id): Path<uuid::Uuid>,
) -> Result<StatusCode, MercuryError> {
    let device_id = DeviceId(device_id);

    // Check the device exists first to distinguish 404 from 403
    let device = mercury_db::devices::get_device(&state.db, device_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("device not found".into()))?;

    if device.user_id != auth_user.user_id {
        return Err(MercuryError::Forbidden(
            "cannot delete another user's device".into(),
        ));
    }

    mercury_db::devices::delete_device(&state.db, device_id, auth_user.user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /devices/:id/keys — Upload key bundle for a device.
pub async fn upload_keys(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(device_id): Path<uuid::Uuid>,
    Json(req): Json<UploadKeysRequest>,
) -> Result<StatusCode, MercuryError> {
    let device_id = DeviceId(device_id);

    // Verify device exists and belongs to caller
    let device = mercury_db::devices::get_device(&state.db, device_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("device not found".into()))?;

    if device.user_id != auth_user.user_id {
        return Err(MercuryError::Forbidden(
            "cannot upload keys for another user's device".into(),
        ));
    }

    // Decode and validate key sizes
    let identity_key = decode_base64_field(&req.identity_key, "identity_key", 32)?;
    let signed_prekey = decode_base64_field(&req.signed_prekey, "signed_prekey", 32)?;
    let prekey_signature = decode_base64_field(&req.prekey_signature, "prekey_signature", 64)?;

    if req.one_time_prekeys.len() > 100 {
        return Err(MercuryError::BadRequest(
            "maximum 100 one-time prekeys per upload".into(),
        ));
    }

    let mut otps: Vec<(i32, Vec<u8>)> = Vec::with_capacity(req.one_time_prekeys.len());
    for otp in &req.one_time_prekeys {
        let prekey = decode_base64_field(&otp.prekey, "one_time_prekey", 32)?;
        otps.push((otp.key_id, prekey));
    }

    // Check cumulative OTP limit before inserting
    if !otps.is_empty() {
        let existing = mercury_db::devices::count_unused_otps(&state.db, device_id).await?;
        let new_count = existing + otps.len() as i64;
        if new_count > mercury_db::devices::MAX_UNUSED_OTPS_PER_DEVICE {
            return Err(MercuryError::BadRequest(format!(
                "would exceed maximum {} unused one-time prekeys per device (currently {})",
                mercury_db::devices::MAX_UNUSED_OTPS_PER_DEVICE,
                existing,
            )));
        }
    }

    // Upsert identity keys + insert OTPs in a single transaction
    let mut tx = state.db.begin().await.map_err(|e| MercuryError::Database(e))?;

    mercury_db::devices::upsert_identity_keys(
        &mut *tx,
        device_id,
        auth_user.user_id,
        &identity_key,
        &signed_prekey,
        req.signed_prekey_id,
        &prekey_signature,
    )
    .await?;

    if !otps.is_empty() {
        mercury_db::devices::insert_one_time_prekeys(
            &mut *tx,
            device_id,
            auth_user.user_id,
            &otps,
        )
        .await?;
    }

    tx.commit().await.map_err(|e| MercuryError::Database(e))?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /users/:userId/devices/:deviceId/keys — Fetch a specific device's key bundle.
pub async fn fetch_key_bundle(
    State(state): State<AppState>,
    _auth_user: AuthUser,
    Path((user_id, device_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<Json<KeyBundleResponse>, MercuryError> {
    let user_id = UserId(user_id);
    let device_id = DeviceId(device_id);

    // Verify user exists
    if !mercury_db::devices::user_exists(&state.db, user_id).await? {
        return Err(MercuryError::NotFound("user not found".into()));
    }

    // Verify device exists and belongs to the specified user
    let device = mercury_db::devices::get_device(&state.db, device_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("device not found".into()))?;

    if device.user_id != user_id {
        return Err(MercuryError::NotFound("device not found for this user".into()));
    }

    let keys = mercury_db::devices::get_key_bundle(&state.db, device_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("key bundle not found".into()))?;

    Ok(Json(KeyBundleResponse {
        identity_key: BASE64.encode(&keys.identity_key),
        signed_prekey: BASE64.encode(&keys.signed_prekey),
        signed_prekey_id: keys.signed_prekey_id,
        prekey_signature: BASE64.encode(&keys.prekey_signature),
    }))
}

/// GET /users/:userId/keys — Fetch all device key bundles for a user.
pub async fn fetch_all_bundles(
    State(state): State<AppState>,
    _auth_user: AuthUser,
    Path(user_id): Path<uuid::Uuid>,
) -> Result<Json<UserKeyBundlesResponse>, MercuryError> {
    let user_id = UserId(user_id);

    if !mercury_db::devices::user_exists(&state.db, user_id).await? {
        return Err(MercuryError::NotFound("user not found".into()));
    }

    let bundles = mercury_db::devices::get_key_bundles_for_user(&state.db, user_id).await?;

    if bundles.is_empty() {
        return Err(MercuryError::NotFound(
            "no devices with key bundles found".into(),
        ));
    }

    let devices = bundles
        .into_iter()
        .map(|(device, keys)| DeviceKeyBundleResponse {
            device_id: device.id.to_string(),
            device_name: device.device_name,
            identity_key: BASE64.encode(&keys.identity_key),
            signed_prekey: BASE64.encode(&keys.signed_prekey),
            signed_prekey_id: keys.signed_prekey_id,
            prekey_signature: BASE64.encode(&keys.prekey_signature),
        })
        .collect();

    Ok(Json(UserKeyBundlesResponse { devices }))
}

/// POST /users/:userId/devices/:deviceId/keys/one-time — Claim a one-time prekey.
pub async fn claim_otp(
    State(state): State<AppState>,
    _auth_user: AuthUser,
    Path((user_id, device_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<Json<ClaimOtpResponse>, MercuryError> {
    let user_id = UserId(user_id);
    let device_id = DeviceId(device_id);

    // Verify device exists and belongs to the specified user
    let device = mercury_db::devices::get_device(&state.db, device_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("device not found".into()))?;

    if device.user_id != user_id {
        return Err(MercuryError::NotFound("device not found for this user".into()));
    }

    let otp = mercury_db::devices::claim_one_time_prekey(&state.db, device_id)
        .await?
        .ok_or_else(|| {
            MercuryError::NotFound("no one-time prekeys available".into())
        })?;

    Ok(Json(ClaimOtpResponse {
        key_id: otp.key_id,
        prekey: BASE64.encode(&otp.prekey),
    }))
}

// ── Helpers ────────────────────────────────────────────────

fn decode_base64_field(
    value: &str,
    field_name: &str,
    expected_len: usize,
) -> Result<Vec<u8>, MercuryError> {
    let bytes = BASE64.decode(value).map_err(|_| {
        MercuryError::BadRequest(format!("invalid base64 in {field_name}"))
    })?;
    if bytes.len() != expected_len {
        return Err(MercuryError::BadRequest(format!(
            "{field_name} must be {expected_len} bytes, got {}",
            bytes.len()
        )));
    }
    Ok(bytes)
}
