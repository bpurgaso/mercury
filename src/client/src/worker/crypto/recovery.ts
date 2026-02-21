// Recovery key generation and BIP-39 mnemonic encoding/decoding.
// See client-spec.md §4.4 for the account recovery flow.

import { createHash } from 'crypto'
import { ensureSodium, hkdfSha256, randomBytes } from './utils'
import { BIP39_ENGLISH_WORDLIST } from './bip39-wordlist'

export class InvalidMnemonicError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMnemonicError'
  }
}

// Build reverse lookup map on first use
let wordIndexMap: Map<string, number> | null = null
function getWordIndexMap(): Map<string, number> {
  if (!wordIndexMap) {
    wordIndexMap = new Map()
    for (let i = 0; i < BIP39_ENGLISH_WORDLIST.length; i++) {
      wordIndexMap.set(BIP39_ENGLISH_WORDLIST[i], i)
    }
  }
  return wordIndexMap
}

/**
 * Generate a 256-bit recovery key using cryptographic randomness.
 * This key is shown once to the user as a BIP-39 mnemonic.
 */
export async function generateRecoveryKey(): Promise<Uint8Array> {
  await ensureSodium()
  return randomBytes(32)
}

/**
 * Encode 256-bit entropy as a 24-word BIP-39 English mnemonic.
 *
 * BIP-39 for 256 bits: 256-bit entropy + 8-bit SHA-256 checksum = 264 bits = 24 × 11-bit words.
 */
export function encodeMnemonic(entropy: Uint8Array): string[] {
  if (entropy.length !== 32) {
    throw new InvalidMnemonicError(`Expected 32 bytes of entropy, got ${entropy.length}`)
  }

  // Compute checksum: first byte of SHA-256(entropy)
  const hash = createHash('sha256').update(entropy).digest()
  const checksumByte = hash[0]

  // Build 264-bit array: entropy (256 bits) || checksum (8 bits)
  // We work with a bit string represented as an array of 0/1 values
  const bits: number[] = []
  for (let i = 0; i < 32; i++) {
    for (let bit = 7; bit >= 0; bit--) {
      bits.push((entropy[i] >> bit) & 1)
    }
  }
  for (let bit = 7; bit >= 0; bit--) {
    bits.push((checksumByte >> bit) & 1)
  }

  // Split into 24 groups of 11 bits → word indices
  const words: string[] = []
  for (let i = 0; i < 24; i++) {
    let index = 0
    for (let j = 0; j < 11; j++) {
      index = (index << 1) | bits[i * 11 + j]
    }
    words.push(BIP39_ENGLISH_WORDLIST[index])
  }

  return words
}

/**
 * Decode a 24-word BIP-39 mnemonic back to 256-bit entropy.
 * Validates word count, word validity, and checksum.
 */
export function decodeMnemonic(words: string[]): Uint8Array {
  if (words.length !== 24) {
    throw new InvalidMnemonicError(`Expected 24 words, got ${words.length}`)
  }

  const map = getWordIndexMap()

  // Convert words to 11-bit indices
  const bits: number[] = []
  for (const word of words) {
    const index = map.get(word.toLowerCase())
    if (index === undefined) {
      throw new InvalidMnemonicError(`Unknown word: ${word}`)
    }
    for (let bit = 10; bit >= 0; bit--) {
      bits.push((index >> bit) & 1)
    }
  }

  // Extract entropy (first 256 bits) and checksum (last 8 bits)
  const entropy = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    let byte = 0
    for (let bit = 0; bit < 8; bit++) {
      byte = (byte << 1) | bits[i * 8 + bit]
    }
    entropy[i] = byte
  }

  let providedChecksum = 0
  for (let bit = 0; bit < 8; bit++) {
    providedChecksum = (providedChecksum << 1) | bits[256 + bit]
  }

  // Verify checksum
  const hash = createHash('sha256').update(entropy).digest()
  if (hash[0] !== providedChecksum) {
    throw new InvalidMnemonicError('Invalid checksum')
  }

  return entropy
}

/**
 * Derive a 32-byte AES backup encryption key from a recovery key and salt.
 * Uses HKDF-SHA256 with info string "mercury-backup-v1".
 */
export function deriveBackupEncryptionKey(recoveryKey: Uint8Array, salt: Uint8Array): Uint8Array {
  const info = new TextEncoder().encode('mercury-backup-v1')
  return hkdfSha256(recoveryKey, salt, info, 32)
}
