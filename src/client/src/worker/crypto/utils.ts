// Low-level cryptographic utilities using libsodium-wrappers.
// All operations require sodium to be initialized via ensureSodium().

import sodium from 'libsodium-wrappers'
import { createHmac } from 'crypto'
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

// --- HKDF-SHA256 ---

/**
 * HMAC-SHA256 using Node.js crypto (available in worker threads).
 * libsodium-wrappers (non-sumo) does not include crypto_auth_hmacsha256.
 */
function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const hmac = createHmac('sha256', key)
  hmac.update(message)
  return new Uint8Array(hmac.digest())
}

/**
 * HKDF-SHA256 key derivation (RFC 5869).
 *
 * @param ikm - Input keying material (arbitrary length)
 * @param salt - Salt value (arbitrary length; if empty, defaults to 32 zero bytes)
 * @param info - Context/application-specific info string
 * @param length - Desired output length in bytes (max 255 * 32)
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  if (length < 1 || length > 255 * 32) {
    throw new Error('HKDF output length out of range')
  }

  // Extract: PRK = HMAC-SHA256(salt, IKM)
  const prk = hmacSha256(salt, ikm)

  // Expand: T(i) = HMAC-SHA256(PRK, T(i-1) || info || i)
  const n = Math.ceil(length / 32)
  const okm = new Uint8Array(n * 32)
  let prev = new Uint8Array(0)

  for (let i = 1; i <= n; i++) {
    const input = new Uint8Array(prev.length + info.length + 1)
    input.set(prev, 0)
    input.set(info, prev.length)
    input[prev.length + info.length] = i

    const oldPrev = prev
    prev = hmacSha256(prk, input)
    okm.set(prev, (i - 1) * 32)

    // Zero intermediate keying material
    if (oldPrev.length > 0) sodium.memzero(oldPrev)
    sodium.memzero(input)
  }

  sodium.memzero(prk)
  // Zero the final prev (copy is already in okm)
  sodium.memzero(prev)
  return length === okm.length ? okm : okm.slice(0, length)
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
