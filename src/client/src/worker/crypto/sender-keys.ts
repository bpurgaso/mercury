// Sender Keys Protocol — efficient group encryption for private E2E channels.
//
// Each channel member generates a single Sender Key and distributes it to all
// other members via pairwise Double Ratchet sessions. Messages are encrypted
// once with the sender's chain key (AES-256-GCM) regardless of member count.
//
// Key components:
//   - Chain key: 32-byte symmetric key, ratcheted forward per message (HMAC-SHA256)
//   - Signing key: Ed25519 keypair for message authentication
//   - Epoch: tracks channel membership changes for lazy key rotation
//
// Distribution is always pairwise via Double Ratchet — SenderKeys are never
// sent in plaintext. Private channels have a hard cap of 100 members.
//
// All operations run in the Worker Thread, never in the Renderer.

import { createHmac, createCipheriv, createDecipheriv } from 'crypto'
import type { SenderKey, SessionState } from './types'
import {
  generateEd25519KeyPair,
  sign,
  verify,
  randomBytes,
  memzero,
} from './utils'
import { ratchetEncrypt, ratchetDecrypt } from './double-ratchet'
import type { RatchetMessage } from './double-ratchet'

// --- Constants ---

const SENDER_KEY_VERSION = 0x01
const MAX_SKIP = 1000
const AES_GCM_NONCE_SIZE = 12
const AES_GCM_TAG_SIZE = 16
const CHAIN_KEY_SIZE = 32
const DISTRIBUTION_MESSAGE_SIZE = 72 // 32 (chainKey) + 32 (pubSignKey) + 4 (iteration) + 4 (epoch)
const MAX_MEMBER_DEVICES = 99 // 100-member cap minus self

// --- Types ---

export interface SenderKeyMessage {
  ciphertext: Uint8Array // AES-256-GCM (includes 16-byte auth tag)
  nonce: Uint8Array // 12-byte AES-GCM nonce
  signature: Uint8Array // 64-byte Ed25519 signature
  iteration: number
  epoch: number
}

export interface MemberDevice {
  userId: string
  deviceId: string
}

export interface DistributionResult {
  userId: string
  deviceId: string
  message: RatchetMessage
  updatedSession: SessionState
}

/** Internal Sender Key state — never exposed directly. */
interface SenderKeyState {
  chainKey: Uint8Array // 32 bytes
  publicSigningKey: Uint8Array // 32 bytes (Ed25519)
  privateSigningKey: Uint8Array | null // 64 bytes (null for received keys)
  iteration: number // next message counter
  epoch: number // channel sender_key_epoch
  skippedKeys: Map<number, Uint8Array> // iteration → messageKey
}

// --- HMAC-SHA256 ---

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const hmac = createHmac('sha256', key)
  hmac.update(data)
  return new Uint8Array(hmac.digest())
}

// --- Chain KDF ---

/**
 * Ratchet the chain key forward one step.
 *
 * newChainKey = HMAC-SHA256(chainKey, 0x01)
 * messageKey  = HMAC-SHA256(chainKey, 0x02)
 */
export function ratchetChainKey(
  chainKey: Uint8Array,
): { newChainKey: Uint8Array; messageKey: Uint8Array } {
  if (chainKey.length !== CHAIN_KEY_SIZE) {
    throw new Error(`Invalid chain key length: expected ${CHAIN_KEY_SIZE}, got ${chainKey.length}`)
  }
  const newChainKey = hmacSha256(chainKey, new Uint8Array([0x01]))
  const messageKey = hmacSha256(chainKey, new Uint8Array([0x02]))
  return { newChainKey, messageKey }
}

// --- AES-256-GCM ---

function aesGcmEncrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(AES_GCM_NONCE_SIZE)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce))
  cipher.setAAD(Buffer.from(aad))
  const part1 = cipher.update(Buffer.from(plaintext))
  const part2 = cipher.final()
  const tag = cipher.getAuthTag()
  const ciphertext = new Uint8Array(part1.length + part2.length + tag.length)
  ciphertext.set(new Uint8Array(part1), 0)
  if (part2.length > 0) ciphertext.set(new Uint8Array(part2), part1.length)
  ciphertext.set(new Uint8Array(tag), part1.length + part2.length)
  return { ciphertext, nonce }
}

function aesGcmDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (ciphertext.length < AES_GCM_TAG_SIZE) {
    throw new Error('Sender Keys: ciphertext too short for auth tag')
  }
  const tagStart = ciphertext.length - AES_GCM_TAG_SIZE
  const ct = ciphertext.slice(0, tagStart)
  const tag = ciphertext.slice(tagStart)
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce))
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(Buffer.from(tag))
    const part1 = decipher.update(Buffer.from(ct))
    const part2 = decipher.final()
    return new Uint8Array(Buffer.concat([part1, part2]))
  } catch {
    throw new Error('Sender Keys: message authentication failed')
  }
}

// --- AAD / Signature helpers ---

/** Build AAD binding epoch and iteration into AES-GCM authentication. */
function buildAad(epoch: number, iteration: number): Uint8Array {
  const aad = new Uint8Array(8)
  const view = new DataView(aad.buffer)
  view.setUint32(0, epoch, false)
  view.setUint32(4, iteration, false)
  return aad
}

/** Build the data that gets signed: epoch || iteration || nonce || ciphertext. */
function buildSignatureData(
  epoch: number,
  iteration: number,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const data = new Uint8Array(4 + 4 + nonce.length + ciphertext.length)
  const view = new DataView(data.buffer)
  view.setUint32(0, epoch, false)
  view.setUint32(4, iteration, false)
  data.set(nonce, 8)
  data.set(ciphertext, 8 + nonce.length)
  return data
}

// --- State serialization ---
//
// Binary format:
//   [1]  version = 0x01
//   [1]  flags: bit0 = hasPrivateSigningKey
//   [32] chainKey
//   [32] publicSigningKey
//   [64] privateSigningKey (if hasPrivateSigningKey)
//   [4]  iteration (uint32 BE)
//   [4]  epoch (uint32 BE)
//   [4]  skippedCount (uint32 BE)
//   [36 * skippedCount] entries: iteration(4 BE) + messageKey(32)

function serializeState(state: SenderKeyState): SenderKey {
  let flags = 0
  if (state.privateSigningKey !== null) flags |= 0x01

  let size = 1 + 1 + 32 + 32 + 4 + 4 + 4 // version+flags+chainKey+pubSign+iter+epoch+skipCount
  if (state.privateSigningKey !== null) size += 64
  size += state.skippedKeys.size * 36

  const data = new Uint8Array(size)
  const view = new DataView(data.buffer)
  let offset = 0

  data[offset++] = SENDER_KEY_VERSION
  data[offset++] = flags

  data.set(state.chainKey, offset)
  offset += 32

  data.set(state.publicSigningKey, offset)
  offset += 32

  if (state.privateSigningKey !== null) {
    data.set(state.privateSigningKey, offset)
    offset += 64
  }

  view.setUint32(offset, state.iteration, false)
  offset += 4
  view.setUint32(offset, state.epoch, false)
  offset += 4

  view.setUint32(offset, state.skippedKeys.size, false)
  offset += 4
  for (const [iter, mk] of state.skippedKeys) {
    view.setUint32(offset, iter, false)
    offset += 4
    data.set(mk, offset)
    offset += 32
  }

  return { data }
}

