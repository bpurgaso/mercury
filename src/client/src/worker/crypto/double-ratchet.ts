// Double Ratchet Protocol — provides forward secrecy and break-in recovery
// for all E2E DM messages after the initial X3DH key agreement.
//
// Implements the Signal Double Ratchet algorithm using:
// - X25519 for DH ratchet steps
// - HKDF-SHA256 for key derivation (root + chain KDFs)
// - XChaCha20-Poly1305 for AEAD message encryption
//
// All operations run in the Worker Thread, never in the Renderer.

import sodium from 'libsodium-wrappers'
import type { KeyPair, SessionState } from './types'
import {
  generateX25519KeyPair,
  x25519DH,
  hkdfSha256,
  memzero,
  randomBytes,
  keyPairToBytes,
  bytesToKeyPair,
} from './utils'

// --- Constants ---

const SESSION_VERSION = 0x02
const RK_INFO = new TextEncoder().encode('mercury-rk-v1')
const CK_INFO = new TextEncoder().encode('mercury-ck-v1')
const MK_INFO = new TextEncoder().encode('mercury-mk-v1')
const CHAIN_KDF_SALT = new Uint8Array(32) // 32 zero bytes
const MAX_SKIP = 1000
const HEADER_SIZE = 40 // 32 (dh) + 4 (pn) + 4 (n)
const NONCE_SIZE = 24 // XChaCha20 nonce size
const TAG_SIZE = 16 // Poly1305 auth tag size

// --- Types ---

export interface MessageHeader {
  dh: Uint8Array // 32 bytes — sender's current ratchet public key
  pn: number // Previous sending chain length
  n: number // Message number in current sending chain
}

export interface RatchetMessage {
  header: MessageHeader
  ciphertext: Uint8Array // AEAD ciphertext (includes auth tag)
  nonce: Uint8Array // 24-byte XChaCha20 nonce
}

/** Internal Double Ratchet state — never exposed directly. */
interface DoubleRatchetState {
  DHs: KeyPair // Our current ratchet keypair
  DHr: Uint8Array | null // Their current ratchet public key
  RK: Uint8Array // Root key (32 bytes)
  CKs: Uint8Array | null // Sending chain key
  CKr: Uint8Array | null // Receiving chain key
  Ns: number // Sending message counter
  Nr: number // Receiving message counter
  PN: number // Previous sending chain length
  MKSKIPPED: Map<string, Uint8Array> // hex(dhPub):msgNum → msgKey
}

// --- KDF Operations ---

/** Root KDF: ratchet the root key when DH keys change. Returns [newRK, newCK]. */
function rootKdf(rk: Uint8Array, dhOutput: Uint8Array): [Uint8Array, Uint8Array] {
  const derived = hkdfSha256(dhOutput, rk, RK_INFO, 64)
  const newRK = derived.slice(0, 32)
  const newCK = derived.slice(32, 64)
  memzero(derived)
  return [newRK, newCK]
}

/**
 * Chain KDF: advance chain key and derive message key. Returns [newCK, messageKey].
 * Both are derived from the same current CK but with different info strings,
 * producing cryptographically independent outputs.
 */
function chainKdf(ck: Uint8Array): [Uint8Array, Uint8Array] {
  const newCK = hkdfSha256(ck, CHAIN_KDF_SALT, CK_INFO, 32)
  const messageKey = hkdfSha256(ck, CHAIN_KDF_SALT, MK_INFO, 32)
  return [newCK, messageKey]
}

// --- Header serialization ---

function serializeHeader(header: MessageHeader): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE)
  const view = new DataView(buf.buffer)
  buf.set(header.dh, 0)
  view.setUint32(32, header.pn, false)
  view.setUint32(36, header.n, false)
  return buf
}

function deserializeHeader(data: Uint8Array): MessageHeader {
  if (data.length !== HEADER_SIZE) {
    throw new Error(`Invalid header size: expected ${HEADER_SIZE}, got ${data.length}`)
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    dh: data.slice(0, 32),
    pn: view.getUint32(32, false),
    n: view.getUint32(36, false),
  }
}

// --- AEAD encryption/decryption ---

function aeadEncrypt(
  plaintext: Uint8Array,
  messageKey: Uint8Array,
  headerBytes: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(NONCE_SIZE)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    headerBytes,
    null, // nsec (always null)
    nonce,
    messageKey,
  )
  return { ciphertext, nonce }
}

function aeadDecrypt(
  ciphertext: Uint8Array,
  messageKey: Uint8Array,
  nonce: Uint8Array,
  headerBytes: Uint8Array,
): Uint8Array {
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // nsec (always null)
      ciphertext,
      headerBytes,
      nonce,
      messageKey,
    )
  } catch {
    throw new Error('Double Ratchet: message authentication failed')
  }
}

