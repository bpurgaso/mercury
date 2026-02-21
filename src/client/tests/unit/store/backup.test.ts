import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes as nodeRandomBytes } from 'crypto'
import {
  ensureSodium,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  sign,
  randomBytes,
} from '../../../src/worker/crypto/utils'
import { createBackupBlob, restoreFromBackup, BackupDecryptionError } from '../../../src/worker/crypto/backup'
import { generateRecoveryKey } from '../../../src/worker/crypto/recovery'
import { KeyStore } from '../../../src/worker/store/keystore'

let tempDir: string

beforeAll(async () => {
  await ensureSodium()
})

function createTestKeyStore(): KeyStore {
  const dbPath = join(tempDir, `keys-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return new KeyStore(dbPath, new Uint8Array(nodeRandomBytes(32)))
}

/** Populate a KeyStore with all key types for testing. */
function populateKeyStore(ks: KeyStore) {
  // Master verify key
  const masterKP = generateEd25519KeyPair()
  ks.storeMasterVerifyKeyPair(masterKP)

  // Device identity key
  const deviceKP = generateEd25519KeyPair()
  ks.storeDeviceIdentityKeyPair('test-device-123', deviceKP)

  // Signed pre-key
  const spkKeyPair = generateX25519KeyPair()
  const spkSignature = sign(spkKeyPair.publicKey, deviceKP.privateKey)
  ks.storeSignedPreKey({
    keyId: 1,
    keyPair: spkKeyPair,
    signature: spkSignature,
    timestamp: Date.now(),
  })

  // Sessions
  ks.storeSession('user-alice', 'alice-dev-1', { data: randomBytes(128) })
  ks.storeSession('user-alice', 'alice-dev-2', { data: randomBytes(128) })
  ks.storeSession('user-bob', 'bob-dev-1', { data: randomBytes(128) })

  // Sender keys
  ks.storeSenderKey('channel-1', 'user-alice', 'alice-dev-1', { data: randomBytes(72) })
  ks.storeSenderKey('channel-2', 'user-bob', 'bob-dev-1', { data: randomBytes(72) })

  return { masterKP, deviceKP, spkKeyPair, spkSignature }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mercury-backup-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true })
})

describe('createBackupBlob + restoreFromBackup', () => {
  it('round-trips: all keys match after backup and restore', async () => {
    const sourceKS = createTestKeyStore()
    const { masterKP, deviceKP, spkKeyPair, spkSignature } = populateKeyStore(sourceKS)

    const recoveryKey = await generateRecoveryKey()
    const { encrypted_backup, salt } = await createBackupBlob(sourceKS, recoveryKey)

    expect(encrypted_backup).toBeInstanceOf(Uint8Array)
    expect(encrypted_backup.length).toBeGreaterThan(28) // nonce(12) + tag(16) minimum
    expect(salt).toBeInstanceOf(Uint8Array)
    expect(salt.length).toBe(32)

    // Restore into a fresh KeyStore
    const targetKS = createTestKeyStore()
    await restoreFromBackup(encrypted_backup, salt, recoveryKey, targetKS)

    // Verify master verify key
    const restoredMaster = targetKS.getMasterVerifyKeyPair()
    expect(Buffer.from(restoredMaster.publicKey).toString('hex')).toEqual(
      Buffer.from(masterKP.publicKey).toString('hex'),
    )
    expect(Buffer.from(restoredMaster.privateKey).toString('hex')).toEqual(
      Buffer.from(masterKP.privateKey).toString('hex'),
    )

    // Verify device identity key
    expect(targetKS.getDeviceId()).toBe('test-device-123')
    const restoredDevice = targetKS.getDeviceIdentityKeyPair()
    expect(Buffer.from(restoredDevice.publicKey).toString('hex')).toEqual(
      Buffer.from(deviceKP.publicKey).toString('hex'),
    )
    expect(Buffer.from(restoredDevice.privateKey).toString('hex')).toEqual(
      Buffer.from(deviceKP.privateKey).toString('hex'),
    )

    // Verify signed pre-key
    const restoredSPK = targetKS.getSignedPreKey()
    expect(restoredSPK.keyId).toBe(1)
    expect(Buffer.from(restoredSPK.keyPair.publicKey).toString('hex')).toEqual(
      Buffer.from(spkKeyPair.publicKey).toString('hex'),
    )
    expect(Buffer.from(restoredSPK.keyPair.privateKey).toString('hex')).toEqual(
      Buffer.from(spkKeyPair.privateKey).toString('hex'),
    )
    expect(Buffer.from(restoredSPK.signature).toString('hex')).toEqual(
      Buffer.from(spkSignature).toString('hex'),
    )

    // Verify sessions
    const aliceSession1 = targetKS.getSession('user-alice', 'alice-dev-1')
    expect(aliceSession1).not.toBeNull()
    const origSession1 = sourceKS.getSession('user-alice', 'alice-dev-1')
    expect(Buffer.from(aliceSession1!.data).toString('hex')).toEqual(
      Buffer.from(origSession1!.data).toString('hex'),
    )

    const aliceSession2 = targetKS.getSession('user-alice', 'alice-dev-2')
    expect(aliceSession2).not.toBeNull()

    const bobSession = targetKS.getSession('user-bob', 'bob-dev-1')
    expect(bobSession).not.toBeNull()

    // Verify sender keys
    const sk1 = targetKS.getSenderKey('channel-1', 'user-alice', 'alice-dev-1')
    expect(sk1).not.toBeNull()
    const origSK1 = sourceKS.getSenderKey('channel-1', 'user-alice', 'alice-dev-1')
    expect(Buffer.from(sk1!.data).toString('hex')).toEqual(
      Buffer.from(origSK1!.data).toString('hex'),
    )

    const sk2 = targetKS.getSenderKey('channel-2', 'user-bob', 'bob-dev-1')
    expect(sk2).not.toBeNull()

    sourceKS.close()
    targetKS.close()
  })

  it('throws BackupDecryptionError with wrong recovery key', async () => {
    const ks = createTestKeyStore()
    populateKeyStore(ks)

    const correctKey = await generateRecoveryKey()
    const wrongKey = await generateRecoveryKey()

    const { encrypted_backup, salt } = await createBackupBlob(ks, correctKey)

    const targetKS = createTestKeyStore()
    await expect(
      restoreFromBackup(encrypted_backup, salt, wrongKey, targetKS),
    ).rejects.toThrow(BackupDecryptionError)

    ks.close()
    targetKS.close()
  })

  it('throws BackupDecryptionError with wrong salt', async () => {
    const ks = createTestKeyStore()
    populateKeyStore(ks)

    const recoveryKey = await generateRecoveryKey()
    const { encrypted_backup } = await createBackupBlob(ks, recoveryKey)
    const wrongSalt = randomBytes(32)

    const targetKS = createTestKeyStore()
    await expect(
      restoreFromBackup(encrypted_backup, wrongSalt, recoveryKey, targetKS),
    ).rejects.toThrow(BackupDecryptionError)

    ks.close()
    targetKS.close()
  })

  it('throws BackupDecryptionError with tampered ciphertext', async () => {
    const ks = createTestKeyStore()
    populateKeyStore(ks)

    const recoveryKey = await generateRecoveryKey()
    const { encrypted_backup, salt } = await createBackupBlob(ks, recoveryKey)

    // Tamper with the ciphertext (after the 12-byte nonce)
    const tampered = new Uint8Array(encrypted_backup)
    tampered[20] = tampered[20] ^ 0xff

    const targetKS = createTestKeyStore()
    await expect(
      restoreFromBackup(tampered, salt, recoveryKey, targetKS),
    ).rejects.toThrow(BackupDecryptionError)

    ks.close()
    targetKS.close()
  })

  it('throws on too-short encrypted backup', async () => {
    const ks = createTestKeyStore()
    const recoveryKey = await generateRecoveryKey()
    const salt = randomBytes(32)

    await expect(
      restoreFromBackup(new Uint8Array(10), salt, recoveryKey, ks),
    ).rejects.toThrow('Encrypted backup too short')

    ks.close()
  })

  it('backup with no sessions or sender keys still round-trips', async () => {
    const ks = createTestKeyStore()

    // Only store the required keys (no sessions/sender keys)
    ks.storeMasterVerifyKeyPair(generateEd25519KeyPair())
    ks.storeDeviceIdentityKeyPair('minimal-device', generateEd25519KeyPair())
    const spkKP = generateX25519KeyPair()
    ks.storeSignedPreKey({
      keyId: 1,
      keyPair: spkKP,
      signature: sign(spkKP.publicKey, generateEd25519KeyPair().privateKey),
      timestamp: Date.now(),
    })

    const recoveryKey = await generateRecoveryKey()
    const { encrypted_backup, salt } = await createBackupBlob(ks, recoveryKey)

    const targetKS = createTestKeyStore()
    await restoreFromBackup(encrypted_backup, salt, recoveryKey, targetKS)

    expect(targetKS.getDeviceId()).toBe('minimal-device')
    expect(targetKS.getAllSessions()).toHaveLength(0)
    expect(targetKS.getAllSenderKeys()).toHaveLength(0)

    ks.close()
    targetKS.close()
  })
})
