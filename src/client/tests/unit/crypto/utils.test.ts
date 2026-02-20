import { describe, it, expect, beforeAll } from 'vitest'
import {
  ensureSodium,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  sign,
  verify,
  randomBytes,
  memzero,
  x25519DH,
  keyPairToBytes,
  bytesToKeyPair,
  signingKeyPairToBytes,
  bytesToSigningKeyPair,
} from '../../../src/worker/crypto/utils'

beforeAll(async () => {
  await ensureSodium()
})

describe('Ed25519 signing', () => {
  it('generates keypair, signs data, and verifies signature', () => {
    const kp = generateEd25519KeyPair()

    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.privateKey.length).toBe(64)

    const message = new TextEncoder().encode('hello mercury')
    const sig = sign(message, kp.privateKey)
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.length).toBe(64)

    expect(verify(message, sig, kp.publicKey)).toBe(true)
  })

  it('fails verification when data is tampered', () => {
    const kp = generateEd25519KeyPair()
    const message = new TextEncoder().encode('original message')
    const sig = sign(message, kp.privateKey)

    const tampered = new TextEncoder().encode('tampered message')
    expect(verify(tampered, sig, kp.publicKey)).toBe(false)
  })

  it('fails verification with wrong public key', () => {
    const kp1 = generateEd25519KeyPair()
    const kp2 = generateEd25519KeyPair()
    const message = new TextEncoder().encode('test')
    const sig = sign(message, kp1.privateKey)

    expect(verify(message, sig, kp2.publicKey)).toBe(false)
  })
})

describe('X25519 Diffie-Hellman', () => {
  it('generates keypairs and both sides derive the same shared secret', () => {
    const kpA = generateX25519KeyPair()
    const kpB = generateX25519KeyPair()

    expect(kpA.publicKey.length).toBe(32)
    expect(kpA.privateKey.length).toBe(32)

    const sharedA = x25519DH(kpA.privateKey, kpB.publicKey)
    const sharedB = x25519DH(kpB.privateKey, kpA.publicKey)

    expect(sharedA).toEqual(sharedB)
    expect(sharedA.length).toBe(32)
  })

  it('derives different secrets with different keypairs', () => {
    const kpA = generateX25519KeyPair()
    const kpB = generateX25519KeyPair()
    const kpC = generateX25519KeyPair()

    const sharedAB = x25519DH(kpA.privateKey, kpB.publicKey)
    const sharedAC = x25519DH(kpA.privateKey, kpC.publicKey)

    expect(sharedAB).not.toEqual(sharedAC)
  })
})

describe('randomBytes', () => {
  it('generates the requested number of bytes', () => {
    const buf = randomBytes(32)
    expect(buf).toBeInstanceOf(Uint8Array)
    expect(buf.length).toBe(32)
  })

  it('generates different values each time', () => {
    const a = randomBytes(32)
    const b = randomBytes(32)
    expect(a).not.toEqual(b)
  })
})

describe('memzero', () => {
  it('zeroes a buffer', () => {
    const buf = randomBytes(32)
    const hadNonZero = buf.some((b) => b !== 0)
    expect(hadNonZero).toBe(true)

    memzero(buf)
    expect(buf.every((b) => b === 0)).toBe(true)
  })
})

describe('key serialization', () => {
  it('round-trips an X25519 keypair through bytes', () => {
    const kp = generateX25519KeyPair()
    const bytes = keyPairToBytes(kp)
    const restored = bytesToKeyPair(bytes)

    expect(restored.publicKey).toEqual(kp.publicKey)
    expect(restored.privateKey).toEqual(kp.privateKey)
  })

  it('round-trips an Ed25519 signing keypair through bytes', () => {
    const kp = generateEd25519KeyPair()
    const bytes = signingKeyPairToBytes(kp)
    const restored = bytesToSigningKeyPair(bytes)

    expect(restored.publicKey).toEqual(kp.publicKey)
    expect(restored.privateKey).toEqual(kp.privateKey)
  })

  it('rejects invalid X25519 bytes length', () => {
    expect(() => bytesToKeyPair(new Uint8Array(10))).toThrow('Invalid X25519 keypair bytes')
  })

  it('rejects invalid Ed25519 bytes length', () => {
    expect(() => bytesToSigningKeyPair(new Uint8Array(10))).toThrow('Invalid Ed25519 keypair bytes')
  })
})
