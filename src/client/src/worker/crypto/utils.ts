// Low-level cryptographic utilities using libsodium-wrappers.
// All operations require sodium to be initialized via ensureSodium().

import sodium from 'libsodium-wrappers'
import type { KeyPair, SigningKeyPair } from './types'

let initialized = false

/** Initialize libsodium. Must be awaited before any crypto operations. */
export async function ensureSodium(): Promise<typeof sodium> {
  if (!initialized) {
    await sodium.ready
    initialized = true
  }
  return sodium
}

/** Generate an Ed25519 signing keypair (for Master Verify Key). */
export function generateEd25519KeyPair(): SigningKeyPair {
  const kp = sodium.crypto_sign_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

/** Generate an X25519 key agreement keypair (for Device Identity Key, pre-keys). */
export function generateX25519KeyPair(): KeyPair {
  const kp = sodium.crypto_box_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

/** Create an Ed25519 detached signature. */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return sodium.crypto_sign_detached(message, privateKey)
}

/** Verify an Ed25519 detached signature. Returns true if valid. */
export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return sodium.crypto_sign_verify_detached(signature, message, publicKey)
  } catch {
    return false
  }
}

/** Generate cryptographically secure random bytes. */
export function randomBytes(n: number): Uint8Array {
  return sodium.randombytes_buf(n)
}

/** Zero-fill a Uint8Array to erase sensitive key material from memory. */
export function memzero(buf: Uint8Array): void {
  sodium.memzero(buf)
}

/** Convert an Ed25519 signing keypair to an X25519 key agreement keypair. */
export function identityKeyToX25519(kp: SigningKeyPair): KeyPair {
  return {
    publicKey: sodium.crypto_sign_ed25519_pk_to_curve25519(kp.publicKey),
    privateKey: sodium.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey),
  }
}

/** Perform raw X25519 Diffie-Hellman: shared = myPrivate * theirPublic. */
export function x25519DH(myPrivateKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return sodium.crypto_scalarmult(myPrivateKey, theirPublicKey)
}

// --- Key serialization ---

/** Serialize an X25519 KeyPair to bytes: publicKey || privateKey. */
export function keyPairToBytes(kp: KeyPair): Uint8Array {
  const buf = new Uint8Array(kp.publicKey.length + kp.privateKey.length)
  buf.set(kp.publicKey, 0)
  buf.set(kp.privateKey, kp.publicKey.length)
  return buf
}

/** Deserialize an X25519 KeyPair from bytes. */
export function bytesToKeyPair(bytes: Uint8Array): KeyPair {
  const pubLen = sodium.crypto_box_PUBLICKEYBYTES
  const privLen = sodium.crypto_box_SECRETKEYBYTES
  if (bytes.length !== pubLen + privLen) {
    throw new Error(`Invalid X25519 keypair bytes: expected ${pubLen + privLen}, got ${bytes.length}`)
  }
  return {
    publicKey: bytes.slice(0, pubLen),
    privateKey: bytes.slice(pubLen),
  }
}

/** Serialize an Ed25519 SigningKeyPair to bytes: publicKey || privateKey. */
export function signingKeyPairToBytes(kp: SigningKeyPair): Uint8Array {
  const buf = new Uint8Array(kp.publicKey.length + kp.privateKey.length)
  buf.set(kp.publicKey, 0)
  buf.set(kp.privateKey, kp.publicKey.length)
  return buf
}

/** Deserialize an Ed25519 SigningKeyPair from bytes. */
export function bytesToSigningKeyPair(bytes: Uint8Array): SigningKeyPair {
  const pubLen = sodium.crypto_sign_PUBLICKEYBYTES
  const privLen = sodium.crypto_sign_SECRETKEYBYTES
  if (bytes.length !== pubLen + privLen) {
    throw new Error(
      `Invalid Ed25519 keypair bytes: expected ${pubLen + privLen}, got ${bytes.length}`,
    )
  }
  return {
    publicKey: bytes.slice(0, pubLen),
    privateKey: bytes.slice(pubLen),
  }
}
