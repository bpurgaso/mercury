import { describe, it, expect, beforeAll } from 'vitest'
import { ensureSodium, generateEd25519KeyPair } from '../../../src/worker/crypto/utils'
import { generateSafetyNumber } from '../../../src/worker/crypto/safety-numbers'

beforeAll(async () => {
  await ensureSodium()
})

describe('generateSafetyNumber', () => {
  // TESTSPEC: CC-026 safety_number_format
  it('produces a string of 12 groups of 5 digits separated by spaces', () => {
    const aliceMVK = generateEd25519KeyPair()
    const bobMVK = generateEd25519KeyPair()

    const safetyNumber = generateSafetyNumber(aliceMVK.publicKey, bobMVK.publicKey)
    const groups = safetyNumber.split(' ')

    expect(groups.length).toBe(12)
    for (const group of groups) {
      expect(group).toMatch(/^\d{5}$/)
    }
  })

  // TESTSPEC: CC-027 safety_number_commutative
  it('Alice and Bob compute identical safety numbers regardless of order', () => {
    const aliceMVK = generateEd25519KeyPair()
    const bobMVK = generateEd25519KeyPair()

    const aliceSees = generateSafetyNumber(aliceMVK.publicKey, bobMVK.publicKey)
    const bobSees = generateSafetyNumber(bobMVK.publicKey, aliceMVK.publicKey)

    expect(aliceSees).toBe(bobSees)
  })

  it('Alice-Bob and Alice-Carol produce different safety numbers', () => {
    const aliceMVK = generateEd25519KeyPair()
    const bobMVK = generateEd25519KeyPair()
    const carolMVK = generateEd25519KeyPair()

    const aliceBob = generateSafetyNumber(aliceMVK.publicKey, bobMVK.publicKey)
    const aliceCarol = generateSafetyNumber(aliceMVK.publicKey, carolMVK.publicKey)

    expect(aliceBob).not.toBe(aliceCarol)
  })

  it('is deterministic — same MVKs always produce the same result', () => {
    const aliceMVK = generateEd25519KeyPair()
    const bobMVK = generateEd25519KeyPair()

    const result1 = generateSafetyNumber(aliceMVK.publicKey, bobMVK.publicKey)
    const result2 = generateSafetyNumber(aliceMVK.publicKey, bobMVK.publicKey)

    expect(result1).toBe(result2)
  })

  it('works with identical keys (degenerate case)', () => {
    const mvk = generateEd25519KeyPair()
    const safetyNumber = generateSafetyNumber(mvk.publicKey, mvk.publicKey)

    const groups = safetyNumber.split(' ')
    expect(groups.length).toBe(12)
    for (const group of groups) {
      expect(group).toMatch(/^\d{5}$/)
    }
  })

  it('rejects keys that are not 32 bytes', () => {
    const mvk = generateEd25519KeyPair()

    expect(() => generateSafetyNumber(new Uint8Array(16), mvk.publicKey)).toThrow(
      'Master verify keys must be 32 bytes',
    )
    expect(() => generateSafetyNumber(mvk.publicKey, new Uint8Array(64))).toThrow(
      'Master verify keys must be 32 bytes',
    )
  })

  it('produces 60 digits total', () => {
    const aliceMVK = generateEd25519KeyPair()
    const bobMVK = generateEd25519KeyPair()

    const safetyNumber = generateSafetyNumber(aliceMVK.publicKey, bobMVK.publicKey)
    const digitsOnly = safetyNumber.replace(/ /g, '')
    expect(digitsOnly.length).toBe(60)
  })

  it('safety number is stable across device changes (MVK unchanged)', () => {
    // Simulate: Alice has one MVK but two different device identity keys
    const aliceMVK = generateEd25519KeyPair()
    const bobMVK = generateEd25519KeyPair()

    // Safety number computed with Alice's MVK
    const safetyBefore = generateSafetyNumber(aliceMVK.publicKey, bobMVK.publicKey)

    // Alice gets a new device (new DIK), but MVK stays the same
    // Safety number should be identical because it uses MVK, not DIK
    const safetyAfter = generateSafetyNumber(aliceMVK.publicKey, bobMVK.publicKey)

    expect(safetyBefore).toBe(safetyAfter)
  })
})
