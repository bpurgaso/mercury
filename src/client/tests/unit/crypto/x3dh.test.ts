import { describe, it, expect, beforeAll } from 'vitest'
import {
  ensureSodium,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  sign,
  hkdfSha256,
  memzero,
} from '../../../src/worker/crypto/utils'
import {
  generateDeviceIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
} from '../../../src/worker/crypto/keygen'
import {
  performX3DH,
  respondX3DH,
  createInitialSession,
  parseInitialSession,
} from '../../../src/worker/crypto/x3dh'
import type { KeyBundle } from '../../../src/worker/crypto/types'

beforeAll(async () => {
  await ensureSodium()
})

describe('X3DH round-trip (4-DH with one-time pre-key)', () => {
  // TESTSPEC: CC-005
  it('Alice and Bob derive the same shared secret', async () => {
    // Alice generates her identity key
    const aliceIdentity = await generateDeviceIdentityKeyPair()

    // Bob generates his identity key, signed pre-key, and one-time pre-keys
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSignedPreKey = await generateSignedPreKey(bobIdentity, 1)
    const bobOneTimePreKeys = await generateOneTimePreKeys(0, 10)

    // Build Bob's key bundle as Alice would receive it from the server
    const bobBundle: KeyBundle = {
      identityKey: bobIdentity.publicKey,
      signedPreKey: {
        keyId: bobSignedPreKey.keyId,
        publicKey: bobSignedPreKey.keyPair.publicKey,
        signature: bobSignedPreKey.signature,
      },
      oneTimePreKey: {
        keyId: bobOneTimePreKeys[3].keyId,
        publicKey: bobOneTimePreKeys[3].keyPair.publicKey,
      },
    }

    // Alice performs X3DH (initiator)
    const aliceResult = performX3DH(aliceIdentity, bobBundle)

    expect(aliceResult.sharedSecret).toBeInstanceOf(Uint8Array)
    expect(aliceResult.sharedSecret.length).toBe(32)
    expect(aliceResult.ephemeralPublicKey).toBeInstanceOf(Uint8Array)
    expect(aliceResult.ephemeralPublicKey.length).toBe(32)
    expect(aliceResult.usedPreKeyId).toBe(3)

    // Bob responds to X3DH (responder)
    const bobSharedSecret = respondX3DH(
      bobIdentity,
      bobSignedPreKey,
      bobOneTimePreKeys[3],
      aliceIdentity.publicKey,
      aliceResult.ephemeralPublicKey,
    )

    expect(bobSharedSecret).toBeInstanceOf(Uint8Array)
    expect(bobSharedSecret.length).toBe(32)

    // Both sides must derive the identical shared secret
    expect(aliceResult.sharedSecret).toEqual(bobSharedSecret)
  })

  it('shared secret is non-zero', async () => {
    const aliceIdentity = await generateDeviceIdentityKeyPair()
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSPK = await generateSignedPreKey(bobIdentity, 1)
    const bobOTPs = await generateOneTimePreKeys(0, 1)

    const bundle: KeyBundle = {
      identityKey: bobIdentity.publicKey,
      signedPreKey: {
        keyId: bobSPK.keyId,
        publicKey: bobSPK.keyPair.publicKey,
        signature: bobSPK.signature,
      },
      oneTimePreKey: {
        keyId: bobOTPs[0].keyId,
        publicKey: bobOTPs[0].keyPair.publicKey,
      },
    }

    const result = performX3DH(aliceIdentity, bundle)
    const allZero = result.sharedSecret.every((b) => b === 0)
    expect(allZero).toBe(false)
  })
})

