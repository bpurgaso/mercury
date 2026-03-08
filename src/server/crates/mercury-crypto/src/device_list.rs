// Signed device list verification for Trust-On-First-Use (TOFU) enforcement.
//
// The client creates a signed device list by:
//   1. Serializing a DeviceListPayload as canonical JSON (keys sorted).
//   2. Signing the JSON bytes with the user's Ed25519 master verify key.
//
// The server verifies the signature on upload to ensure:
//   - The device list was actually signed by the holder of the master verify key.
//   - The payload is well-formed JSON with the expected structure.

use crate::verify::{verify_ed25519, SignatureVerifyError, ED25519_PUBLIC_KEY_LEN, ED25519_SIGNATURE_LEN};
use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DeviceListError {
    #[error("signature verification failed: {0}")]
    Signature(#[from] SignatureVerifyError),

    #[error("device list payload is not valid UTF-8")]
    InvalidUtf8,

    #[error("device list payload is not valid JSON: {0}")]
    InvalidJson(String),

    #[error("device list is missing required field: {0}")]
    MissingField(&'static str),

    #[error("device list entry has invalid format: {0}")]
    InvalidEntry(String),
}

/// A single entry in a device list payload.
#[derive(Debug, Deserialize)]
pub struct DeviceListEntry {
    pub device_id: String,
    pub identity_key: String,
}

/// The deserialized payload inside a signed device list.
#[derive(Debug, Deserialize)]
pub struct DeviceListPayload {
    pub devices: Vec<DeviceListEntry>,
    pub timestamp: u64,
}

/// Verify a signed device list's Ed25519 signature and parse its payload.
///
/// Returns the parsed payload on success. This is called during
/// `PUT /users/me/device-list` to ensure the uploaded list is authentic.
pub fn verify_signed_device_list(
    master_verify_key: &[u8],
    signed_list: &[u8],
    signature: &[u8],
) -> Result<DeviceListPayload, DeviceListError> {
    // Verify the Ed25519 signature over the raw signed_list bytes
    verify_ed25519(master_verify_key, signed_list, signature)?;

    // Parse the signed list as UTF-8 JSON
    let json_str = std::str::from_utf8(signed_list).map_err(|_| DeviceListError::InvalidUtf8)?;

    let parsed: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| DeviceListError::InvalidJson(e.to_string()))?;

    // Validate required fields
    let devices = parsed
        .get("devices")
        .and_then(|v| v.as_array())
        .ok_or(DeviceListError::MissingField("devices"))?;

    let timestamp = parsed
        .get("timestamp")
        .and_then(|v| v.as_u64())
        .ok_or(DeviceListError::MissingField("timestamp"))?;

    // Validate each device entry
    let mut entries = Vec::with_capacity(devices.len());
    for (i, device) in devices.iter().enumerate() {
        let device_id = device
            .get("device_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                DeviceListError::InvalidEntry(format!("entry {i}: missing or invalid device_id"))
            })?;

        let identity_key = device
            .get("identity_key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                DeviceListError::InvalidEntry(format!("entry {i}: missing or invalid identity_key"))
            })?;

        entries.push(DeviceListEntry {
            device_id: device_id.to_string(),
            identity_key: identity_key.to_string(),
        });
    }

    Ok(DeviceListPayload {
        devices: entries,
        timestamp,
    })
}

/// Validate key sizes without performing signature verification.
/// Used for fast-path rejection of obviously invalid inputs.
pub fn validate_device_list_sizes(
    master_verify_key: &[u8],
    signature: &[u8],
) -> Result<(), DeviceListError> {
    if master_verify_key.len() != ED25519_PUBLIC_KEY_LEN {
        return Err(DeviceListError::Signature(
            SignatureVerifyError::InvalidKeyLength {
                expected: ED25519_PUBLIC_KEY_LEN,
                actual: master_verify_key.len(),
            },
        ));
    }
    if signature.len() != ED25519_SIGNATURE_LEN {
        return Err(DeviceListError::Signature(
            SignatureVerifyError::InvalidKeyLength {
                expected: ED25519_SIGNATURE_LEN,
                actual: signature.len(),
            },
        ));
    }
    Ok(())
}
