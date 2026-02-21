import { describe, it, expect, beforeAll } from 'vitest'
import { ensureSodium, randomBytes } from '../../../src/worker/crypto/utils'
import {
  generateRecoveryKey,
  encodeMnemonic,
  decodeMnemonic,
  deriveBackupEncryptionKey,
  InvalidMnemonicError,
} from '../../../src/worker/crypto/recovery'
import { BIP39_ENGLISH_WORDLIST } from '../../../src/worker/crypto/bip39-wordlist'

beforeAll(async () => {
  await ensureSodium()
})

describe('generateRecoveryKey', () => {
  it('generates 32 bytes of randomness', async () => {
    const key = await generateRecoveryKey()
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
  })

  it('generates unique keys on each call', async () => {
    const key1 = await generateRecoveryKey()
    const key2 = await generateRecoveryKey()
    expect(Buffer.from(key1).toString('hex')).not.toEqual(Buffer.from(key2).toString('hex'))
  })
})

describe('encodeMnemonic', () => {
  it('produces exactly 24 words', () => {
    const entropy = randomBytes(32)
    const words = encodeMnemonic(entropy)
    expect(words.length).toBe(24)
  })

  it('all words are from the BIP-39 English wordlist', () => {
    const entropy = randomBytes(32)
    const words = encodeMnemonic(entropy)
    const wordSet = new Set(BIP39_ENGLISH_WORDLIST)
    for (const word of words) {
      expect(wordSet.has(word)).toBe(true)
    }
  })

  it('rejects non-32-byte entropy', () => {
    expect(() => encodeMnemonic(new Uint8Array(16))).toThrow(InvalidMnemonicError)
    expect(() => encodeMnemonic(new Uint8Array(64))).toThrow(InvalidMnemonicError)
  })

  it('is deterministic — same entropy produces same mnemonic', () => {
    const entropy = randomBytes(32)
    const words1 = encodeMnemonic(entropy)
    const words2 = encodeMnemonic(entropy)
    expect(words1).toEqual(words2)
  })
})

describe('decodeMnemonic', () => {
  it('round-trips: encode → decode produces identical bytes', () => {
    const entropy = randomBytes(32)
    const words = encodeMnemonic(entropy)
    const decoded = decodeMnemonic(words)
    expect(Buffer.from(decoded).toString('hex')).toEqual(Buffer.from(entropy).toString('hex'))
  })

  it('round-trips with multiple random keys', () => {
    for (let i = 0; i < 10; i++) {
      const entropy = randomBytes(32)
      const words = encodeMnemonic(entropy)
      const decoded = decodeMnemonic(words)
      expect(Buffer.from(decoded).toString('hex')).toEqual(Buffer.from(entropy).toString('hex'))
    }
  })

  it('throws on wrong word count', () => {
    expect(() => decodeMnemonic(['abandon'])).toThrow('Expected 24 words, got 1')
    expect(() => decodeMnemonic(new Array(12).fill('abandon'))).toThrow(
      'Expected 24 words, got 12',
    )
    expect(() => decodeMnemonic(new Array(25).fill('abandon'))).toThrow(
      'Expected 24 words, got 25',
    )
  })

  it('throws on unknown word', () => {
    const words = encodeMnemonic(randomBytes(32))
    words[5] = 'notaword'
    expect(() => decodeMnemonic(words)).toThrow('Unknown word: notaword')
  })

  it('throws on invalid checksum', () => {
    const entropy = randomBytes(32)
    const words = encodeMnemonic(entropy)
    // Swap two words to break the checksum (but keep all words valid)
    const temp = words[0]
    words[0] = words[1]
    words[1] = temp
    // This will almost certainly break the checksum
    // (extremely unlikely that swapping two words preserves it)
    expect(() => decodeMnemonic(words)).toThrow('Invalid checksum')
  })

  it('is case-insensitive', () => {
    const entropy = randomBytes(32)
    const words = encodeMnemonic(entropy)
    const upperWords = words.map((w) => w.toUpperCase())
    const decoded = decodeMnemonic(upperWords)
    expect(Buffer.from(decoded).toString('hex')).toEqual(Buffer.from(entropy).toString('hex'))
  })
})

describe('deriveBackupEncryptionKey', () => {
  it('derives a 32-byte key', () => {
    const recoveryKey = randomBytes(32)
    const salt = randomBytes(32)
    const key = deriveBackupEncryptionKey(recoveryKey, salt)
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
  })

  it('same inputs produce same key', () => {
    const recoveryKey = randomBytes(32)
    const salt = randomBytes(32)
    const key1 = deriveBackupEncryptionKey(recoveryKey, salt)
    const key2 = deriveBackupEncryptionKey(recoveryKey, salt)
    expect(Buffer.from(key1).toString('hex')).toEqual(Buffer.from(key2).toString('hex'))
  })

  it('different salts produce different keys', () => {
    const recoveryKey = randomBytes(32)
    const salt1 = randomBytes(32)
    const salt2 = randomBytes(32)
    const key1 = deriveBackupEncryptionKey(recoveryKey, salt1)
    const key2 = deriveBackupEncryptionKey(recoveryKey, salt2)
    expect(Buffer.from(key1).toString('hex')).not.toEqual(Buffer.from(key2).toString('hex'))
  })

  it('different recovery keys produce different keys', () => {
    const rk1 = randomBytes(32)
    const rk2 = randomBytes(32)
    const salt = randomBytes(32)
    const key1 = deriveBackupEncryptionKey(rk1, salt)
    const key2 = deriveBackupEncryptionKey(rk2, salt)
    expect(Buffer.from(key1).toString('hex')).not.toEqual(Buffer.from(key2).toString('hex'))
  })
})
