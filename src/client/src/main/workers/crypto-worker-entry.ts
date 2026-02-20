// Crypto Worker Thread entry point
// Phase 6a: crypto primitives, key generation, encrypted stores, lifecycle
//
// Communication model:
//   Renderer ↔ Main (Electron MessagePort bridge) ↔ Worker (parentPort)
// Main bridges renderer messages to/from this worker via parentPort.
// safeStorage requests also go through parentPort to Main.

import { parentPort } from 'worker_threads'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'fs'
import { join } from 'path'
import { ensureSodium, randomBytes, memzero, identityKeyToX25519 } from '../../worker/crypto/utils'
import {
  generateMasterVerifyKeyPair,
  generateDeviceIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
} from '../../worker/crypto/keygen'
import { KeyStore } from '../../worker/store/keystore'
import { MessageStore } from '../../worker/store/messages.db'

if (!parentPort) {
  throw new Error('crypto-worker must be run as a Worker Thread')
}

// --- SafeStorage proxy ---
// Request encrypt/decrypt from Main process (worker cannot access safeStorage directly)

const pendingRequests = new Map<
  string,
  { resolve: (data: unknown) => void; reject: (err: Error) => void }
>()
let requestCounter = 0

function requestSafeStorageEncrypt(plaintext: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const id = `ss-${++requestCounter}`
    pendingRequests.set(id, {
      resolve: (data) => resolve(data as Buffer),
      reject,
    })
    parentPort!.postMessage({ op: 'safeStorage:encrypt', id, data: plaintext })
  })
}

function requestSafeStorageDecrypt(encrypted: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = `ss-${++requestCounter}`
    pendingRequests.set(id, {
      resolve: (data) => resolve(data as string),
      reject,
    })
    parentPort!.postMessage({ op: 'safeStorage:decrypt', id, data: encrypted })
  })
}

function handleSafeStorageResult(msg: { id: string; data: unknown; error?: string }): void {
  const pending = pendingRequests.get(msg.id)
  if (!pending) return
  pendingRequests.delete(msg.id)
  if (msg.error) {
    pending.reject(new Error(msg.error))
  } else {
    pending.resolve(msg.data)
  }
}

// --- Database lifecycle ---

let keyStore: KeyStore | null = null
let messageStore: MessageStore | null = null

async function getOrCreateDbEncryptionKey(dataDir: string): Promise<Uint8Array> {
  const keyFilePath = join(dataDir, 'db-encryption-key')

  if (existsSync(keyFilePath)) {
    // Decrypt the stored key via safeStorage proxy
    const encryptedKey = readFileSync(keyFilePath)
    const base64Key = await requestSafeStorageDecrypt(Buffer.from(encryptedKey))
    const raw = Buffer.from(base64Key, 'base64')
    return new Uint8Array(raw)
  }

  // First launch: generate a new random encryption key
  const newKey = randomBytes(32)
  const base64Key = Buffer.from(newKey).toString('base64')
  const encrypted = await requestSafeStorageEncrypt(base64Key)
  writeFileSync(keyFilePath, Buffer.from(encrypted), { mode: 0o600 })
  chmodSync(keyFilePath, 0o600)
  return newKey
}

/**
 * Remove a pre-existing unencrypted SQLite database file (and WAL/SHM journals).
 * This handles the one-time migration from Phase 5 (plain better-sqlite3)
 * to Phase 6a (SQLCipher-encrypted databases).
 */
function removeUnencryptedDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (existsSync(p)) unlinkSync(p)
  }
}

async function initDatabases(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true })
  await ensureSodium()

  const dbKey = await getOrCreateDbEncryptionKey(dataDir)
  const keysDbPath = join(dataDir, 'keys.db')
  const messagesDbPath = join(dataDir, 'messages.db')

  // Each store constructor zeros its copy of the key after PRAGMA, so pass copies.
  // We may need a second attempt if old unencrypted databases exist on disk.
  try {
    keyStore = new KeyStore(keysDbPath, new Uint8Array(dbKey))
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'SQLITE_NOTADB') {
      console.warn('[Worker] Replacing unencrypted keys.db with encrypted database')
      removeUnencryptedDb(keysDbPath)
      keyStore = new KeyStore(keysDbPath, new Uint8Array(dbKey))
    } else {
      throw err
    }
  }

  try {
    messageStore = new MessageStore(messagesDbPath, new Uint8Array(dbKey))
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'SQLITE_NOTADB') {
      console.warn('[Worker] Replacing unencrypted messages.db with encrypted database')
      removeUnencryptedDb(messagesDbPath)
      messageStore = new MessageStore(messagesDbPath, new Uint8Array(dbKey))
    } else {
      throw err
    }
  }

  memzero(dbKey)
}

function closeDatabases(): void {
  keyStore?.close()
  messageStore?.close()
  keyStore = null
  messageStore = null
}

// --- Crypto operation handlers ---

interface CryptoRequest {
  op: string
  id: string
  data?: Record<string, unknown>
}

