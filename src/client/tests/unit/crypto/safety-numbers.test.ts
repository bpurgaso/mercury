import { describe, it, expect, beforeAll } from 'vitest'
import { ensureSodium, generateEd25519KeyPair } from '../../../src/worker/crypto/utils'
import { generateSafetyNumber } from '../../../src/worker/crypto/safety-numbers'

beforeAll(async () => {
  await ensureSodium()
})

describe('generateSafetyNumber', () => {
  it('produces a string of 12 groups of 5 digits separated by spaces', () => {
    const alice = generateEd25519KeyPair()
    const bob = generateEd25519KeyPair()

    const safetyNumber = generateSafetyNumber(alice.publicKey, bob.publicKey)
    const groups = safetyNumber.split(' ')

    expect(groups.length).toBe(12)
    for (const group of groups) {
      expect(group).toMatch(/^\d{5}$/)
    }
  })

  it('Alice and Bob compute identical safety numbers regardless of order', () => {
    const alice = generateEd25519KeyPair()
    const bob = generateEd25519KeyPair()

    const aliceSees = generateSafetyNumber(alice.publicKey, bob.publicKey)
    const bobSees = generateSafetyNumber(bob.publicKey, alice.publicKey)

    expect(aliceSees).toBe(bobSees)
  })

  it('Alice-Bob and Alice-Carol produce different safety numbers', () => {
    const alice = generateEd25519KeyPair()
    const bob = generateEd25519KeyPair()
    const carol = generateEd25519KeyPair()

    const aliceBob = generateSafetyNumber(alice.publicKey, bob.publicKey)
    const aliceCarol = generateSafetyNumber(alice.publicKey, carol.publicKey)

    expect(aliceBob).not.toBe(aliceCarol)
  })

  it('is deterministic — same keys always produce the same result', () => {
    const alice = generateEd25519KeyPair()
    const bob = generateEd25519KeyPair()

    const result1 = generateSafetyNumber(alice.publicKey, bob.publicKey)
    const result2 = generateSafetyNumber(alice.publicKey, bob.publicKey)

    expect(result1).toBe(result2)
  })

  it('works with identical keys (degenerate case)', () => {
    const alice = generateEd25519KeyPair()
    const safetyNumber = generateSafetyNumber(alice.publicKey, alice.publicKey)

    const groups = safetyNumber.split(' ')
    expect(groups.length).toBe(12)
    for (const group of groups) {
      expect(group).toMatch(/^\d{5}$/)
    }
  })

  it('rejects keys that are not 32 bytes', () => {
    const alice = generateEd25519KeyPair()

    expect(() => generateSafetyNumber(new Uint8Array(16), alice.publicKey)).toThrow(
      'Identity keys must be 32 bytes',
    )
    expect(() => generateSafetyNumber(alice.publicKey, new Uint8Array(64))).toThrow(
      'Identity keys must be 32 bytes',
    )
  })

  it('produces 60 digits total', () => {
    const alice = generateEd25519KeyPair()
    const bob = generateEd25519KeyPair()

    const safetyNumber = generateSafetyNumber(alice.publicKey, bob.publicKey)
    const digitsOnly = safetyNumber.replace(/ /g, '')
    expect(digitsOnly.length).toBe(60)
  })
})
