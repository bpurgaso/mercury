use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use fred::prelude::*;
use mercury_core::{
    error::MercuryError,
    ids::UserId,
};
use serde::{Deserialize, Serialize};

use crate::extractors::AuthUser;
use crate::state::AppState;

// Redis cache TTL for device lists (1 hour).
const DEVICE_LIST_CACHE_TTL_SECS: i64 = 3600;

// Maximum encrypted backup blob size (10 MB). Prevents abuse via oversized uploads.
const MAX_BACKUP_SIZE_BYTES: usize = 10 * 1024 * 1024;

// ── Request/Response types ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UploadDeviceListRequest {
    pub signed_list: String,
    pub master_verify_key: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceListResponse {
    pub signed_list: String,
    pub master_verify_key: String,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
pub struct UploadKeyBackupRequest {
    pub encrypted_backup: String,
    pub key_derivation_salt: String,
}

#[derive(Debug, Serialize)]
pub struct KeyBackupResponse {
    pub encrypted_backup: String,
    pub key_derivation_salt: String,
    pub backup_version: i32,
}

// ── Device List Handlers ───────────────────────────────────

/// PUT /users/me/device-list — Upload signed device list.
pub async fn upload_device_list(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<UploadDeviceListRequest>,
) -> Result<StatusCode, MercuryError> {
    // Decode base64 fields
    let signed_list = BASE64.decode(&req.signed_list).map_err(|_| {
        MercuryError::BadRequest("invalid base64 in signed_list".into())
    })?;
    let master_verify_key = BASE64.decode(&req.master_verify_key).map_err(|_| {
        MercuryError::BadRequest("invalid base64 in master_verify_key".into())
    })?;
    let signature = BASE64.decode(&req.signature).map_err(|_| {
        MercuryError::BadRequest("invalid base64 in signature".into())
    })?;

    if signed_list.is_empty() {
        return Err(MercuryError::BadRequest("signed_list must not be empty".into()));
    }
    if master_verify_key.is_empty() {
        return Err(MercuryError::BadRequest("master_verify_key must not be empty".into()));
    }
    if signature.is_empty() {
        return Err(MercuryError::BadRequest("signature must not be empty".into()));
    }

    // Verify the Ed25519 signature on the device list
    mercury_crypto::device_list::verify_signed_device_list(
        &master_verify_key,
        &signed_list,
        &signature,
    )
    .map_err(|e| MercuryError::BadRequest(format!("device list verification failed: {e}")))?;

    // TOFU: if a device list already exists, the master_verify_key must match
    let existing = mercury_db::device_lists::get_device_list(&state.db, auth_user.user_id).await?;
    if let Some(existing) = existing {
        if existing.master_verify_key != master_verify_key {
            return Err(MercuryError::Forbidden(
                "master_verify_key mismatch — trust-on-first-use violation".into(),
            ));
        }
    }

    mercury_db::device_lists::upsert_device_list(
        &state.db,
        auth_user.user_id,
        &signed_list,
        &master_verify_key,
        &signature,
    )
    .await?;

    // Cache in Redis
    let cache_key = format!("device_list:{}", auth_user.user_id);
    let cache_value = serde_json::json!({
        "signed_list": req.signed_list,
        "master_verify_key": req.master_verify_key,
        "signature": req.signature,
    });
    let cache_str = serde_json::to_string(&cache_value)
        .map_err(|e| MercuryError::Internal(e.into()))?;

    // Best-effort cache write — don't fail the request if Redis is down
    let _: Result<(), _> = state
        .redis
        .set::<(), _, _>(
            &cache_key,
            cache_str,
            Some(Expiration::EX(DEVICE_LIST_CACHE_TTL_SECS)),
            None,
            false,
        )
        .await;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /users/:id/device-list — Fetch a user's signed device list.
pub async fn get_device_list(
    State(state): State<AppState>,
    _auth_user: AuthUser,
    Path(user_id): Path<uuid::Uuid>,
) -> Result<Json<DeviceListResponse>, MercuryError> {
    let user_id = UserId(user_id);

    // Check Redis cache first
    let cache_key = format!("device_list:{}", user_id);
    let cached: Result<Option<String>, _> = state.redis.get(&cache_key).await;

    if let Ok(Some(cached_str)) = cached {
        if let Ok(cached_val) = serde_json::from_str::<serde_json::Value>(&cached_str) {
            if let (Some(sl), Some(mvk), Some(sig)) = (
                cached_val["signed_list"].as_str(),
                cached_val["master_verify_key"].as_str(),
                cached_val["signature"].as_str(),
            ) {
                return Ok(Json(DeviceListResponse {
                    signed_list: sl.to_string(),
                    master_verify_key: mvk.to_string(),
                    signature: sig.to_string(),
                }));
            }
        }
    }

    // Fall back to Postgres
    let device_list = mercury_db::device_lists::get_device_list(&state.db, user_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("device list not found".into()))?;

    let response = DeviceListResponse {
        signed_list: BASE64.encode(&device_list.signed_list),
        master_verify_key: BASE64.encode(&device_list.master_verify_key),
        signature: BASE64.encode(&device_list.signature),
    };

    // Populate cache for next time (best-effort)
    let cache_value = serde_json::json!({
        "signed_list": &response.signed_list,
        "master_verify_key": &response.master_verify_key,
        "signature": &response.signature,
    });
    if let Ok(cache_str) = serde_json::to_string(&cache_value) {
        let _: Result<(), _> = state
            .redis
            .set::<(), _, _>(
                &cache_key,
                cache_str,
                Some(Expiration::EX(DEVICE_LIST_CACHE_TTL_SECS)),
                None,
                false,
            )
            .await;
    }

    Ok(Json(response))
}

/// DELETE /users/me/identity — Reset identity (delete device list + key backup).
///
/// This is the TOFU escape hatch: if a user loses all devices and their
/// recovery key, they can reset their identity to establish a new master
/// verify key. All clients that had the old TOFU key will see a "key
/// changed" warning, which is correct and expected.
pub async fn reset_identity(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<StatusCode, MercuryError> {
    let deleted = mercury_db::device_lists::delete_device_list(&state.db, auth_user.user_id).await?;

    if !deleted {
        return Err(MercuryError::NotFound("no identity to reset".into()));
    }

    // Also delete the key backup (it's tied to the old recovery key)
    let _ = mercury_db::device_lists::delete_key_backup(&state.db, auth_user.user_id).await;

    // Invalidate Redis cache
    let cache_key = format!("device_list:{}", auth_user.user_id);
    let _: Result<(), _> = state.redis.del::<(), _>(&cache_key).await;

    Ok(StatusCode::NO_CONTENT)
}

// ── Key Backup Handlers ────────────────────────────────────

/// PUT /users/me/key-backup — Upload encrypted key backup blob.
pub async fn upload_key_backup(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Json(req): Json<UploadKeyBackupRequest>,
) -> Result<StatusCode, MercuryError> {
    let encrypted_backup = BASE64.decode(&req.encrypted_backup).map_err(|_| {
        MercuryError::BadRequest("invalid base64 in encrypted_backup".into())
    })?;
    let key_derivation_salt = BASE64.decode(&req.key_derivation_salt).map_err(|_| {
        MercuryError::BadRequest("invalid base64 in key_derivation_salt".into())
    })?;

    if encrypted_backup.is_empty() {
        return Err(MercuryError::BadRequest("encrypted_backup must not be empty".into()));
    }
    if encrypted_backup.len() > MAX_BACKUP_SIZE_BYTES {
        return Err(MercuryError::BadRequest(format!(
            "encrypted_backup exceeds maximum size of {} bytes",
            MAX_BACKUP_SIZE_BYTES,
        )));
    }

    // Validate backup blob structure (nonce + ciphertext + tag) and salt length
    mercury_crypto::backup::validate_backup_blob(&encrypted_backup, &key_derivation_salt)
        .map_err(|e| MercuryError::BadRequest(format!("backup validation failed: {e}")))?;

    mercury_db::device_lists::upsert_key_backup(
        &state.db,
        auth_user.user_id,
        &encrypted_backup,
        &key_derivation_salt,
    )
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /users/me/key-backup — Download encrypted key backup blob.
pub async fn get_key_backup(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<Json<KeyBackupResponse>, MercuryError> {
    let backup = mercury_db::device_lists::get_key_backup(&state.db, auth_user.user_id)
        .await?
        .ok_or_else(|| MercuryError::NotFound("key backup not found".into()))?;

    Ok(Json(KeyBackupResponse {
        encrypted_backup: BASE64.encode(&backup.encrypted_backup),
        key_derivation_salt: BASE64.encode(&backup.key_derivation_salt),
        backup_version: backup.backup_version,
    }))
}

/// DELETE /users/me/key-backup — Delete key backup.
pub async fn delete_key_backup(
    State(state): State<AppState>,
    auth_user: AuthUser,
) -> Result<StatusCode, MercuryError> {
    let deleted = mercury_db::device_lists::delete_key_backup(&state.db, auth_user.user_id).await?;

    if !deleted {
        return Err(MercuryError::NotFound("key backup not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}