async function handleCryptoOp(msg: CryptoRequest): Promise<void> {
  try {
    let result: unknown

    switch (msg.op) {
      case 'crypto:generateAllKeys': {
        if (!keyStore) throw new Error('KeyStore not initialized')

        // 1. Master Verify Key (Ed25519)
        const masterKP = await generateMasterVerifyKeyPair()
        keyStore.storeMasterVerifyKeyPair(masterKP)

        // 2. Device Identity Key (Ed25519 — signs pre-keys)
        const deviceId = (msg.data?.deviceId as string) || crypto.randomUUID()
        const deviceKP = await generateDeviceIdentityKeyPair()
        keyStore.storeDeviceIdentityKeyPair(deviceId, deviceKP)

        // 3. Signed Pre-Key (X25519 signed by Device Identity Key)
        const spk = await generateSignedPreKey(deviceKP)
        keyStore.storeSignedPreKey(spk)

        // 4. One-Time Pre-Keys (X25519 x100)
        const otpKeys = await generateOneTimePreKeys(0, 100)
        keyStore.storeOneTimePreKeys(otpKeys)

        // Convert device Ed25519 → X25519 for server (X3DH needs X25519 form)
        const deviceX25519 = identityKeyToX25519(deviceKP)

        // Zero private keys from the in-memory copies
        memzero(masterKP.privateKey)
        memzero(deviceKP.privateKey)
        memzero(deviceX25519.privateKey)
        memzero(spk.keyPair.privateKey)
        for (const pk of otpKeys) memzero(pk.keyPair.privateKey)

        // Return only public key material for server upload
        result = {
          masterVerifyPublicKey: Array.from(masterKP.publicKey),
          deviceId,
          deviceIdentityPublicKey: Array.from(deviceX25519.publicKey),
          signedPreKey: {
            keyId: spk.keyId,
            publicKey: Array.from(spk.keyPair.publicKey),
            signature: Array.from(spk.signature),
          },
          oneTimePreKeys: otpKeys.map((pk) => ({
            keyId: pk.keyId,
            publicKey: Array.from(pk.keyPair.publicKey),
          })),
        }
        break
      }

      case 'crypto:generateOneTimePreKeys': {
        if (!keyStore) throw new Error('KeyStore not initialized')
        const count = (msg.data?.count as number) || 100
        const startId = keyStore.getNextPreKeyId()
        const otpKeys = await generateOneTimePreKeys(startId, count)
        keyStore.storeOneTimePreKeys(otpKeys)

        for (const pk of otpKeys) memzero(pk.keyPair.privateKey)

        result = {
          startId,
          keys: otpKeys.map((pk) => ({
            keyId: pk.keyId,
            publicKey: Array.from(pk.keyPair.publicKey),
          })),
        }
        break
      }

      case 'crypto:getPublicKeys': {
        if (!keyStore) throw new Error('KeyStore not initialized')
        const master = keyStore.getMasterVerifyKeyPair()
        const device = keyStore.getDeviceIdentityKeyPair()
        const spk = keyStore.getSignedPreKey()
        // Convert device Ed25519 → X25519 for server (X3DH needs X25519 form)
        const deviceX25519PK = identityKeyToX25519(device)
        memzero(master.privateKey)
        memzero(device.privateKey)
        memzero(deviceX25519PK.privateKey)
        memzero(spk.keyPair.privateKey)

        result = {
          masterVerifyPublicKey: Array.from(master.publicKey),
          deviceId: keyStore.getDeviceId(),
          deviceIdentityPublicKey: Array.from(deviceX25519PK.publicKey),
          signedPreKey: {
            keyId: spk.keyId,
            publicKey: Array.from(spk.keyPair.publicKey),
            signature: Array.from(spk.signature),
          },
          unusedPreKeyCount: keyStore.getUnusedOneTimePreKeyCount(),
        }
        break
      }

      case 'crypto:storeMessage': {
        if (!messageStore) throw new Error('MessageStore not initialized')
        const m = msg.data as {
          id: string
          channelId: string
          senderId: string
          content: string
          createdAt: number
        }
        messageStore.insertMessage({
          id: m.id,
          channelId: m.channelId,
          senderId: m.senderId,
          content: m.content,
          createdAt: m.createdAt,
          receivedAt: Date.now(),
        })
        result = { stored: true }
        break
      }

      case 'crypto:getMessages': {
        if (!messageStore) throw new Error('MessageStore not initialized')
        const channelId = msg.data?.channelId as string
        const limit = (msg.data?.limit as number) || 50
        const offset = (msg.data?.offset as number) || 0
        result = messageStore.getMessagesByChannel(channelId, limit, offset)
        break
      }

      default:
        throw new Error(`Unknown crypto op: ${msg.op}`)
    }

    parentPort!.postMessage({ op: 'crypto:result', id: msg.id, data: result })
  } catch (err) {
    parentPort!.postMessage({
      op: 'crypto:error',
      id: msg.id,
      error: String(err),
    })
  }
}

// --- Message handler ---

parentPort.on(
  'message',
  (msg: { op: string; id?: string; data?: unknown; dataDir?: string; error?: string }) => {
    switch (msg.op) {
      case 'init:ready': {
        if (msg.dataDir) {
          initDatabases(msg.dataDir as string)
            .then(() => {
              parentPort!.postMessage({ op: 'init:complete', status: 'ok' })
            })
            .catch((err) => {
              console.error('[Worker] Failed to initialize databases:', err)
              parentPort!.postMessage({
                op: 'init:complete',
                status: 'error',
                error: String(err),
              })
            })
        }
        break
      }
      case 'ping': {
        parentPort!.postMessage({ op: 'pong', data: msg.data ?? 'pong' })
        break
      }
      case 'safeStorage:result': {
        handleSafeStorageResult(msg as { id: string; data: unknown; error?: string })
        break
      }
      case 'shutdown': {
        closeDatabases()
        process.exit(0)
        break // unreachable but satisfies lint
      }
      default: {
        // All crypto:* ops
        if (msg.op.startsWith('crypto:') && msg.id) {
          handleCryptoOp(msg as CryptoRequest)
        }
        break
      }
    }
  },
)
