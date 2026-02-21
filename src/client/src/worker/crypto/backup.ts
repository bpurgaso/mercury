// Encrypted key backup creation and restoration.
// See client-spec.md §4.4 and server-spec.md §6.7 for the recovery flow.

import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from 'crypto'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'
import { ensureSodium, randomBytes, memzero } from './utils'
import { deriveBackupEncryptionKey } from './recovery'
import type { IKeyStore, BackupContents } from './types'

export class BackupDecryptionError extends Error {
  constructor(message: string = 'Backup decryption failed — wrong recovery key or corrupted data') {
    super(message)
    this.name = 'BackupDecryptionError'
  }
}

const BACKUP_VERSION = 2
const AES_GCM_NONCE_BYTES = 12
const AES_GCM_TAG_BYTES = 16

/**
 * Create an encrypted key backup blob from the current KeyStore state.
 *
 * @returns encrypted backup blob + random salt (both needed for restoration)
 */
export async function createBackupBlob(
  keyStore: IKeyStore,
  recoveryKey: Uint8Array,
): Promise<{ encrypted_backup: Uint8Array; salt: Uint8Array }> {
  await ensureSodium()

  // Export all restorable state
  const plaintext = keyStore.exportBackupBlob()

  // Generate random salt for key derivation
  const salt = randomBytes(32)

  // Derive AES-256-GCM key from recovery key + salt
  const backupKey = deriveBackupEncryptionKey(recoveryKey, salt)

  // Encrypt with AES-256-GCM
  const nonce = nodeRandomBytes(AES_GCM_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', backupKey, nonce)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  // Format: nonce (12) || ciphertext || tag (16)
  const result = new Uint8Array(AES_GCM_NONCE_BYTES + encrypted.length + AES_GCM_TAG_BYTES)
  result.set(nonce, 0)
  result.set(encrypted, AES_GCM_NONCE_BYTES)
  result.set(tag, AES_GCM_NONCE_BYTES + encrypted.length)

  // Zero sensitive material
  memzero(backupKey)
  memzero(plaintext)

  return { encrypted_backup: result, salt }
}

/**
 * Restore keys from an encrypted backup blob.
 *
 * @throws BackupDecryptionError if the recovery key is wrong or data is corrupted
 */
export async function restoreFromBackup(
  encryptedBackup: Uint8Array,
  salt: Uint8Array,
  recoveryKey: Uint8Array,
  keyStore: IKeyStore,
): Promise<void> {
  await ensureSodium()

  if (encryptedBackup.length < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES) {
    throw new BackupDecryptionError('Encrypted backup too short')
  }

  // Derive the same AES key
  const backupKey = deriveBackupEncryptionKey(recoveryKey, salt)

  // Extract nonce, ciphertext, and tag
  const nonce = encryptedBackup.slice(0, AES_GCM_NONCE_BYTES)
  const ciphertextLen = encryptedBackup.length - AES_GCM_NONCE_BYTES - AES_GCM_TAG_BYTES
  const ciphertext = encryptedBackup.slice(AES_GCM_NONCE_BYTES, AES_GCM_NONCE_BYTES + ciphertextLen)
  const tag = encryptedBackup.slice(AES_GCM_NONCE_BYTES + ciphertextLen)

  let plaintext: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', backupKey, nonce)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    memzero(backupKey)
    throw new BackupDecryptionError()
  }

  memzero(backupKey)

  // Import into KeyStore
  const blob = new Uint8Array(plaintext)
  keyStore.importBackupBlob(blob)
  memzero(blob)
}

// --- Server interaction ---

/**
 * Upload an encrypted key backup to the server.
 * PUT /users/me/key-backup
 */
export async function uploadKeyBackup(
  baseUrl: string,
  token: string,
  encryptedBackup: Uint8Array,
  salt: Uint8Array,
): Promise<void> {
  const body = {
    encrypted_backup: Buffer.from(encryptedBackup).toString('base64'),
    key_derivation_salt: Buffer.from(salt).toString('base64'),
  }

  const res = await fetch(`${baseUrl}/users/me/key-backup`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Failed to upload key backup: ${res.status} ${res.statusText}`)
  }
}

/**
 * Download an encrypted key backup from the server.
 * GET /users/me/key-backup
 */
export async function downloadKeyBackup(
  baseUrl: string,
  token: string,
): Promise<{ encrypted_backup: Uint8Array; salt: Uint8Array; backup_version: number } | null> {
  const res = await fetch(`${baseUrl}/users/me/key-backup`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to download key backup: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()
  return {
    encrypted_backup: new Uint8Array(Buffer.from(data.encrypted_backup, 'base64')),
    salt: new Uint8Array(Buffer.from(data.key_derivation_salt, 'base64')),
    backup_version: data.backup_version,
  }
}

/**
 * Serialize backup contents to a MessagePack blob.
 * Used by KeyStore.exportBackupBlob().
 */
export function serializeBackupContents(contents: BackupContents): Uint8Array {
  return new Uint8Array(msgpackEncode(contents))
}

/**
 * Deserialize a MessagePack blob to backup contents.
 * Used by KeyStore.importBackupBlob().
 */
export function deserializeBackupContents(blob: Uint8Array): BackupContents {
  const decoded = msgpackDecode(blob) as BackupContents
  if (decoded.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${decoded.version}`)
  }
  return decoded
}