// --- Skipped key management ---

function makeSkippedKey(dhPub: Uint8Array, n: number): string {
  return sodium.to_hex(dhPub) + ':' + n
}

function skipMessageKeys(state: DoubleRatchetState, until: number): void {
  if (until < state.Nr) return
  if (until - state.Nr > MAX_SKIP) {
    throw new Error(
      `Double Ratchet: too many skipped messages (${until - state.Nr} > ${MAX_SKIP})`,
    )
  }
  if (state.CKr === null) {
    // No receiving chain — only valid when until === Nr (nothing to skip)
    if (until > state.Nr) {
      throw new Error('Double Ratchet: cannot skip messages without receiving chain key')
    }
    return
  }

  for (let i = state.Nr; i < until; i++) {
    const [newCKr, messageKey] = chainKdf(state.CKr)
    memzero(state.CKr)
    state.CKr = newCKr
    state.MKSKIPPED.set(makeSkippedKey(state.DHr!, i), messageKey)
  }

  // Evict oldest entries if over limit (Map preserves insertion order)
  if (state.MKSKIPPED.size > MAX_SKIP) {
    const excess = state.MKSKIPPED.size - MAX_SKIP
    const iter = state.MKSKIPPED.keys()
    for (let i = 0; i < excess; i++) {
      const key = iter.next().value as string
      const mk = state.MKSKIPPED.get(key)!
      memzero(mk)
      state.MKSKIPPED.delete(key)
    }
  }
}

// --- Byte comparison (public keys, no timing concern) ---

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// --- Session state serialization ---
// Binary format (version-tagged):
//   [1]  version = 0x02
//   [1]  flags: bit0 = hasDHr, bit1 = hasCKs, bit2 = hasCKr
//   [64] DHs (public 32 + private 32)
//   [32] DHr (if hasDHr)
//   [32] RK
//   [32] CKs (if hasCKs)
//   [32] CKr (if hasCKr)
//   [4]  Ns (uint32 BE)
//   [4]  Nr (uint32 BE)
//   [4]  PN (uint32 BE)
//   [4]  skippedCount (uint32 BE)
//   [68 * skippedCount] entries: dhPub(32) + msgNum(4 BE) + msgKey(32)

function serializeState(state: DoubleRatchetState): SessionState {
  let flags = 0
  if (state.DHr !== null) flags |= 0x01
  if (state.CKs !== null) flags |= 0x02
  if (state.CKr !== null) flags |= 0x04

  // Calculate total size
  let size = 1 + 1 + 64 + 32 + 4 + 4 + 4 + 4 // version + flags + DHs + RK + Ns + Nr + PN + skippedCount
  if (state.DHr !== null) size += 32
  if (state.CKs !== null) size += 32
  if (state.CKr !== null) size += 32
  size += state.MKSKIPPED.size * 68

  const data = new Uint8Array(size)
  const view = new DataView(data.buffer)
  let offset = 0

  data[offset++] = SESSION_VERSION
  data[offset++] = flags

  // DHs (public 32 + private 32)
  const dhsBytes = keyPairToBytes(state.DHs)
  data.set(dhsBytes, offset)
  offset += 64

  if (state.DHr !== null) {
    data.set(state.DHr, offset)
    offset += 32
  }

  data.set(state.RK, offset)
  offset += 32

  if (state.CKs !== null) {
    data.set(state.CKs, offset)
    offset += 32
  }

  if (state.CKr !== null) {
    data.set(state.CKr, offset)
    offset += 32
  }

  view.setUint32(offset, state.Ns, false)
  offset += 4
  view.setUint32(offset, state.Nr, false)
  offset += 4
  view.setUint32(offset, state.PN, false)
  offset += 4

  view.setUint32(offset, state.MKSKIPPED.size, false)
  offset += 4
  for (const [key, msgKey] of state.MKSKIPPED) {
    const colonIdx = key.lastIndexOf(':')
    const dhHex = key.substring(0, colonIdx)
    const msgNum = parseInt(key.substring(colonIdx + 1), 10)
    const dhPub = sodium.from_hex(dhHex)
    data.set(dhPub, offset)
    offset += 32
    view.setUint32(offset, msgNum, false)
    offset += 4
    data.set(msgKey, offset)
    offset += 32
  }

  return { data }
}

