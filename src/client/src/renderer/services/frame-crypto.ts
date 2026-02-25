/**
 * Frame-level E2E encryption/decryption transforms for Insertable Streams.
 *
 * These TransformStreams sit between the codec output and DTLS-SRTP
 * packetization, encrypting outgoing frames and decrypting incoming
 * frames with AES-256-GCM.
 *
 * Frame layout:
 * ┌──────────────────┬──────────┬──────────────────────────┐
 * │  key_epoch (1B)  │  IV (12B)│  AES-GCM ciphertext      │
 * │  (unencrypted)   │          │  (encrypted frame data)   │
 * └──────────────────┴──────────┴──────────────────────────┘
 *
 * See client-spec.md §4.7 and server-spec.md §6.8.
 */

import type { MediaKeyRing } from './media-key-ring'

const IV_LENGTH = 12
const HEADER_LENGTH = 1 + IV_LENGTH // epoch (1) + IV (12)

/**
 * Encrypt a single frame's data, returning the encrypted output buffer
 * or null if encryption should be skipped (no key set).
 *
 * Output layout: [epoch (1B)] [IV (12B)] [AES-GCM ciphertext]
 */
export async function encryptFrameData(
  keyRing: MediaKeyRing,
  frameData: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  const key = keyRing.currentKey
  if (!key) return null

  const data = new Uint8Array(frameData)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data,
  )
  const ciphertextBytes = new Uint8Array(ciphertext)

  const output = new Uint8Array(HEADER_LENGTH + ciphertextBytes.byteLength)
  output[0] = keyRing.currentEpoch
  output.set(iv, 1)
  output.set(ciphertextBytes, HEADER_LENGTH)

  return output.buffer
}

/**
 * Decrypt a single encrypted frame, returning the decrypted data buffer
 * or null if decryption should be skipped (unknown epoch, corrupted data).
 */
export async function decryptFrameData(
  keyRing: MediaKeyRing,
  frameData: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  const data = new Uint8Array(frameData)

  if (data.byteLength < HEADER_LENGTH) return null

  const epoch = data[0]
  const iv = data.slice(1, HEADER_LENGTH)
  const ciphertext = data.slice(HEADER_LENGTH)

  const key = keyRing.getKeyForEpoch(epoch)
  if (!key) return null

  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    )
  } catch {
    return null
  }
}

/**
 * Create a TransformStream that encrypts outgoing encoded frames.
 *
 * Applied to RTCRtpSender via sender.createEncodedStreams().
 */
export function createSenderTransform(keyRing: MediaKeyRing): TransformStream {
  return new TransformStream({
    async transform(frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame, controller) {
      try {
        const encrypted = await encryptFrameData(keyRing, frame.data)
        if (encrypted) {
          frame.data = encrypted
          controller.enqueue(frame)
        }
      } catch {
        // Encryption failed — drop frame silently
      }
    },
  })
}

/**
 * Create a TransformStream that decrypts incoming encoded frames.
 *
 * Applied to RTCRtpReceiver via receiver.createEncodedStreams().
 */
export function createReceiverTransform(keyRing: MediaKeyRing): TransformStream {
  return new TransformStream({
    async transform(frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame, controller) {
      try {
        const decrypted = await decryptFrameData(keyRing, frame.data)
        if (decrypted) {
          frame.data = decrypted
          controller.enqueue(frame)
        }
      } catch {
        // Decryption failed — drop frame silently
      }
    },
  })
}

/**
 * Generate a new 256-bit AES-GCM key for media frame encryption.
 */
export async function generateMediaKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — needed for distribution to other participants
    ['encrypt', 'decrypt'],
  )
}

/**
 * Export a CryptoKey to raw bytes for E2E encrypted distribution.
 */
export async function exportMediaKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return new Uint8Array(raw)
}

/**
 * Import raw key bytes into a CryptoKey for local use.
 * The imported key is non-extractable (security best practice).
 */
export async function importMediaKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable once imported for use
    ['encrypt', 'decrypt'],
  )
}

export { IV_LENGTH, HEADER_LENGTH }
