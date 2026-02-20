// X3DH (Extended Triple Diffie-Hellman) key agreement protocol.
// Implements initiator and responder sides per the Signal X3DH spec,
// adapted for Mercury's key hierarchy (Ed25519 identity keys converted
// to X25519 for DH operations).
//
// All operations run in the Worker Thread, never in the Renderer.

import sodium from 'libsodium-wrappers'
import type {
  SigningKeyPair,
  SignedPreKey,
  PreKey,
  KeyBundle,
  X3DHResult,
  SessionState,
} from './types'
import {
  verify,
  identityKeyToX25519,
  x25519DH,
  generateX25519KeyPair,
  memzero,
  hkdfSha256,
} from './utils'

const X3DH_INFO = new TextEncoder().encode('mercury-x3dh-v1')
const HKDF_SALT = new Uint8Array(32) // 32 zero bytes per Signal X3DH spec
const DH_OUTPUT_SIZE = 32
// Signal X3DH spec §3.3: prepend 32 bytes of 0xFF for domain separation
const FF_PREFIX = new Uint8Array(DH_OUTPUT_SIZE).fill(0xff)

// --- Initial session serialization ---
// Binary format for the initial Double Ratchet session state (Phase 6c will consume this):
//   [1] version (0x01)
//   [1] flags   (bit 0 = isInitiator, bit 1 = hasPreKeyId)
//   [4] preKeyId (big-endian uint32, 0 if unused)
//   [32] sharedSecret
//   [32] remoteIdentityKey (Ed25519 public)
//   [32] localIdentityKey  (Ed25519 public)
//   [32] ephemeralPublicKey (X25519 public)
//   [8] createdAt (big-endian uint64, Unix ms)
// Total: 142 bytes

const SESSION_VERSION = 0x01
const SESSION_SIZE = 142

/**
 * Perform X3DH key agreement as the initiator (Alice).
 *
 * Steps:
 * 1. Verify signed pre-key signature (abort if invalid)
 * 2. Generate ephemeral X25519 keypair
 * 3. Compute DH1–DH4 (DH4 only if one-time pre-key available)
 * 4. Derive 32-byte shared secret via HKDF-SHA256
 * 5. Zero all ephemeral/intermediate secrets from memory
 *
 * @param ourIdentityKey  - Our Ed25519 identity keypair (Device Identity Key)
 * @param theirKeyBundle  - Recipient's key bundle (Ed25519 identity + X25519 pre-keys)
 * @returns X3DH result with shared secret, ephemeral public key, and used pre-key ID
 * @throws If signed pre-key signature verification fails
 */
export function performX3DH(
  ourIdentityKey: SigningKeyPair,
  theirKeyBundle: KeyBundle,
): X3DHResult {
  // 1. Verify the signed pre-key signature before any DH operations
  const sigValid = verify(
    theirKeyBundle.signedPreKey.publicKey,
    theirKeyBundle.signedPreKey.signature,
    theirKeyBundle.identityKey,
  )
  if (!sigValid) {
    throw new Error('X3DH: signed pre-key signature verification failed')
  }

  // 2. Generate ephemeral X25519 keypair
  const ephemeral = generateX25519KeyPair()

  // 3. Convert identity keys from Ed25519 to X25519 for DH
  const ourIdentityX25519 = identityKeyToX25519(ourIdentityKey)
  const theirIdentityX25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(
    theirKeyBundle.identityKey,
  )

  // 4. Compute DH operations
  const dh1 = x25519DH(ourIdentityX25519.privateKey, theirKeyBundle.signedPreKey.publicKey)
  const dh2 = x25519DH(ephemeral.privateKey, theirIdentityX25519Public)
  const dh3 = x25519DH(ephemeral.privateKey, theirKeyBundle.signedPreKey.publicKey)

  let dhConcat: Uint8Array
  let usedPreKeyId: number | undefined

  // Signal X3DH spec §3.3: IKM = F || DH1 || DH2 || DH3 [|| DH4]
  // F = 32 bytes of 0xFF (domain separation — prevents DH output collision)
  if (theirKeyBundle.oneTimePreKey) {
    const dh4 = x25519DH(ephemeral.privateKey, theirKeyBundle.oneTimePreKey.publicKey)
    usedPreKeyId = theirKeyBundle.oneTimePreKey.keyId

    dhConcat = new Uint8Array(DH_OUTPUT_SIZE + 128)
    dhConcat.set(FF_PREFIX, 0)
    dhConcat.set(dh1, 32)
    dhConcat.set(dh2, 64)
    dhConcat.set(dh3, 96)
    dhConcat.set(dh4, 128)
    memzero(dh4)
  } else {
    dhConcat = new Uint8Array(DH_OUTPUT_SIZE + 96)
    dhConcat.set(FF_PREFIX, 0)
    dhConcat.set(dh1, 32)
    dhConcat.set(dh2, 64)
    dhConcat.set(dh3, 96)
  }

  // 5. Derive shared secret via HKDF-SHA256
  const sharedSecret = hkdfSha256(dhConcat, HKDF_SALT, X3DH_INFO, 32)

  // 6. Zero all intermediate secrets
  memzero(dh1)
  memzero(dh2)
  memzero(dh3)
  memzero(dhConcat)
  memzero(ourIdentityX25519.privateKey)
  memzero(ephemeral.privateKey)

  return {
    sharedSecret,
    ephemeralPublicKey: ephemeral.publicKey,
    usedPreKeyId,
  }
}