describe('X3DH without one-time pre-key (3-DH)', () => {
  // TESTSPEC: CC-006
  it('Alice and Bob derive the same shared secret without OTP', async () => {
    const aliceIdentity = await generateDeviceIdentityKeyPair()
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSignedPreKey = await generateSignedPreKey(bobIdentity, 1)

    // No one-time pre-key in bundle
    const bobBundle: KeyBundle = {
      identityKey: bobIdentity.publicKey,
      signedPreKey: {
        keyId: bobSignedPreKey.keyId,
        publicKey: bobSignedPreKey.keyPair.publicKey,
        signature: bobSignedPreKey.signature,
      },
    }

    // Alice initiates with 3-DH
    const aliceResult = performX3DH(aliceIdentity, bobBundle)
    expect(aliceResult.usedPreKeyId).toBeUndefined()

    // Bob responds with 3-DH (null one-time pre-key)
    const bobSharedSecret = respondX3DH(
      bobIdentity,
      bobSignedPreKey,
      null,
      aliceIdentity.publicKey,
      aliceResult.ephemeralPublicKey,
    )

    // Both derive the same secret
    expect(aliceResult.sharedSecret).toEqual(bobSharedSecret)
  })

  it('3-DH and 4-DH produce different shared secrets', async () => {
    const aliceIdentity = await generateDeviceIdentityKeyPair()
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSPK = await generateSignedPreKey(bobIdentity, 1)
    const bobOTPs = await generateOneTimePreKeys(0, 1)

    // 3-DH (no OTP)
    const bundle3: KeyBundle = {
      identityKey: bobIdentity.publicKey,
      signedPreKey: {
        keyId: bobSPK.keyId,
        publicKey: bobSPK.keyPair.publicKey,
        signature: bobSPK.signature,
      },
    }

    // 4-DH (with OTP)
    const bundle4: KeyBundle = {
      ...bundle3,
      oneTimePreKey: {
        keyId: bobOTPs[0].keyId,
        publicKey: bobOTPs[0].keyPair.publicKey,
      },
    }

    // Use the same Alice identity for both
    const result3 = performX3DH(aliceIdentity, bundle3)
    const result4 = performX3DH(aliceIdentity, bundle4)

    // Different ephemeral keys → different secrets regardless,
    // but even conceptually 3-DH vs 4-DH are different protocols
    expect(result3.sharedSecret).not.toEqual(result4.sharedSecret)
  })
})

describe('X3DH signature verification', () => {
  it('throws when signed pre-key signature is tampered', async () => {
    const aliceIdentity = await generateDeviceIdentityKeyPair()
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSPK = await generateSignedPreKey(bobIdentity, 1)

    // Tamper with the signature (flip a byte)
    const tamperedSig = new Uint8Array(bobSPK.signature)
    tamperedSig[0] ^= 0xff

    const bundle: KeyBundle = {
      identityKey: bobIdentity.publicKey,
      signedPreKey: {
        keyId: bobSPK.keyId,
        publicKey: bobSPK.keyPair.publicKey,
        signature: tamperedSig,
      },
    }

    expect(() => performX3DH(aliceIdentity, bundle)).toThrow(
      'X3DH: signed pre-key signature verification failed',
    )
  })

  it('throws when signed pre-key public key is tampered', async () => {
    const aliceIdentity = await generateDeviceIdentityKeyPair()
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSPK = await generateSignedPreKey(bobIdentity, 1)

    // Replace with a different key entirely
    const fakeKey = generateX25519KeyPair()

    const bundle: KeyBundle = {
      identityKey: bobIdentity.publicKey,
      signedPreKey: {
        keyId: bobSPK.keyId,
        publicKey: fakeKey.publicKey, // wrong key, signature won't match
        signature: bobSPK.signature,
      },
    }

    expect(() => performX3DH(aliceIdentity, bundle)).toThrow(
      'X3DH: signed pre-key signature verification failed',
    )
  })

  // TESTSPEC: CC-007
  it('throws when identity key is wrong (signature by different key)', async () => {
    const aliceIdentity = await generateDeviceIdentityKeyPair()
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSPK = await generateSignedPreKey(bobIdentity, 1)
    const eveIdentity = await generateDeviceIdentityKeyPair()

    // SPK was signed by bob, but bundle claims eve's identity
    const bundle: KeyBundle = {
      identityKey: eveIdentity.publicKey, // wrong identity
      signedPreKey: {
        keyId: bobSPK.keyId,
        publicKey: bobSPK.keyPair.publicKey,
        signature: bobSPK.signature, // signed by bobIdentity, not eveIdentity
      },
    }

    expect(() => performX3DH(aliceIdentity, bundle)).toThrow(
      'X3DH: signed pre-key signature verification failed',
    )
  })
})

