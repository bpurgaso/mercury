// Ed25519 signature verification for X3DH key bundle uploads.
//
// When a client uploads a key bundle via PUT /devices/:id/keys, the signed
// pre-key's signature must be verified against the device's Ed25519 identity
// key. This prevents a malicious actor from uploading a pre-key that the
// device never actually signed.

use ring::signature::{self, UnparsedPublicKey};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SignatureVerifyError {
    #[error("Ed25519 signature verification failed")]
    InvalidSignature,

    #[error("invalid key length: expected {expected} bytes, got {actual}")]
    InvalidKeyLength { expected: usize, actual: usize },
}

/// Ed25519 public key length (32 bytes).
pub const ED25519_PUBLIC_KEY_LEN: usize = 32;

/// Ed25519 signature length (64 bytes).
pub const ED25519_SIGNATURE_LEN: usize = 64;

/// Verify that `prekey_signature` is a valid Ed25519 signature over
/// `signed_prekey` produced by the holder of `identity_key`.
///
/// This is called during key bundle upload to ensure the signed pre-key
/// was actually signed by the device's identity key.
pub fn verify_prekey_signature(
    identity_key: &[u8],
    signed_prekey: &[u8],
    prekey_signature: &[u8],
) -> Result<(), SignatureVerifyError> {
    if identity_key.len() != ED25519_PUBLIC_KEY_LEN {
        return Err(SignatureVerifyError::InvalidKeyLength {
            expected: ED25519_PUBLIC_KEY_LEN,
            actual: identity_key.len(),
        });
    }
    if prekey_signature.len() != ED25519_SIGNATURE_LEN {
        return Err(SignatureVerifyError::InvalidKeyLength {
            expected: ED25519_SIGNATURE_LEN,
            actual: prekey_signature.len(),
        });
    }

    let public_key = UnparsedPublicKey::new(&signature::ED25519, identity_key);
    public_key
        .verify(signed_prekey, prekey_signature)
        .map_err(|_| SignatureVerifyError::InvalidSignature)
}

/// Verify a generic Ed25519 detached signature.
pub fn verify_ed25519(
    public_key: &[u8],
    message: &[u8],
    signature_bytes: &[u8],
) -> Result<(), SignatureVerifyError> {
    if public_key.len() != ED25519_PUBLIC_KEY_LEN {
        return Err(SignatureVerifyError::InvalidKeyLength {
            expected: ED25519_PUBLIC_KEY_LEN,
            actual: public_key.len(),
        });
    }
    if signature_bytes.len() != ED25519_SIGNATURE_LEN {
        return Err(SignatureVerifyError::InvalidKeyLength {
            expected: ED25519_SIGNATURE_LEN,
            actual: signature_bytes.len(),
        });
    }

    let key = UnparsedPublicKey::new(&signature::ED25519, public_key);
    key.verify(message, signature_bytes)
        .map_err(|_| SignatureVerifyError::InvalidSignature)
}
