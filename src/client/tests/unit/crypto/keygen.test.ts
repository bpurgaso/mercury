import { describe, it, expect, beforeAll } from 'vitest'
import { ensureSodium, verify } from '../../../src/worker/crypto/utils'
import {
  generateMasterVerifyKeyPair,
  generateDeviceIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
} from '../../../src/worker/crypto/keygen'

beforeAll(async () => {
  await ensureSodium()
})

describe('generateMasterVerifyKeyPair', () => {
  it('generates a valid Ed25519 signing keypair', async () => {
    const kp = await generateMasterVerifyKeyPair()

    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.privateKey.length).toBe(64)
  })

  it('generates unique keypairs on each call', async () => {
    const kp1 = await generateMasterVerifyKeyPair()
    const kp2 = await generateMasterVerifyKeyPair()
    expect(kp1.publicKey).not.toEqual(kp2.publicKey)
  })
})

describe('generateDeviceIdentityKeyPair', () => {
  it('generates a valid Ed25519 signing keypair', async () => {
    const kp = await generateDeviceIdentityKeyPair()

    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.privateKey.length).toBe(64)
  })
})

describe('generateSignedPreKey', () => {
  it('generates a signed X25519 pre-key that verifies with the identity key', async () => {
    const identityKey = await generateMasterVerifyKeyPair()
    const spk = await generateSignedPreKey(identityKey)

    expect(spk.keyId).toBe(1)
    expect(spk.keyPair.publicKey.length).toBe(32)
    expect(spk.keyPair.privateKey.length).toBe(32)
    expect(spk.signature.length).toBe(64)
    expect(spk.timestamp).toBeGreaterThan(0)

    // Verify signature over the public key
    expect(verify(spk.keyPair.publicKey, spk.signature, identityKey.publicKey)).toBe(true)
  })

  it('uses the provided keyId', async () => {
    const identityKey = await generateMasterVerifyKeyPair()
    const spk = await generateSignedPreKey(identityKey, 42)
    expect(spk.keyId).toBe(42)
  })

  it('fails verification with a different identity key', async () => {
    const identityKey = await generateMasterVerifyKeyPair()
    const wrongKey = await generateMasterVerifyKeyPair()
    const spk = await generateSignedPreKey(identityKey)

    expect(verify(spk.keyPair.publicKey, spk.signature, wrongKey.publicKey)).toBe(false)
  })
})

describe('generateOneTimePreKeys', () => {
  it('generates a batch of 100 unique X25519 keypairs with sequential IDs', async () => {
    const prekeys = await generateOneTimePreKeys(0, 100)

    expect(prekeys.length).toBe(100)

    // All have unique, sequential IDs
    const ids = prekeys.map((pk) => pk.keyId)
    expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => i))

    // All have valid key sizes
    for (const pk of prekeys) {
      expect(pk.keyPair.publicKey.length).toBe(32)
      expect(pk.keyPair.privateKey.length).toBe(32)
    }

    // All public keys are unique
    const publicKeySet = new Set(prekeys.map((pk) => Buffer.from(pk.keyPair.publicKey).toString('hex')))
    expect(publicKeySet.size).toBe(100)
  })

  it('starts from the given startId', async () => {
    const prekeys = await generateOneTimePreKeys(500, 10)

    expect(prekeys.length).toBe(10)
    expect(prekeys[0].keyId).toBe(500)
    expect(prekeys[9].keyId).toBe(509)
  })

  it('defaults to startId=0 and count=100', async () => {
    const prekeys = await generateOneTimePreKeys()

    expect(prekeys.length).toBe(100)
    expect(prekeys[0].keyId).toBe(0)
    expect(prekeys[99].keyId).toBe(99)
  })
})
