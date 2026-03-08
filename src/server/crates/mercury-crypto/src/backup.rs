// Encrypted key backup blob validation.
//
// The server never decrypts backup blobs — they are encrypted client-side with
// AES-256-GCM keyed by an HKDF derivation of the user's recovery key.
//
// Backup blob format (client-side):
//   nonce (12 bytes) || ciphertext (variable) || GCM tag (16 bytes)
//
// The server validates:
//   - Minimum blob length (nonce + tag = 28 bytes minimum)
//   - Salt length (must be exactly 32 bytes)
//   - Maximum blob size (10 MB, enforced separately by the handler)

use thiserror::Error;

/// AES-256-GCM nonce length.
const AES_GCM_NONCE_BYTES: usize = 12;

/// AES-256-GCM authentication tag length.
const AES_GCM_TAG_BYTES: usize = 16;

/// Minimum encrypted backup blob size: nonce + at least 1 byte ciphertext + tag.
const MIN_BACKUP_BLOB_SIZE: usize = AES_GCM_NONCE_BYTES + 1 + AES_GCM_TAG_BYTES;

/// Expected HKDF salt length for key derivation.
const EXPECTED_SALT_LEN: usize = 32;

#[derive(Debug, Error)]
pub enum BackupValidationError {
    #[error(
        "encrypted backup too short: minimum {MIN_BACKUP_BLOB_SIZE} bytes (nonce + ciphertext + tag), got {0}"
    )]
    TooShort(usize),

    #[error("key derivation salt must be {EXPECTED_SALT_LEN} bytes, got {0}")]
    InvalidSaltLength(usize),
}

/// Validate the structural format of an encrypted key backup blob.
///
/// This checks:
///   - The blob is long enough to contain nonce (12) + at least 1 byte + tag (16).
///   - The salt is exactly 32 bytes.
///
/// The server cannot and should not attempt decryption — only the client holds
/// the recovery key.
pub fn validate_backup_blob(
    encrypted_backup: &[u8],
    key_derivation_salt: &[u8],
) -> Result<(), BackupValidationError> {
    if encrypted_backup.len() < MIN_BACKUP_BLOB_SIZE {
        return Err(BackupValidationError::TooShort(encrypted_backup.len()));
    }
    if key_derivation_salt.len() != EXPECTED_SALT_LEN {
        return Err(BackupValidationError::InvalidSaltLength(
            key_derivation_salt.len(),
        ));
    }
    Ok(())
}
