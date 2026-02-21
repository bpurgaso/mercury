import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes as nodeRandomBytes } from 'crypto'
import { ensureSodium, generateEd25519KeyPair } from '../../../src/worker/crypto/utils'
import {
  createSignedDeviceList,
  verifySignedDeviceList,
  verifyTrustedIdentity,
} from '../../../src/worker/crypto/device-list'
import { KeyStore } from '../../../src/worker/store/keystore'

let tempDir: string
let keyStore: KeyStore

beforeAll(async () => {
  await ensureSodium()
})

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mercury-test-'))
  const dbPath = join(tempDir, 'keys.db')
  const encKey = new Uint8Array(nodeRandomBytes(32))
  keyStore = new KeyStore(dbPath, encKey)
})

afterEach(() => {
  keyStore.close()
  rmSync(tempDir, { recursive: true })
})

describe('verifyTrustedIdentity (TOFU)', () => {
  it('accepts and stores a first-seen identity', () => {
    const masterKey = generateEd25519KeyPair().publicKey

    const result = verifyTrustedIdentity('user-1', masterKey, keyStore)
    expect(result.trusted).toBe(true)
    expect(result).toEqual({ trusted: true, firstSeen: true })
  })

  it('accepts the same master key on subsequent encounters', () => {
    const masterKey = generateEd25519KeyPair().publicKey

    // First encounter
    verifyTrustedIdentity('user-1', masterKey, keyStore)

    // Second encounter — same key
    const result = verifyTrustedIdentity('user-1', masterKey, keyStore)
    expect(result.trusted).toBe(true)
    expect(result).toEqual({ trusted: true, firstSeen: false })
  })

  it('rejects a different master key for the same user', () => {
    const originalKey = generateEd25519KeyPair().publicKey
    const newKey = generateEd25519KeyPair().publicKey

    // First encounter
    verifyTrustedIdentity('user-1', originalKey, keyStore)

    // Second encounter — different key
    const result = verifyTrustedIdentity('user-1', newKey, keyStore)
    expect(result.trusted).toBe(false)
    if (!result.trusted) {
      expect(Buffer.from(result.previousKey).toString('hex')).toEqual(
        Buffer.from(originalKey).toString('hex'),
      )
      expect(Buffer.from(result.newKey).toString('hex')).toEqual(
        Buffer.from(newKey).toString('hex'),
      )
    }
  })

  it('handles different users independently', () => {
    const key1 = generateEd25519KeyPair().publicKey
    const key2 = generateEd25519KeyPair().publicKey

    const result1 = verifyTrustedIdentity('user-1', key1, keyStore)
    const result2 = verifyTrustedIdentity('user-2', key2, keyStore)

    expect(result1).toEqual({ trusted: true, firstSeen: true })
    expect(result2).toEqual({ trusted: true, firstSeen: true })

    // Both still trusted
    expect(verifyTrustedIdentity('user-1', key1, keyStore)).toEqual({
      trusted: true,
      firstSeen: false,
    })
    expect(verifyTrustedIdentity('user-2', key2, keyStore)).toEqual({
      trusted: true,
      firstSeen: false,
    })
  })

  it('same master key, updated device list → still accepted', async () => {
    const masterKP = generateEd25519KeyPair()

    // First device list
    const signed1 = await createSignedDeviceList(masterKP, [
      { device_id: 'dev-1', identity_key: 'key1' },
    ])
    await verifySignedDeviceList(masterKP.publicKey, signed1.signed_list, signed1.signature)
    verifyTrustedIdentity('user-1', masterKP.publicKey, keyStore)

    // Updated device list (new device added)
    const signed2 = await createSignedDeviceList(masterKP, [
      { device_id: 'dev-1', identity_key: 'key1' },
      { device_id: 'dev-2', identity_key: 'key2' },
    ])
    await verifySignedDeviceList(masterKP.publicKey, signed2.signed_list, signed2.signature)
    const result = verifyTrustedIdentity('user-1', masterKP.publicKey, keyStore)
    expect(result.trusted).toBe(true)
    expect(result).toEqual({ trusted: true, firstSeen: false })
  })

  it('different master key → identity change warning', async () => {
    const masterKP1 = generateEd25519KeyPair()
    const masterKP2 = generateEd25519KeyPair()

    // First device list with original key
    verifyTrustedIdentity('user-1', masterKP1.publicKey, keyStore)

    // New device list with different master key
    const result = verifyTrustedIdentity('user-1', masterKP2.publicKey, keyStore)
    expect(result.trusted).toBe(false)
  })
})