/**
 * Respond to an X3DH key agreement (Bob side).
 *
 * Computes the mirror DH operations to derive the same shared secret.
 * The caller MUST delete the consumed one-time pre-key from the local
 * store after this function returns (via keyStore.markOneTimePreKeyUsed).
 *
 * @param ourIdentityKey   - Our Ed25519 identity keypair
 * @param ourSignedPreKey  - Our signed pre-key (X25519, with private key)
 * @param ourOneTimePreKey - Our consumed one-time pre-key (null if not used)
 * @param theirIdentityKey - Initiator's Ed25519 identity public key
 * @param theirEphemeralKey - Initiator's ephemeral X25519 public key
 * @returns 32-byte shared secret matching the initiator's
 */
export function respondX3DH(
  ourIdentityKey: SigningKeyPair,
  ourSignedPreKey: SignedPreKey,
  ourOneTimePreKey: PreKey | null,
  theirIdentityKey: Uint8Array,
  theirEphemeralKey: Uint8Array,
): Uint8Array {
  // Validate input key lengths
  if (theirIdentityKey.length !== 32) {
    throw new Error(`X3DH: invalid identity key length: expected 32, got ${theirIdentityKey.length}`)
  }
  if (theirEphemeralKey.length !== 32) {
    throw new Error(`X3DH: invalid ephemeral key length: expected 32, got ${theirEphemeralKey.length}`)
  }

  // Convert identity keys from Ed25519 to X25519 for DH
  const ourIdentityX25519 = identityKeyToX25519(ourIdentityKey)
  const theirIdentityX25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(theirIdentityKey)

  // Mirror DH operations (DH is commutative: a*B == b*A)
  // DH1: initiator used (identityPrivate × signedPreKeyPublic),
  //       we use     (signedPreKeyPrivate × identityPublic)
  const dh1 = x25519DH(ourSignedPreKey.keyPair.privateKey, theirIdentityX25519Public)
  // DH2: initiator used (ephemeralPrivate × identityPublic),
  //       we use     (identityPrivate × ephemeralPublic)
  const dh2 = x25519DH(ourIdentityX25519.privateKey, theirEphemeralKey)
  // DH3: initiator used (ephemeralPrivate × signedPreKeyPublic),
  //       we use     (signedPreKeyPrivate × ephemeralPublic)
  const dh3 = x25519DH(ourSignedPreKey.keyPair.privateKey, theirEphemeralKey)

  let dhConcat: Uint8Array

  // Signal X3DH spec §3.3: IKM = F || DH1 || DH2 || DH3 [|| DH4]
  if (ourOneTimePreKey) {
    // DH4: initiator used (ephemeralPrivate × oneTimePreKeyPublic),
    //       we use     (oneTimePreKeyPrivate × ephemeralPublic)
    const dh4 = x25519DH(ourOneTimePreKey.keyPair.privateKey, theirEphemeralKey)
    dhConcat = new Uint8Array(DH_OUTPUT_SIZE + 128)
    dhConcat.set(FF_PREFIX, 0)
    dhConcat.set(dh1, 32)
    dhConcat.set(dh2, 64)
    dhConcat.set(dh3, 96)
    dhConcat.set(dh4, 128)
    memzero(dh4)
  } else {
    dhConcat = new Uint8Array(DH_OUTPUT_SIZE + 96)
    dhConcat.set(FF_PREFIX, 0)
    dhConcat.set(dh1, 32)
    dhConcat.set(dh2, 64)
    dhConcat.set(dh3, 96)
  }

  // Derive shared secret via HKDF-SHA256
  const sharedSecret = hkdfSha256(dhConcat, HKDF_SALT, X3DH_INFO, 32)

  // Zero intermediate secrets (only our allocations, not caller-owned keys)
  memzero(dh1)
  memzero(dh2)
  memzero(dh3)
  memzero(dhConcat)
  memzero(ourIdentityX25519.privateKey)

  return sharedSecret
}

