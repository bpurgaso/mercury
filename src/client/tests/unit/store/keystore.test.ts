import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ensureSodium, randomBytes } from '../../../src/worker/crypto/utils'
import {
  generateMasterVerifyKeyPair,
  generateDeviceIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
} from '../../../src/worker/crypto/keygen'
import { KeyStore } from '../../../src/worker/store/keystore'

let tempDir: string
let encryptionKey: Uint8Array

beforeAll(async () => {
  await ensureSodium()
})

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mercury-keystore-test-'))
  encryptionKey = randomBytes(32)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('KeyStore round-trip', () => {
  it('stores and retrieves a master verify keypair', async () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const kp = await generateMasterVerifyKeyPair()

    store.storeMasterVerifyKeyPair(kp)
    const retrieved = store.getMasterVerifyKeyPair()

    expect(retrieved.publicKey).toEqual(kp.publicKey)
    expect(retrieved.privateKey).toEqual(kp.privateKey)

    store.close()
  })

  it('stores and retrieves a device identity keypair', async () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const kp = await generateDeviceIdentityKeyPair()
    const deviceId = 'test-device-123'

    store.storeDeviceIdentityKeyPair(deviceId, kp)

    expect(store.getDeviceId()).toBe(deviceId)
    const retrieved = store.getDeviceIdentityKeyPair()
    expect(retrieved.publicKey).toEqual(kp.publicKey)
    expect(retrieved.privateKey).toEqual(kp.privateKey)

    store.close()
  })

  it('stores and retrieves a signed pre-key', async () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const deviceKP = await generateDeviceIdentityKeyPair()
    const spk = await generateSignedPreKey(deviceKP)

    store.storeSignedPreKey(spk)
    const retrieved = store.getSignedPreKey()

    expect(retrieved.keyId).toBe(spk.keyId)
    expect(retrieved.keyPair.publicKey).toEqual(spk.keyPair.publicKey)
    expect(retrieved.keyPair.privateKey).toEqual(spk.keyPair.privateKey)
    expect(retrieved.signature).toEqual(spk.signature)

    store.close()
  })

  it('stores 100 one-time pre-keys and retrieves each by ID', async () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const prekeys = await generateOneTimePreKeys(0, 100)

    store.storeOneTimePreKeys(prekeys)

    for (const pk of prekeys) {
      const retrieved = store.getOneTimePreKey(pk.keyId)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.keyId).toBe(pk.keyId)
      expect(retrieved!.keyPair.publicKey).toEqual(pk.keyPair.publicKey)
      expect(retrieved!.keyPair.privateKey).toEqual(pk.keyPair.privateKey)
    }

    store.close()
  })

  it('returns null for non-existent one-time pre-key', () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    expect(store.getOneTimePreKey(999)).toBeNull()
    store.close()
  })

  it('marks one-time pre-keys as used', async () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const prekeys = await generateOneTimePreKeys(0, 10)
    store.storeOneTimePreKeys(prekeys)

    expect(store.getUnusedOneTimePreKeyCount()).toBe(10)

    store.markOneTimePreKeyUsed(0)
    store.markOneTimePreKeyUsed(1)
    expect(store.getUnusedOneTimePreKeyCount()).toBe(8)

    // Used keys should not be returned
    expect(store.getOneTimePreKey(0)).toBeNull()
    expect(store.getOneTimePreKey(1)).toBeNull()
    expect(store.getOneTimePreKey(2)).not.toBeNull()

    store.close()
  })

  it('tracks next pre-key ID correctly', async () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))

    // Empty store starts at 0
    expect(store.getNextPreKeyId()).toBe(0)

    const batch1 = await generateOneTimePreKeys(0, 100)
    store.storeOneTimePreKeys(batch1)
    expect(store.getNextPreKeyId()).toBe(100)

    const batch2 = await generateOneTimePreKeys(100, 50)
    store.storeOneTimePreKeys(batch2)
    expect(store.getNextPreKeyId()).toBe(150)

    store.close()
  })

  it('stores and retrieves sessions', () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const sessionData = randomBytes(256)

    store.storeSession('user-1', 'device-1', { data: sessionData })

    const retrieved = store.getSession('user-1', 'device-1')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.data).toEqual(sessionData)

    // Non-existent session returns null
    expect(store.getSession('user-1', 'device-2')).toBeNull()

    store.close()
  })

  it('retrieves all sessions for a user', () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const data1 = randomBytes(128)
    const data2 = randomBytes(128)

    store.storeSession('user-1', 'device-1', { data: data1 })
    store.storeSession('user-1', 'device-2', { data: data2 })
    store.storeSession('user-2', 'device-3', { data: randomBytes(128) })

    const sessions = store.getAllSessionsForUser('user-1')
    expect(sessions.size).toBe(2)
    expect(sessions.get('device-1')!.data).toEqual(data1)
    expect(sessions.get('device-2')!.data).toEqual(data2)

    store.close()
  })

  it('stores and retrieves sender keys', () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const keyData = randomBytes(64)

    store.storeSenderKey('channel-1', 'user-1', 'device-1', { data: keyData })

    const retrieved = store.getSenderKey('channel-1', 'user-1', 'device-1')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.data).toEqual(keyData)

    expect(store.getSenderKey('channel-2', 'user-1', 'device-1')).toBeNull()

    store.close()
  })

  it('stores and retrieves media keys', () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    const mediaKey = randomBytes(32)

    store.storeMediaKey('room-1', mediaKey)

    const retrieved = store.getMediaKey('room-1')
    expect(retrieved).not.toBeNull()
    expect(retrieved).toEqual(mediaKey)

    expect(store.getMediaKey('room-2')).toBeNull()

    store.close()
  })
})

