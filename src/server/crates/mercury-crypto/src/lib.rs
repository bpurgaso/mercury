// Server-side cryptographic validation for Mercury.
//
// The server does NOT perform any E2E encryption or decryption — that is
// exclusively the client's responsibility. This crate provides three
// categories of server-side validation:
//
//   1. **verify** — Ed25519 signature verification for uploaded X3DH key
//      bundles (the signed pre-key must be signed by the device identity key).
//
//   2. **device_list** — Ed25519 signature verification on signed device lists
//      to enforce Trust-On-First-Use (TOFU) identity.
//
//   3. **backup** — Structural validation of encrypted key backup blobs
//      (correct minimum length, salt size) without ever decrypting them.

pub mod backup;
pub mod device_list;
pub mod verify;