function deserializeState(key: SenderKey): SenderKeyState {
  const data = key.data
  if (data.length < 2) {
    throw new Error('Sender Keys: key data too short')
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0

  const version = data[offset++]
  if (version !== SENDER_KEY_VERSION) {
    throw new Error(`Sender Keys: unsupported version ${version}`)
  }

  const flags = data[offset++]
  const hasPrivateSigningKey = (flags & 0x01) !== 0

  const chainKey = data.slice(offset, offset + 32)
  offset += 32

  const publicSigningKey = data.slice(offset, offset + 32)
  offset += 32

  let privateSigningKey: Uint8Array | null = null
  if (hasPrivateSigningKey) {
    privateSigningKey = data.slice(offset, offset + 64)
    offset += 64
  }

  const iteration = view.getUint32(offset, false)
  offset += 4
  const epoch = view.getUint32(offset, false)
  offset += 4

  const skippedCount = view.getUint32(offset, false)
  offset += 4
  const skippedKeys = new Map<number, Uint8Array>()
  for (let i = 0; i < skippedCount; i++) {
    const iter = view.getUint32(offset, false)
    offset += 4
    const mk = data.slice(offset, offset + 32)
    offset += 32
    skippedKeys.set(iter, mk)
  }

  return { chainKey, publicSigningKey, privateSigningKey, iteration, epoch, skippedKeys }
}

// --- State cleanup ---

function clearState(state: SenderKeyState): void {
  memzero(state.chainKey)
  memzero(state.publicSigningKey)
  if (state.privateSigningKey) memzero(state.privateSigningKey)
  for (const mk of state.skippedKeys.values()) {
    memzero(mk)
  }
  state.skippedKeys.clear()
}

// --- Public API ---

/**
 * Generate a new SenderKey for a channel.
 *
 * Creates a random 32-byte chain key, a fresh Ed25519 signing keypair,
 * iteration=0, and the given epoch. The caller must store the returned
 * SenderKey in the KeyStore keyed by (channelId, userId, deviceId).
 */
export function generateSenderKey(epoch: number): SenderKey {
  const chainKey = randomBytes(CHAIN_KEY_SIZE)
  const signingKP = generateEd25519KeyPair()

  const state: SenderKeyState = {
    chainKey,
    publicSigningKey: signingKP.publicKey,
    privateSigningKey: signingKP.privateKey,
    iteration: 0,
    epoch,
    skippedKeys: new Map(),
  }

  const key = serializeState(state)
  clearState(state)
  return key
}

/**
 * Create a distribution message from a SenderKey.
 *
 * Serializes chainKey, publicSigningKey, iteration, and epoch into a
 * 72-byte plaintext buffer for pairwise encryption via Double Ratchet.
 * The private signing key is NOT included.
 */
export function createDistributionMessage(senderKey: SenderKey): Uint8Array {
  const state = deserializeState(senderKey)
  const data = new Uint8Array(DISTRIBUTION_MESSAGE_SIZE)
  const view = new DataView(data.buffer)

  data.set(state.chainKey, 0)
  data.set(state.publicSigningKey, 32)
  view.setUint32(64, state.iteration, false)
  view.setUint32(68, state.epoch, false)

  clearState(state)
  return data
}

/**
 * Import a SenderKey from a received distribution message.
 *
 * Creates a receive-only SenderKey (no private signing key).
 */
export function importDistributionMessage(data: Uint8Array): SenderKey {
  if (data.length !== DISTRIBUTION_MESSAGE_SIZE) {
    throw new Error(
      `Sender Keys: invalid distribution message length: expected ${DISTRIBUTION_MESSAGE_SIZE}, got ${data.length}`,
    )
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const state: SenderKeyState = {
    chainKey: data.slice(0, 32),
    publicSigningKey: data.slice(32, 64),
    privateSigningKey: null,
    iteration: view.getUint32(64, false),
    epoch: view.getUint32(68, false),
    skippedKeys: new Map(),
  }

  const key = serializeState(state)
  clearState(state)
  return key
}

/**
 * Distribute a SenderKey to channel members via Double Ratchet.
 *
 * For each member device, encrypts the SenderKey distribution message
 * using the existing pairwise Double Ratchet session. Returns encrypted
 * messages and updated sessions — the caller sends via WebSocket and
 * persists sessions.
 *
 * @param senderKey - The sender's own SenderKey
 * @param memberDevices - (userId, deviceId) for all channel members (excluding self)
 * @param getSession - Callback to retrieve a Double Ratchet session for a device
 * @param encrypt - Optional encrypt function (defaults to ratchetEncrypt; injectable for testing)
 */
export function distributeSenderKey(
  senderKey: SenderKey,
  memberDevices: MemberDevice[],
  getSession: (userId: string, deviceId: string) => SessionState,
  encrypt: (
    session: SessionState,
    plaintext: Uint8Array,
  ) => { session: SessionState; message: RatchetMessage } = ratchetEncrypt,
): DistributionResult[] {
  if (memberDevices.length > MAX_MEMBER_DEVICES) {
    throw new Error(
      `Sender Keys: cannot distribute to more than ${MAX_MEMBER_DEVICES} devices (100-member cap)`,
    )
  }

  const distMessage = createDistributionMessage(senderKey)
  const results: DistributionResult[] = []

  for (const device of memberDevices) {
    const session = getSession(device.userId, device.deviceId)
    const { session: updatedSession, message } = encrypt(session, distMessage)
    results.push({
      userId: device.userId,
      deviceId: device.deviceId,
      message,
      updatedSession,
    })
  }

  memzero(distMessage)
  return results
}

/**
 * Receive and decrypt a SenderKey distribution message.
 *
 * Decrypts via Double Ratchet, then imports the SenderKey.
 *
 * @param encryptedMessage - The DR-encrypted distribution message
 * @param session - Double Ratchet session with the sender
 * @param decrypt - Optional decrypt function (defaults to ratchetDecrypt; injectable for testing)
 */
export function receiveSenderKeyDistribution(
  encryptedMessage: RatchetMessage,
  session: SessionState,
  decrypt: (
    session: SessionState,
    message: RatchetMessage,
  ) => { session: SessionState; plaintext: Uint8Array } = ratchetDecrypt,
): { senderKey: SenderKey; updatedSession: SessionState } {
  const { session: updatedSession, plaintext } = decrypt(session, encryptedMessage)
  const senderKey = importDistributionMessage(plaintext)
  memzero(plaintext)
  return { senderKey, updatedSession }
}

/**
 * Encrypt a message using Sender Keys.
 *
 * Ratchets the chain key forward, derives a message key via HMAC-SHA256,
 * encrypts with AES-256-GCM, and signs the ciphertext with the sender's
 * Ed25519 signing key. Single encryption regardless of member count.
 *
 * IMPORTANT — self-echo: After encrypting, the sender's chain iteration
 * advances past the message. If the server relays the message back as an
 * echo, the sender CANNOT decrypt it (iteration will be behind the chain).
 * The client must cache sent plaintext locally and skip decrypting its own
 * echoes. This matches Signal's approach for group messages.
 *
 * @throws If the SenderKey epoch doesn't match channelEpoch (needs rotation)
 * @throws If the SenderKey has no private signing key (not your own key)
 */
export function senderKeyEncrypt(
  senderKey: SenderKey,
  plaintext: Uint8Array,
  channelEpoch: number,
): { senderKey: SenderKey; message: SenderKeyMessage } {
  const state = deserializeState(senderKey)

  try {
    if (state.privateSigningKey === null) {
      throw new Error('Sender Keys: cannot encrypt without private signing key')
    }

    if (state.epoch !== channelEpoch) {
      throw new Error(
        `Sender Keys: epoch mismatch (key: ${state.epoch}, channel: ${channelEpoch}) — rotate first`,
      )
    }

    // Ratchet chain key → derive message key
    const { newChainKey, messageKey } = ratchetChainKey(state.chainKey)
    memzero(state.chainKey)
    state.chainKey = newChainKey

    const currentIteration = state.iteration
    state.iteration++

    // AES-256-GCM encrypt with epoch+iteration as AAD
    const aad = buildAad(state.epoch, currentIteration)
    const { ciphertext, nonce } = aesGcmEncrypt(plaintext, messageKey, aad)
    memzero(messageKey)

    // Ed25519 sign (epoch || iteration || nonce || ciphertext)
    const sigData = buildSignatureData(state.epoch, currentIteration, nonce, ciphertext)
    const signature = sign(sigData, state.privateSigningKey)
    memzero(sigData)

    const message: SenderKeyMessage = {
      ciphertext,
      nonce,
      signature,
      iteration: currentIteration,
      epoch: state.epoch,
    }

    const updatedKey = serializeState(state)
    return { senderKey: updatedKey, message }
  } finally {
    clearState(state)
  }
}

/**
 * Decrypt a message using Sender Keys.
 *
 * Verifies the Ed25519 signature, advances the chain to the message's
 * iteration (ratcheting forward and storing intermediate keys for skipped
 * messages), derives the message key, and decrypts with AES-256-GCM.
 *
 * Failure safety: On any error (signature, epoch, AEAD), the caller's
 * SenderKey is NOT mutated — the state is deserialized into a local copy
 * and the original remains intact. The caller can retry with the same key.
 * While intermediate skipped keys computed during a failed forward-ratchet
 * are discarded, they can be recomputed from the unchanged original key.
 * In practice, AEAD failure after a valid Ed25519 signature is
 * cryptographically impossible under normal operation.
 *
 * @param senderKey - The sender's SenderKey (received via distribution)
 * @param message - The encrypted message
 * @param minEpoch - Minimum acceptable epoch (reject stale-epoch messages)
 * @throws If signature verification fails
 * @throws If epoch is stale (below minEpoch) or doesn't match the key
 * @throws If too many messages would be skipped (>1000)
 */
export function senderKeyDecrypt(
  senderKey: SenderKey,
  message: SenderKeyMessage,
  minEpoch: number,
): { senderKey: SenderKey; plaintext: Uint8Array } {
  const state = deserializeState(senderKey)
  let messageKey: Uint8Array | null = null

  try {
    // Epoch validation
    if (message.epoch < minEpoch) {
      throw new Error(
        `Sender Keys: stale epoch (message: ${message.epoch}, minimum: ${minEpoch})`,
      )
    }
    if (message.epoch !== state.epoch) {
      throw new Error(
        `Sender Keys: epoch mismatch (message: ${message.epoch}, key: ${state.epoch})`,
      )
    }

    // Verify Ed25519 signature before any chain operations
    const sigData = buildSignatureData(
      message.epoch,
      message.iteration,
      message.nonce,
      message.ciphertext,
    )
    if (!verify(sigData, message.signature, state.publicSigningKey)) {
      memzero(sigData)
      throw new Error('Sender Keys: signature verification failed')
    }
    memzero(sigData)

    // Check for previously stored skipped key
    const storedMK = state.skippedKeys.get(message.iteration)
    if (storedMK) {
      state.skippedKeys.delete(message.iteration)
      messageKey = storedMK
      const aad = buildAad(message.epoch, message.iteration)
      const plaintext = aesGcmDecrypt(message.ciphertext, messageKey, message.nonce, aad)
      const updatedKey = serializeState(state)
      return { senderKey: updatedKey, plaintext }
    }

    // Message must be at or ahead of our chain position
    if (message.iteration < state.iteration) {
      throw new Error(
        `Sender Keys: message iteration ${message.iteration} behind chain ${state.iteration} with no skipped key`,
      )
    }

    // Guard against excessive skipping
    const skip = message.iteration - state.iteration
    if (skip > MAX_SKIP) {
      throw new Error(`Sender Keys: too many skipped messages (${skip} > ${MAX_SKIP})`)
    }

    // Ratchet forward, storing intermediate message keys for skipped iterations
    for (let i = state.iteration; i < message.iteration; i++) {
      const { newChainKey, messageKey: mk } = ratchetChainKey(state.chainKey)
      memzero(state.chainKey)
      state.chainKey = newChainKey
      state.skippedKeys.set(i, mk)
      state.iteration++
    }

    // Evict oldest skipped keys if over limit (FIFO — Map insertion order)
    if (state.skippedKeys.size > MAX_SKIP) {
      const excess = state.skippedKeys.size - MAX_SKIP
      const iter = state.skippedKeys.keys()
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value as number
        const mk = state.skippedKeys.get(key)!
        memzero(mk)
        state.skippedKeys.delete(key)
      }
    }

    // Derive message key for this iteration
    const { newChainKey, messageKey: mk } = ratchetChainKey(state.chainKey)
    messageKey = mk
    memzero(state.chainKey)
    state.chainKey = newChainKey
    state.iteration++

    // Decrypt
    const aad = buildAad(message.epoch, message.iteration)
    const plaintext = aesGcmDecrypt(message.ciphertext, messageKey, message.nonce, aad)

    const updatedKey = serializeState(state)
    return { senderKey: updatedKey, plaintext }
  } finally {
    if (messageKey) memzero(messageKey)
    clearState(state)
  }
}

/**
 * Check if a SenderKey needs rotation (epoch is stale).
 */
export function needsRotation(senderKey: SenderKey, channelEpoch: number): boolean {
  const state = deserializeState(senderKey)
  const stale = state.epoch !== channelEpoch
  clearState(state)
  return stale
}

/**
 * Get the epoch of a SenderKey.
 */
export function getSenderKeyEpoch(senderKey: SenderKey): number {
  const state = deserializeState(senderKey)
  const epoch = state.epoch
  clearState(state)
  return epoch
}

/**
 * Zero all key material in a SenderKey buffer.
 */
export function clearSenderKeyData(senderKey: SenderKey): void {
  memzero(senderKey.data)
}