function deserializeState(session: SessionState): DoubleRatchetState {
  const data = session.data
  if (data.length < 2) {
    throw new Error('Double Ratchet: session data too short')
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0

  const version = data[offset++]
  if (version !== SESSION_VERSION) {
    throw new Error(`Double Ratchet: unsupported session version ${version}`)
  }

  const flags = data[offset++]
  const hasDHr = (flags & 0x01) !== 0
  const hasCKs = (flags & 0x02) !== 0
  const hasCKr = (flags & 0x04) !== 0

  const DHs = bytesToKeyPair(data.slice(offset, offset + 64))
  offset += 64

  let DHr: Uint8Array | null = null
  if (hasDHr) {
    DHr = data.slice(offset, offset + 32)
    offset += 32
  }

  const RK = data.slice(offset, offset + 32)
  offset += 32

  let CKs: Uint8Array | null = null
  if (hasCKs) {
    CKs = data.slice(offset, offset + 32)
    offset += 32
  }

  let CKr: Uint8Array | null = null
  if (hasCKr) {
    CKr = data.slice(offset, offset + 32)
    offset += 32
  }

  const Ns = view.getUint32(offset, false)
  offset += 4
  const Nr = view.getUint32(offset, false)
  offset += 4
  const PN = view.getUint32(offset, false)
  offset += 4

  const skippedCount = view.getUint32(offset, false)
  offset += 4
  const MKSKIPPED = new Map<string, Uint8Array>()
  for (let i = 0; i < skippedCount; i++) {
    const dhPub = data.slice(offset, offset + 32)
    offset += 32
    const msgNum = view.getUint32(offset, false)
    offset += 4
    const msgKey = data.slice(offset, offset + 32)
    offset += 32
    MKSKIPPED.set(makeSkippedKey(dhPub, msgNum), msgKey)
  }

  return { DHs, DHr, RK, CKs, CKr, Ns, Nr, PN, MKSKIPPED }
}

// --- Public API ---

/**
 * Initialize a Double Ratchet session as the sender (X3DH initiator, Alice).
 *
 * 1. Generates a new DH ratchet keypair
 * 2. Sets DHr to the responder's signed pre-key public key
 * 3. Performs root KDF with DH output and shared secret to derive RK and CKs
 */
export function initSenderSession(
  sharedSecret: Uint8Array,
  theirDHPublicKey: Uint8Array,
): SessionState {
  if (sharedSecret.length !== 32) {
    throw new Error(`Invalid shared secret length: expected 32, got ${sharedSecret.length}`)
  }
  if (theirDHPublicKey.length !== 32) {
    throw new Error(`Invalid DH public key length: expected 32, got ${theirDHPublicKey.length}`)
  }

  const DHs = generateX25519KeyPair()
  const DHr = new Uint8Array(theirDHPublicKey)

  const dhOutput = x25519DH(DHs.privateKey, DHr)
  const [RK, CKs] = rootKdf(sharedSecret, dhOutput)
  memzero(dhOutput)

  const state: DoubleRatchetState = {
    DHs,
    DHr,
    RK,
    CKs,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  }

  return serializeState(state)
}

/**
 * Initialize a Double Ratchet session as the receiver (X3DH responder, Bob).
 *
 * Sets DHs to our signed pre-key pair and RK to the shared secret.
 * CKs and CKr remain null until the first message triggers a DH ratchet.
 */
export function initReceiverSession(
  sharedSecret: Uint8Array,
  ourDHKeyPair: KeyPair,
): SessionState {
  if (sharedSecret.length !== 32) {
    throw new Error(`Invalid shared secret length: expected 32, got ${sharedSecret.length}`)
  }

  const state: DoubleRatchetState = {
    DHs: {
      publicKey: new Uint8Array(ourDHKeyPair.publicKey),
      privateKey: new Uint8Array(ourDHKeyPair.privateKey),
    },
    DHr: null,
    RK: new Uint8Array(sharedSecret),
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  }

  return serializeState(state)
}

/**
 * Encrypt a plaintext message using the Double Ratchet.
 *
 * Returns the updated session state (caller must persist) and the encrypted message.
 * Throws if the sending chain key has not been initialized (receiver must
 * decrypt at least one message before sending).
 */
export function ratchetEncrypt(
  sessionState: SessionState,
  plaintext: Uint8Array,
): { session: SessionState; message: RatchetMessage } {
  const state = deserializeState(sessionState)

  if (state.CKs === null) {
    throw new Error(
      'Double Ratchet: cannot encrypt without sending chain key (must receive first)',
    )
  }

  // Derive message key from sending chain
  const [newCKs, messageKey] = chainKdf(state.CKs)
  memzero(state.CKs)
  state.CKs = newCKs

  // Build and serialize header
  const header: MessageHeader = {
    dh: new Uint8Array(state.DHs.publicKey),
    pn: state.PN,
    n: state.Ns,
  }
  const headerBytes = serializeHeader(header)

  // AEAD encrypt with header as associated data
  const { ciphertext, nonce } = aeadEncrypt(plaintext, messageKey, headerBytes)
  memzero(messageKey)

  state.Ns++

  return {
    session: serializeState(state),
    message: { header, ciphertext, nonce },
  }
}

/**
 * Decrypt a message using the Double Ratchet.
 *
 * Handles out-of-order delivery via skipped message keys, and performs
 * DH ratchet steps when the sender's ratchet key changes.
 *
 * Returns the updated session state (caller must persist) and the plaintext.
 * Throws on authentication failure or if too many messages were skipped.
 */
export function ratchetDecrypt(
  sessionState: SessionState,
  message: RatchetMessage,
): { session: SessionState; plaintext: Uint8Array } {
  const state = deserializeState(sessionState)
  const headerBytes = serializeHeader(message.header)

  // 1. Try skipped message keys first
  const skippedKey = makeSkippedKey(message.header.dh, message.header.n)
  const storedMK = state.MKSKIPPED.get(skippedKey)
  if (storedMK) {
    state.MKSKIPPED.delete(skippedKey)
    const plaintext = aeadDecrypt(message.ciphertext, storedMK, message.nonce, headerBytes)
    memzero(storedMK)
    return { session: serializeState(state), plaintext }
  }

  // 2. DH ratchet step if sender's ratchet key changed
  if (state.DHr === null || !bytesEqual(message.header.dh, state.DHr)) {
    // Skip remaining messages in the OLD receiving chain
    skipMessageKeys(state, message.header.pn)

    // Update ratchet state
    state.PN = state.Ns
    state.Ns = 0
    state.Nr = 0
    state.DHr = new Uint8Array(message.header.dh)

    // Derive new receiving chain key
    const dhOutput1 = x25519DH(state.DHs.privateKey, state.DHr)
    const [newRK1, newCKr] = rootKdf(state.RK, dhOutput1)
    memzero(dhOutput1)
    memzero(state.RK)
    state.RK = newRK1
    state.CKr = newCKr

    // Generate new sending keypair and derive new sending chain key
    const oldDHsPrivate = state.DHs.privateKey
    state.DHs = generateX25519KeyPair()
    memzero(oldDHsPrivate)

    const dhOutput2 = x25519DH(state.DHs.privateKey, state.DHr)
    const [newRK2, newCKs] = rootKdf(state.RK, dhOutput2)
    memzero(dhOutput2)
    memzero(state.RK)
    state.RK = newRK2
    if (state.CKs) memzero(state.CKs)
    state.CKs = newCKs
  }

  // 3. Skip messages in the current receiving chain up to this message
  skipMessageKeys(state, message.header.n)

  // 4. Derive message key
  if (state.CKr === null) {
    throw new Error('Double Ratchet: receiving chain key is null')
  }
  const [newCKr, messageKey] = chainKdf(state.CKr)
  memzero(state.CKr)
  state.CKr = newCKr

  // 5. Decrypt
  const plaintext = aeadDecrypt(message.ciphertext, messageKey, message.nonce, headerBytes)
  memzero(messageKey)

  // 6. Update counter
  state.Nr = message.header.n + 1

  return { session: serializeState(state), plaintext }
}

// --- Wire format serialization ---

/**
 * Serialize a RatchetMessage to wire format:
 * headerBytes(40) || nonce(24) || ciphertext(variable)
 * Total overhead = 40 + 24 + 16(tag) = 80 bytes + plaintext length
 */
export function serializeMessage(msg: RatchetMessage): Uint8Array {
  const headerBytes = serializeHeader(msg.header)
  const buf = new Uint8Array(HEADER_SIZE + NONCE_SIZE + msg.ciphertext.length)
  buf.set(headerBytes, 0)
  buf.set(msg.nonce, HEADER_SIZE)
  buf.set(msg.ciphertext, HEADER_SIZE + NONCE_SIZE)
  return buf
}

/**
 * Deserialize a RatchetMessage from wire format.
 * Minimum size: 40 (header) + 24 (nonce) + 16 (auth tag) = 80 bytes.
 */
export function deserializeMessage(data: Uint8Array): RatchetMessage {
  const minSize = HEADER_SIZE + NONCE_SIZE + TAG_SIZE
  if (data.length < minSize) {
    throw new Error(`Invalid message size: minimum ${minSize}, got ${data.length}`)
  }
  const header = deserializeHeader(data.slice(0, HEADER_SIZE))
  const nonce = data.slice(HEADER_SIZE, HEADER_SIZE + NONCE_SIZE)
  const ciphertext = data.slice(HEADER_SIZE + NONCE_SIZE)
  return { header, nonce, ciphertext }
}