describe('KeyStore wrong encryption key (SQLCipher)', () => {
  it('throws when opening a database with the wrong key', async () => {
    const correctKey = randomBytes(32)
    const wrongKey = randomBytes(32)
    const dbPath = join(tempDir, 'keys.db')

    // Create and populate with correct key
    const store1 = new KeyStore(dbPath, new Uint8Array(correctKey))
    const kp = await generateMasterVerifyKeyPair()
    store1.storeMasterVerifyKeyPair(kp)
    store1.close()

    // Opening with wrong key should throw (SQLCipher fails on first query)
    expect(() => new KeyStore(dbPath, new Uint8Array(wrongKey))).toThrow()
  })
})

describe('KeyStore persistence', () => {
  it('data survives close and reopen with same key', async () => {
    const dbPath = join(tempDir, 'keys.db')

    // Write data
    const store1 = new KeyStore(dbPath, new Uint8Array(encryptionKey))
    const masterKP = await generateMasterVerifyKeyPair()
    store1.storeMasterVerifyKeyPair(masterKP)
    const deviceKP = await generateDeviceIdentityKeyPair()
    store1.storeDeviceIdentityKeyPair('dev-1', deviceKP)
    const sessionData = randomBytes(128)
    store1.storeSession('user-1', 'dev-1', { data: sessionData })
    store1.close()

    // Reopen with same key (must pass copy since constructor zeros the key)
    const store2 = new KeyStore(dbPath, new Uint8Array(encryptionKey))

    const master = store2.getMasterVerifyKeyPair()
    expect(master.publicKey).toEqual(masterKP.publicKey)
    expect(master.privateKey).toEqual(masterKP.privateKey)

    const device = store2.getDeviceIdentityKeyPair()
    expect(device.publicKey).toEqual(deviceKP.publicKey)
    expect(device.privateKey).toEqual(deviceKP.privateKey)

    const session = store2.getSession('user-1', 'dev-1')
    expect(session).not.toBeNull()
    expect(session!.data).toEqual(sessionData)

    store2.close()
  })
})

describe('KeyStore backup stubs', () => {
  it('exportBackupBlob throws not implemented', () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    expect(() => store.exportBackupBlob()).toThrow('Not implemented')
    store.close()
  })

  it('importBackupBlob throws not implemented', () => {
    const store = new KeyStore(join(tempDir, 'keys.db'), new Uint8Array(encryptionKey))
    expect(() => store.importBackupBlob(new Uint8Array(0))).toThrow('Not implemented')
    store.close()
  })
})