/**
 * Create an initial Double Ratchet session state from X3DH output.
 * Stores the shared secret and key material needed to initialize
 * the full Double Ratchet in Phase 6c.
 *
 * @returns SessionState containing the serialized initial state
 */
export function createInitialSession(
  sharedSecret: Uint8Array,
  remoteIdentityKey: Uint8Array,
  localIdentityKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  usedPreKeyId: number | undefined,
  isInitiator: boolean,
): SessionState {
  const data = new Uint8Array(SESSION_SIZE)
  const view = new DataView(data.buffer)

  let offset = 0

  // Version
  data[offset++] = SESSION_VERSION

  // Flags
  let flags = 0
  if (isInitiator) flags |= 0x01
  if (usedPreKeyId !== undefined) flags |= 0x02
  data[offset++] = flags

  // Pre-key ID (big-endian uint32)
  view.setUint32(offset, usedPreKeyId ?? 0, false)
  offset += 4

  // Key material
  data.set(sharedSecret, offset)
  offset += 32
  data.set(remoteIdentityKey, offset)
  offset += 32
  data.set(localIdentityKey, offset)
  offset += 32
  data.set(ephemeralPublicKey, offset)
  offset += 32

  // Timestamp (big-endian uint64 — split into high/low 32-bit words)
  const now = Date.now()
  view.setUint32(offset, Math.floor(now / 0x100000000), false)
  view.setUint32(offset + 4, now >>> 0, false)

  return { data }
}

/**
 * Parse the version and isInitiator flag from a serialized initial session.
 * Useful for Phase 6c to determine which side initiated the ratchet.
 */
export function parseInitialSession(state: SessionState): {
  version: number
  isInitiator: boolean
  hasPreKeyId: boolean
  preKeyId: number
  sharedSecret: Uint8Array
  remoteIdentityKey: Uint8Array
  localIdentityKey: Uint8Array
  ephemeralPublicKey: Uint8Array
  createdAt: number
} {
  if (state.data.length !== SESSION_SIZE) {
    throw new Error(`Invalid initial session size: expected ${SESSION_SIZE}, got ${state.data.length}`)
  }

  const view = new DataView(state.data.buffer, state.data.byteOffset, state.data.byteLength)
  let offset = 0

  const version = state.data[offset++]
  if (version !== SESSION_VERSION) {
    throw new Error(`Unsupported session version: ${version}`)
  }

  const flags = state.data[offset++]
  const isInitiator = (flags & 0x01) !== 0
  const hasPreKeyId = (flags & 0x02) !== 0

  const preKeyId = view.getUint32(offset, false)
  offset += 4

  const sharedSecret = state.data.slice(offset, offset + 32)
  offset += 32
  const remoteIdentityKey = state.data.slice(offset, offset + 32)
  offset += 32
  const localIdentityKey = state.data.slice(offset, offset + 32)
  offset += 32
  const ephemeralPublicKey = state.data.slice(offset, offset + 32)
  offset += 32

  const high = view.getUint32(offset, false)
  const low = view.getUint32(offset + 4, false)
  const createdAt = high * 0x100000000 + low

  return {
    version,
    isInitiator,
    hasPreKeyId,
    preKeyId,
    sharedSecret,
    remoteIdentityKey,
    localIdentityKey,
    ephemeralPublicKey,
    createdAt,
  }
}
