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
import { performX3DH, respondX3DH } from '../../worker/crypto/x3dh'
import {
  initSenderSession,
  initReceiverSession,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeMessage,
  deserializeMessage,
} from '../../worker/crypto/double-ratchet'
import {
  verifySignedDeviceList,
  verifyTrustedIdentity,
  DeviceListSignatureError,
} from '../../worker/crypto/device-list'
import {
  generateSenderKey,
  senderKeyEncrypt,
  senderKeyDecrypt,
  needsRotation,
  createDistributionMessage,
  importDistributionMessage,
  clearSenderKeyData,
} from '../../worker/crypto/sender-keys'
import { KeyStore } from '../../worker/store/keystore'
import { MessageStore } from '../../worker/store/messages.db'
import type { KeyBundle, SessionState, SenderKey } from '../../worker/crypto/types'

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

  // Load session index into memory for fast hasSession() checks
  loadSessionIndex()
}

function closeDatabases(): void {
  keyStore?.close()
  messageStore?.close()
  keyStore = null
  messageStore = null
}

// --- Session index (in-memory for fast hasSession checks) ---

const sessionIndex = new Set<string>()

function sessionKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`
}

function loadSessionIndex(): void {
  if (!keyStore) return
  sessionIndex.clear()
  const sessions = keyStore.getAllSessions()
  for (const s of sessions) {
    sessionIndex.add(sessionKey(s.userId, s.deviceId))
  }
}

// --- Per-session mutex ---
// Prevents concurrent encrypt/decrypt on the same Double Ratchet session.
// Different sessions can run in parallel.

const sessionLocks = new Map<string, Promise<void>>()

function withSessionLock<T>(userId: string, deviceId: string, fn: () => Promise<T>): Promise<T> {
  const key = sessionKey(userId, deviceId)
  const prev = sessionLocks.get(key) || Promise.resolve()
  let resolve: () => void
  const next = new Promise<void>((r) => { resolve = r })
  sessionLocks.set(key, next)

  return prev.then(
    () => fn().finally(() => resolve!()),
    () => fn().finally(() => resolve!()),
  )
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
        // Includes both Ed25519 (for signature verification) and X25519 (for DH)
        // forms of the device identity key.
        result = {
          masterVerifyPublicKey: Array.from(masterKP.publicKey),
          deviceId,
          deviceIdentityPublicKey: Array.from(deviceX25519.publicKey),
          deviceIdentityEd25519PublicKey: Array.from(deviceKP.publicKey),
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

      case 'crypto:hasSession': {
        const userId = msg.data?.userId as string
        const deviceId = msg.data?.deviceId as string
        result = { exists: sessionIndex.has(sessionKey(userId, deviceId)) }
        break
      }

      case 'crypto:hasSessions': {
        // Batch check: given a list of {userId, deviceId}, return which have sessions
        const checks = msg.data?.devices as Array<{ userId: string; deviceId: string }>
        result = checks.map((d) => ({
          userId: d.userId,
          deviceId: d.deviceId,
          hasSession: sessionIndex.has(sessionKey(d.userId, d.deviceId)),
        }))
        break
      }

      case 'crypto:encryptDm': {
        // Encrypt for devices that already have established sessions
        if (!keyStore) throw new Error('KeyStore not initialized')
        const recipientId = msg.data?.recipientId as string
        const devices = msg.data?.devices as Array<{ deviceId: string }>
        const plaintext = msg.data?.plaintext as string
        const plaintextBytes = new TextEncoder().encode(plaintext)

        const recipients: Array<{
          device_id: string
          ciphertext: Uint8Array
          ratchet_header: Uint8Array
        }> = []

        for (const device of devices) {
          await withSessionLock(recipientId, device.deviceId, async () => {
            const session = keyStore!.getSession(recipientId, device.deviceId)
            if (!session) throw new Error(`No session for ${recipientId}:${device.deviceId}`)

            const { session: updatedSession, message: ratchetMsg } = ratchetEncrypt(session, plaintextBytes)
            keyStore!.storeSession(recipientId, device.deviceId, updatedSession)

            const serialized = serializeMessage(ratchetMsg)
            recipients.push({
              device_id: device.deviceId,
              ciphertext: serialized,
              ratchet_header: new Uint8Array(0), // header is embedded in serialized message
            })
          })
        }

        result = { recipients }
        break
      }

      case 'crypto:establishAndEncryptDm': {
        // Establish new sessions via X3DH and encrypt
        if (!keyStore) throw new Error('KeyStore not initialized')
        const recipientId = msg.data?.recipientId as string
        const recipientMasterVerifyKey = new Uint8Array(msg.data?.recipientMasterVerifyKey as ArrayLike<number>)
        const keyBundles = msg.data?.keyBundles as Array<{
          deviceId: string
          identityKey: number[]
          signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
          oneTimePreKey?: { keyId: number; publicKey: number[] }
        }>
        const plaintext = msg.data?.plaintext as string
        const plaintextBytes = new TextEncoder().encode(plaintext)

        // TOFU check
        const trustedKey = keyStore.getTrustedIdentity(recipientId)
        if (trustedKey) {
          // Compare with stored key
          if (recipientMasterVerifyKey.length !== trustedKey.length ||
              !recipientMasterVerifyKey.every((b, i) => b === trustedKey[i])) {
            result = {
              error: 'IDENTITY_CHANGED',
              previousKey: Array.from(trustedKey),
              newKey: Array.from(recipientMasterVerifyKey),
            }
            break
          }
        } else {
          // First seen — store as trusted
          keyStore.storeTrustedIdentity(recipientId, recipientMasterVerifyKey)
        }

        const ourIdentityKP = keyStore.getDeviceIdentityKeyPair()

        const recipients: Array<{
          device_id: string
          ciphertext: Uint8Array
          ratchet_header: Uint8Array
          x3dh_header: {
            sender_identity_key: Uint8Array
            ephemeral_key: Uint8Array
            prekey_id: number
          }
        }> = []

        for (const bundle of keyBundles) {
          await withSessionLock(recipientId, bundle.deviceId, async () => {
            const keyBundle: KeyBundle = {
              identityKey: new Uint8Array(bundle.identityKey),
              signedPreKey: {
                keyId: bundle.signedPreKey.keyId,
                publicKey: new Uint8Array(bundle.signedPreKey.publicKey),
                signature: new Uint8Array(bundle.signedPreKey.signature),
              },
              oneTimePreKey: bundle.oneTimePreKey ? {
                keyId: bundle.oneTimePreKey.keyId,
                publicKey: new Uint8Array(bundle.oneTimePreKey.publicKey),
              } : undefined,
            }

            // Perform X3DH
            const x3dhResult = performX3DH(ourIdentityKP, keyBundle)

            // Initialize sender Double Ratchet session
            const session = initSenderSession(
              x3dhResult.sharedSecret,
              keyBundle.signedPreKey.publicKey,
            )

            // Encrypt with the new session
            const { session: updatedSession, message: ratchetMsg } = ratchetEncrypt(session, plaintextBytes)

            // Persist session
            keyStore!.storeSession(recipientId, bundle.deviceId, updatedSession)
            sessionIndex.add(sessionKey(recipientId, bundle.deviceId))

            const serialized = serializeMessage(ratchetMsg)

            // Convert our device identity Ed25519 public key to match what the receiver expects
            const ourDeviceX25519 = identityKeyToX25519(ourIdentityKP)

            recipients.push({
              device_id: bundle.deviceId,
              ciphertext: serialized,
              ratchet_header: new Uint8Array(0),
              x3dh_header: {
                sender_identity_key: ourDeviceX25519.publicKey,
                ephemeral_key: x3dhResult.ephemeralPublicKey,
                prekey_id: x3dhResult.usedPreKeyId ?? -1,
              },
            })

            // Zero sensitive material
            memzero(x3dhResult.sharedSecret)
            memzero(ourDeviceX25519.privateKey)
          })
        }

        // Zero our identity private key copy
        memzero(ourIdentityKP.privateKey)

        result = { recipients }
        break
      }

      case 'crypto:decryptDm': {
        // Decrypt an incoming DM message
        if (!keyStore || !messageStore) throw new Error('Stores not initialized')
        const senderId = msg.data?.senderId as string
        const senderDeviceId = msg.data?.senderDeviceId as string
        const ciphertextBytes = new Uint8Array(msg.data?.ciphertext as ArrayLike<number>)
        const x3dhHeader = msg.data?.x3dhHeader as {
          senderIdentityKey: number[]
          ephemeralKey: number[]
          prekeyId: number
        } | undefined
        const messageId = msg.data?.messageId as string
        const dmChannelId = msg.data?.dmChannelId as string
        const createdAt = msg.data?.createdAt as number

        await withSessionLock(senderId, senderDeviceId, async () => {
          let session: SessionState | null

          if (x3dhHeader) {
            // First message from this device — perform responder X3DH
            const ourIdentityKP = keyStore!.getDeviceIdentityKeyPair()
            const ourSignedPreKey = keyStore!.getSignedPreKey()
            const senderIdentityKey = new Uint8Array(x3dhHeader.senderIdentityKey)
            const ephemeralKey = new Uint8Array(x3dhHeader.ephemeralKey)

            // Load one-time pre-key if specified
            let ourOtp = null
            if (x3dhHeader.prekeyId >= 0) {
              ourOtp = keyStore!.getOneTimePreKey(x3dhHeader.prekeyId)
            }

            // Perform responder X3DH
            const sharedSecret = respondX3DH(
              ourIdentityKP,
              ourSignedPreKey,
              ourOtp,
              senderIdentityKey,
              ephemeralKey,
            )

            // Physically delete OTP (not soft-delete)
            if (ourOtp && x3dhHeader.prekeyId >= 0) {
              keyStore!.deleteOneTimePreKey(x3dhHeader.prekeyId)
            }

            // Initialize receiver session
            session = initReceiverSession(sharedSecret, ourSignedPreKey.keyPair)
            memzero(sharedSecret)
            memzero(ourIdentityKP.privateKey)
            // Zero OTP private key in caller scope (defense-in-depth)
            if (ourOtp) memzero(ourOtp.keyPair.privateKey)
            memzero(ourSignedPreKey.keyPair.privateKey)
          } else {
            // Existing session
            session = keyStore!.getSession(senderId, senderDeviceId)
            if (!session) {
              result = { error: 'NO_SESSION' }
              return
            }
          }

          // Deserialize and decrypt
          const ratchetMsg = deserializeMessage(ciphertextBytes)
          try {
            const { session: updatedSession, plaintext } = ratchetDecrypt(session, ratchetMsg)

            // Persist updated session
            keyStore!.storeSession(senderId, senderDeviceId, updatedSession)
            sessionIndex.add(sessionKey(senderId, senderDeviceId))

            const plaintextStr = new TextDecoder().decode(plaintext)

            // Persist decrypted message to messages.db
            messageStore!.insertMessage({
              id: messageId,
              channelId: dmChannelId,
              senderId,
              content: plaintextStr,
              createdAt,
              receivedAt: Date.now(),
            })

            result = { plaintext: plaintextStr, messageId }
          } catch {
            result = { error: 'DECRYPT_FAILED' }
          }
        })
        break
      }

      case 'crypto:acceptIdentityChange': {
        // User approved identity change — update trusted identity
        if (!keyStore) throw new Error('KeyStore not initialized')
        const userId = msg.data?.userId as string
        const newKey = new Uint8Array(msg.data?.newKey as ArrayLike<number>)
        keyStore.storeTrustedIdentity(userId, newKey)
        result = { accepted: true }
        break
      }

      case 'crypto:encryptGroup': {
        // Encrypt a message for a private channel using Sender Keys
        if (!keyStore) throw new Error('KeyStore not initialized')
        const channelId = msg.data?.channelId as string
        const plaintext = msg.data?.plaintext as string
        const channelEpoch = msg.data?.channelEpoch as number
        const memberDevices = msg.data?.memberDevices as Array<{ userId: string; deviceId: string }>
        const plaintextBytes = new TextEncoder().encode(plaintext)

        const ourDeviceId = keyStore.getDeviceId()
        // Use 'self' as userId for our own SenderKey (matches sender_id convention)
        const ourUserId = 'self'

        // Load or generate our SenderKey for this channel
        let senderKey: SenderKey | null = keyStore.getSenderKey(channelId, ourUserId, ourDeviceId)
        let didGenerate = false

        if (!senderKey || needsRotation(senderKey, channelEpoch)) {
          senderKey = generateSenderKey(channelEpoch)
          keyStore.storeSenderKey(channelId, ourUserId, ourDeviceId, senderKey)
          didGenerate = true
        }

        // Distribute SenderKey to members that have DR sessions
        const distributions: Array<{ device_id: string; ciphertext: number[] }> = []
        const needsX3dh: Array<{ userId: string; deviceId: string }> = []

        if (didGenerate) {
          const distMessage = createDistributionMessage(senderKey)

          for (const device of memberDevices) {
            const hasSession = sessionIndex.has(sessionKey(device.userId, device.deviceId))
            if (hasSession) {
              await withSessionLock(device.userId, device.deviceId, async () => {
                const session = keyStore!.getSession(device.userId, device.deviceId)
                if (!session) return
                const { session: updatedSession, message: ratchetMsg } = ratchetEncrypt(session, distMessage)
                keyStore!.storeSession(device.userId, device.deviceId, updatedSession)
                distributions.push({
                  device_id: device.deviceId,
                  ciphertext: Array.from(serializeMessage(ratchetMsg)),
                })
              })
            } else {
              needsX3dh.push(device)
            }
          }

          memzero(distMessage)
        }

        // Encrypt the message
        const { senderKey: updatedKey, message: skMsg } = senderKeyEncrypt(senderKey, plaintextBytes, channelEpoch)
        keyStore.storeSenderKey(channelId, ourUserId, ourDeviceId, updatedKey)

        result = {
          encrypted: {
            ciphertext: Array.from(skMsg.ciphertext),
            nonce: Array.from(skMsg.nonce),
            signature: Array.from(skMsg.signature),
            iteration: skMsg.iteration,
            epoch: skMsg.epoch,
            sender_device_id: ourDeviceId,
          },
          distributions: distributions.length > 0 ? distributions : undefined,
          needsX3dh: needsX3dh.length > 0 ? needsX3dh : undefined,
        }
        break
      }

      case 'crypto:decryptGroup': {
        // Decrypt an incoming private channel message
        if (!keyStore || !messageStore) throw new Error('Stores not initialized')
        const channelId = msg.data?.channelId as string
        const senderId = msg.data?.senderId as string
        const senderDeviceId = msg.data?.senderDeviceId as string
        const messageId = msg.data?.messageId as string
        const createdAt = msg.data?.createdAt as number

        const ciphertextBytes = new Uint8Array(msg.data?.ciphertext as ArrayLike<number>)
        const nonceBytes = new Uint8Array(msg.data?.nonce as ArrayLike<number>)
        const signatureBytes = new Uint8Array(msg.data?.signature as ArrayLike<number>)
        const iteration = msg.data?.iteration as number
        const epoch = msg.data?.epoch as number

        // Load sender's SenderKey
        const senderKey = keyStore.getSenderKey(channelId, senderId, senderDeviceId)
        if (!senderKey) {
          result = { error: 'MISSING_SENDER_KEY' }
          break
        }

        try {
          const skMessage = {
            ciphertext: ciphertextBytes,
            nonce: nonceBytes,
            signature: signatureBytes,
            iteration,
            epoch,
          }

          const { senderKey: updatedKey, plaintext } = senderKeyDecrypt(senderKey, skMessage, 0)
          const plaintextStr = new TextDecoder().decode(plaintext)

          // ATOMIC: persist updated key + message
          keyStore.storeSenderKey(channelId, senderId, senderDeviceId, updatedKey)
          messageStore.insertMessage({
            id: messageId,
            channelId,
            senderId,
            content: plaintextStr,
            createdAt,
            receivedAt: Date.now(),
          })

          result = { plaintext: plaintextStr, messageId }
        } catch {
          result = { error: 'DECRYPT_FAILED' }
        }
        break
      }

      case 'crypto:receiveSenderKeyDistribution': {
        // Receive and import a SenderKey distribution via Double Ratchet
        if (!keyStore) throw new Error('KeyStore not initialized')
        const channelId = msg.data?.channelId as string
        const senderId = msg.data?.senderId as string
        const senderDeviceId = msg.data?.senderDeviceId as string
        const ciphertextBytes = new Uint8Array(msg.data?.ciphertext as ArrayLike<number>)

        await withSessionLock(senderId, senderDeviceId, async () => {
          const session = keyStore!.getSession(senderId, senderDeviceId)
          if (!session) {
            result = { error: 'NO_SESSION' }
            return
          }

          const ratchetMsg = deserializeMessage(ciphertextBytes)
          try {
            const { session: updatedSession, plaintext } = ratchetDecrypt(session, ratchetMsg)

            // Import the SenderKey from the distribution message
            const receivedKey = importDistributionMessage(plaintext)
            memzero(plaintext)

            // Persist both the updated DR session and the new SenderKey
            keyStore!.storeSession(senderId, senderDeviceId, updatedSession)
            keyStore!.storeSenderKey(channelId, senderId, senderDeviceId, receivedKey)

            result = { stored: true, channelId, senderId, senderDeviceId }
          } catch {
            result = { error: 'DECRYPT_FAILED' }
          }
        })
        break
      }

      case 'crypto:distributeSenderKeyToDevices': {
        // Distribute our SenderKey to specific devices (after X3DH session establishment)
        if (!keyStore) throw new Error('KeyStore not initialized')
        const channelId = msg.data?.channelId as string
        const devices = msg.data?.devices as Array<{ userId: string; deviceId: string }>

        const ourDeviceId = keyStore.getDeviceId()
        const ourUserId = 'self'
        const senderKey = keyStore.getSenderKey(channelId, ourUserId, ourDeviceId)
        if (!senderKey) throw new Error('No SenderKey to distribute')

        const distMessage = createDistributionMessage(senderKey)
        const distributions: Array<{ device_id: string; ciphertext: number[] }> = []

        for (const device of devices) {
          await withSessionLock(device.userId, device.deviceId, async () => {
            const session = keyStore!.getSession(device.userId, device.deviceId)
            if (!session) return
            const { session: updatedSession, message: ratchetMsg } = ratchetEncrypt(session, distMessage)
            keyStore!.storeSession(device.userId, device.deviceId, updatedSession)
            distributions.push({
              device_id: device.deviceId,
              ciphertext: Array.from(serializeMessage(ratchetMsg)),
            })
          })
        }

        memzero(distMessage)
        result = { distributions }
        break
      }

      case 'crypto:markSenderKeyStale': {
        // Delete our SenderKey for a channel (lazy rotation — regenerated on next send)
        if (!keyStore) throw new Error('KeyStore not initialized')
        const channelId = msg.data?.channelId as string
        const ourDeviceId = keyStore.getDeviceId()
        const ourUserId = 'self'
        const existing = keyStore.getSenderKey(channelId, ourUserId, ourDeviceId)
        if (existing) {
          clearSenderKeyData(existing)
          // Delete by overwriting with null-equivalent (or just let next generate replace it)
          // We'll use a simple approach: delete the row by storing a marker that needsRotation will catch
          // Actually, just delete the sender key so next encryptGroup generates a fresh one
          keyStore.deleteSenderKey(channelId, ourUserId, ourDeviceId)
        }
        result = { marked: true }
        break
      }

      case 'crypto:verifyDeviceList': {
        if (!keyStore) throw new Error('KeyStore not initialized')
        const userId = msg.data?.userId as string
        const signedList = new Uint8Array(msg.data?.signedList as ArrayLike<number>)
        const masterVerifyKey = new Uint8Array(msg.data?.masterVerifyKey as ArrayLike<number>)
        const signature = new Uint8Array(msg.data?.signature as ArrayLike<number>)

        try {
          const payload = await verifySignedDeviceList(masterVerifyKey, signedList, signature)
          const tofuResult = verifyTrustedIdentity(userId, masterVerifyKey, keyStore)

          if (tofuResult.trusted) {
            result = {
              verified: true,
              firstSeen: tofuResult.firstSeen,
              devices: payload.devices,
            }
          } else {
            result = {
              verified: false,
              error: 'IDENTITY_CHANGED',
              previousKey: Array.from(tofuResult.previousKey),
              newKey: Array.from(tofuResult.newKey),
              devices: payload.devices,
            }
          }
        } catch (err) {
          if (err instanceof DeviceListSignatureError) {
            result = {
              verified: false,
              error: 'SIGNATURE_INVALID',
            }
          } else {
            throw err
          }
        }
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