describe('X3DH memory safety', () => {
  it('respondX3DH zeroes the consumed one-time pre-key private key', async () => {
    const aliceIdentity = await generateDeviceIdentityKeyPair()
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSPK = await generateSignedPreKey(bobIdentity, 1)
    const bobOTPs = await generateOneTimePreKeys(0, 1)

    const bundle: KeyBundle = {
      identityKey: bobIdentity.publicKey,
      signedPreKey: {
        keyId: bobSPK.keyId,
        publicKey: bobSPK.keyPair.publicKey,
        signature: bobSPK.signature,
      },
      oneTimePreKey: {
        keyId: bobOTPs[0].keyId,
        publicKey: bobOTPs[0].keyPair.publicKey,
      },
    }

    const aliceResult = performX3DH(aliceIdentity, bundle)

    // Keep a reference to the OTP object passed into respondX3DH
    const otpForBob = bobOTPs[0]
    respondX3DH(
      bobIdentity,
      bobSPK,
      otpForBob,
      aliceIdentity.publicKey,
      aliceResult.ephemeralPublicKey,
    )

    // The OTP private key should be zeroed after respondX3DH returns
    const allZero = otpForBob.keyPair.privateKey.every((b) => b === 0)
    expect(allZero).toBe(true)
  })
})

describe('HKDF-SHA256', () => {
  it('produces deterministic output for the same inputs', () => {
    const ikm = new Uint8Array(64).fill(0xab)
    const salt = new Uint8Array(32).fill(0x00)
    const info = new TextEncoder().encode('test-info')

    const out1 = hkdfSha256(ikm, salt, info, 32)
    const out2 = hkdfSha256(ikm, salt, info, 32)
    expect(out1).toEqual(out2)
  })

  it('different info strings produce different outputs', () => {
    const ikm = new Uint8Array(64).fill(0xab)
    const salt = new Uint8Array(32)
    const info1 = new TextEncoder().encode('info-a')
    const info2 = new TextEncoder().encode('info-b')

    const out1 = hkdfSha256(ikm, salt, info1, 32)
    const out2 = hkdfSha256(ikm, salt, info2, 32)
    expect(out1).not.toEqual(out2)
  })

  it('rejects invalid output length', () => {
    expect(() =>
      hkdfSha256(new Uint8Array(32), new Uint8Array(32), new Uint8Array(0), 0),
    ).toThrow('HKDF output length out of range')
  })

  it('works with arbitrary salt length', () => {
    const ikm = new Uint8Array(64).fill(0xab)
    const info = new TextEncoder().encode('test')
    // 16-byte salt should work fine (HMAC pads internally)
    const out = hkdfSha256(ikm, new Uint8Array(16), info, 32)
    expect(out.length).toBe(32)
  })
})

describe('createInitialSession / parseInitialSession', () => {
  it('round-trips session state through serialization', () => {
    const sharedSecret = new Uint8Array(32).fill(0x42)
    const remoteId = new Uint8Array(32).fill(0xaa)
    const localId = new Uint8Array(32).fill(0xbb)
    const ephemeral = new Uint8Array(32).fill(0xcc)

    const session = createInitialSession(
      sharedSecret,
      remoteId,
      localId,
      ephemeral,
      7,
      true,
    )

    expect(session.data.length).toBe(142)

    const parsed = parseInitialSession(session)
    expect(parsed.version).toBe(1)
    expect(parsed.isInitiator).toBe(true)
    expect(parsed.hasPreKeyId).toBe(true)
    expect(parsed.preKeyId).toBe(7)
    expect(parsed.sharedSecret).toEqual(sharedSecret)
    expect(parsed.remoteIdentityKey).toEqual(remoteId)
    expect(parsed.localIdentityKey).toEqual(localId)
    expect(parsed.ephemeralPublicKey).toEqual(ephemeral)
    expect(parsed.createdAt).toBeGreaterThan(0)
  })

  it('handles no pre-key ID correctly', () => {
    const session = createInitialSession(
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32),
      undefined,
      false,
    )

    const parsed = parseInitialSession(session)
    expect(parsed.isInitiator).toBe(false)
    expect(parsed.hasPreKeyId).toBe(false)
    expect(parsed.preKeyId).toBe(0)
  })

  it('rejects wrong-sized data', () => {
    expect(() => parseInitialSession({ data: new Uint8Array(10) })).toThrow(
      'Invalid initial session size',
    )
  })
})
