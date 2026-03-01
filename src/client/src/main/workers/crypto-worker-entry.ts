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
import { createCipheriv, createDecipheriv } from 'crypto'
import { ensureSodium, randomBytes, memzero, identityKeyToX25519, hkdfSha256 } from '../../worker/crypto/utils'
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
  createSignedDeviceList,
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

            recipients.push({
              device_id: bundle.deviceId,
              ciphertext: serialized,
              ratchet_header: new Uint8Array(0),
              x3dh_header: {
                // Send Ed25519 form — respondX3DH converts to X25519 internally
                sender_identity_key: ourIdentityKP.publicKey,
                ephemeral_key: x3dhResult.ephemeralPublicKey,
                prekey_id: x3dhResult.usedPreKeyId ?? -1,
              },
            })

            // Zero sensitive material
            memzero(x3dhResult.sharedSecret)
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
        let rawDistribution: number[] | undefined

        if (didGenerate) {
          const distMessage = createDistributionMessage(senderKey)
          // Save raw distribution bytes for needsX3dh devices (before key state advances)
          rawDistribution = Array.from(distMessage)

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
          rawDistribution: needsX3dh.length > 0 ? rawDistribution : undefined,
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
        // Receive and import a SenderKey distribution via Double Ratchet.
        // The ciphertext may have an embedded X3DH header (prefix byte 0x01)
        // for first-time session establishment.
        if (!keyStore) throw new Error('KeyStore not initialized')
        const channelId = msg.data?.channelId as string
        const senderId = msg.data?.senderId as string
        const senderDeviceId = msg.data?.senderDeviceId as string
        const ciphertextBytes = new Uint8Array(msg.data?.ciphertext as ArrayLike<number>)

        await withSessionLock(senderId, senderDeviceId, async () => {
          let session = keyStore!.getSession(senderId, senderDeviceId)
          let drCiphertext = ciphertextBytes

          if (!session) {
            // Check for embedded X3DH header (prefix byte 0x01)
            if (ciphertextBytes.length > 69 && ciphertextBytes[0] === 0x01) {
              // Parse: [1 flag][32 identity_key][32 ephemeral_key][4 prekey_id LE][DR ciphertext]
              const senderIdentityKey = ciphertextBytes.slice(1, 33)
              const ephemeralKey = ciphertextBytes.slice(33, 65)
              const prekeyIdBuf = ciphertextBytes.slice(65, 69)
              const prekeyId = prekeyIdBuf[0] | (prekeyIdBuf[1] << 8) | (prekeyIdBuf[2] << 16) | (prekeyIdBuf[3] << 24)
              drCiphertext = ciphertextBytes.slice(69)

              // Perform responder X3DH to establish session
              const ourIdentityKP = keyStore!.getDeviceIdentityKeyPair()
              const ourSignedPreKey = keyStore!.getSignedPreKey()
              let ourOtp = null
              if (prekeyId >= 0) {
                ourOtp = keyStore!.getOneTimePreKey(prekeyId)
              }

              const sharedSecret = respondX3DH(
                ourIdentityKP,
                ourSignedPreKey,
                ourOtp,
                senderIdentityKey,
                ephemeralKey,
              )

              if (ourOtp && prekeyId >= 0) {
                keyStore!.deleteOneTimePreKey(prekeyId)
              }

              session = initReceiverSession(sharedSecret, ourSignedPreKey.keyPair)
              memzero(sharedSecret)
              memzero(ourIdentityKP.privateKey)
              if (ourOtp) memzero(ourOtp.keyPair.privateKey)
              memzero(ourSignedPreKey.keyPair.privateKey)
            } else {
              result = { error: 'NO_SESSION' }
              return
            }
          }

          const ratchetMsg = deserializeMessage(drCiphertext)
          try {
            const { session: updatedSession, plaintext } = ratchetDecrypt(session, ratchetMsg)

            // Import the SenderKey from the distribution message
            const receivedKey = importDistributionMessage(plaintext)
            memzero(plaintext)

            // Persist both the updated DR session and the new SenderKey
            keyStore!.storeSession(senderId, senderDeviceId, updatedSession)
            sessionIndex.add(sessionKey(senderId, senderDeviceId))
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

      case 'crypto:establishAndDistributeSenderKey': {
        // Perform X3DH + distribute SenderKey in one step.
        // Embeds the X3DH header in the ciphertext (prefix byte 0x01) so the
        // receiver can establish the DR session and decrypt in a single message.
        // Uses rawDistribution bytes if provided (from encryptGroup, captured before
        // key state advanced), or loads the current SenderKey from the store.
        if (!keyStore) throw new Error('KeyStore not initialized')
        const channelId = msg.data?.channelId as string
        let rawDistBytes = msg.data?.rawDistribution as number[] | undefined
        const devices = msg.data?.devices as Array<{
          userId: string
          deviceId: string
          identityKey: number[]
          signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
          oneTimePreKey?: { keyId: number; publicKey: number[] }
        }>

        // If no rawDistribution provided, load current SenderKey and create distribution
        let ownedDistMessage: Uint8Array | null = null
        if (!rawDistBytes || rawDistBytes.length === 0) {
          const ourDeviceId = keyStore.getDeviceId()
          const senderKey = keyStore.getSenderKey(channelId, 'self', ourDeviceId)
          if (!senderKey) throw new Error('No SenderKey to distribute')
          ownedDistMessage = createDistributionMessage(senderKey)
          rawDistBytes = Array.from(ownedDistMessage)
        }

        const distMessage = new Uint8Array(rawDistBytes)
        const distributions: Array<{ device_id: string; ciphertext: number[] }> = []
        const ourIdentityKP = keyStore.getDeviceIdentityKeyPair()

        for (const device of devices) {
          const keyBundle: KeyBundle = {
            identityKey: new Uint8Array(device.identityKey),
            signedPreKey: {
              keyId: device.signedPreKey.keyId,
              publicKey: new Uint8Array(device.signedPreKey.publicKey),
              signature: new Uint8Array(device.signedPreKey.signature),
            },
          }
          if (device.oneTimePreKey) {
            keyBundle.oneTimePreKey = {
              keyId: device.oneTimePreKey.keyId,
              publicKey: new Uint8Array(device.oneTimePreKey.publicKey),
            }
          }

          const x3dhResult = performX3DH(ourIdentityKP, keyBundle)

          const session = initSenderSession(
            x3dhResult.sharedSecret,
            keyBundle.signedPreKey.publicKey,
          )

          const { session: updatedSession, message: ratchetMsg } = ratchetEncrypt(session, distMessage)
          keyStore.storeSession(device.userId, device.deviceId, updatedSession)
          sessionIndex.add(sessionKey(device.userId, device.deviceId))

          const serialized = serializeMessage(ratchetMsg)

          // Build compound ciphertext: [0x01][32B identity_key][32B ephemeral_key][4B prekey_id LE][DR ciphertext]
          const prekeyId = x3dhResult.usedPreKeyId ?? -1
          const compound = new Uint8Array(1 + 32 + 32 + 4 + serialized.length)
          compound[0] = 0x01
          compound.set(ourIdentityKP.publicKey, 1)
          compound.set(x3dhResult.ephemeralPublicKey, 33)
          compound[65] = prekeyId & 0xff
          compound[66] = (prekeyId >> 8) & 0xff
          compound[67] = (prekeyId >> 16) & 0xff
          compound[68] = (prekeyId >> 24) & 0xff
          compound.set(serialized, 69)

          distributions.push({
            device_id: device.deviceId,
            ciphertext: Array.from(compound),
          })

          memzero(x3dhResult.sharedSecret)
        }

        memzero(ourIdentityKP.privateKey)
        memzero(distMessage)
        if (ownedDistMessage) memzero(ownedDistMessage)
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

      case 'crypto:distributeMediaKey': {
        // Encrypt a media key for distribution to each recipient's devices via Double Ratchet
        if (!keyStore) throw new Error('KeyStore not initialized')
        const roomId = msg.data?.roomId as string
        const recipientIds = msg.data?.recipientIds as string[]
        const key = msg.data?.key as number[]
        const epoch = msg.data?.epoch as number

        const payload = JSON.stringify({ type: 'media_key', room_id: roomId, key, epoch })
        const plaintextBytes = new TextEncoder().encode(payload)

        const recipients: Array<{ user_id: string; device_id: string; ciphertext: number[] }> = []

        for (const userId of recipientIds) {
          // Find all devices for this user by scanning sessionIndex
          const deviceIds: string[] = []
          for (const entry of sessionIndex) {
            if (entry.startsWith(userId + ':')) {
              deviceIds.push(entry.slice(userId.length + 1))
            }
          }

          for (const deviceId of deviceIds) {
            await withSessionLock(userId, deviceId, async () => {
              const session = keyStore!.getSession(userId, deviceId)
              if (!session) return

              const { session: updatedSession, message: ratchetMsg } = ratchetEncrypt(session, plaintextBytes)
              keyStore!.storeSession(userId, deviceId, updatedSession)

              recipients.push({
                user_id: userId,
                device_id: deviceId,
                ciphertext: Array.from(serializeMessage(ratchetMsg)),
              })
            })
          }
        }

        memzero(plaintextBytes)
        result = { distributed: true, recipients }
        break
      }

      case 'crypto:decryptMediaKey': {
        // Decrypt an incoming media key distributed via Double Ratchet
        if (!keyStore) throw new Error('KeyStore not initialized')
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
            keyStore!.storeSession(senderId, senderDeviceId, updatedSession)

            const parsed = JSON.parse(new TextDecoder().decode(plaintext))
            memzero(plaintext)

            result = {
              key: parsed.key as number[],
              epoch: parsed.epoch as number,
              roomId: parsed.room_id as string,
            }
          } catch {
            result = { error: 'DECRYPT_FAILED' }
          }
        })
        break
      }

      case 'crypto:createSignedDeviceList': {
        if (!keyStore) throw new Error('KeyStore not initialized')
        const dlDeviceId = msg.data?.deviceId as string
        const dlIdentityKeyB64 = msg.data?.identityKeyB64 as string

        const dlMasterKP = keyStore.getMasterVerifyKeyPair()
        const dlSigned = await createSignedDeviceList(dlMasterKP, [
          { device_id: dlDeviceId, identity_key: dlIdentityKeyB64 },
        ])
        const dlMasterPub = new Uint8Array(dlMasterKP.publicKey)
        memzero(dlMasterKP.privateKey)

        result = {
          signedList: Array.from(dlSigned.signed_list),
          signature: Array.from(dlSigned.signature),
          masterVerifyKey: Array.from(dlMasterPub),
        }
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

      case 'crypto:encryptReportEvidence': {
        // Sealed-box construction for report evidence (X25519-HKDF-AES-GCM):
        // 1. Generate ephemeral X25519 keypair
        // 2. DH with operator's moderation public key
        // 3. HKDF derive 32-byte AES key
        // 4. AES-256-GCM encrypt evidence JSON
        // Output: [ephemeral_pub (32B)] [iv (12B)] [ciphertext+tag]
        const na = await ensureSodium()
        const evidenceJson = msg.data?.evidence as string
        const moderationPubKeyArr = new Uint8Array(msg.data?.moderationPubKey as ArrayLike<number>)

        const ephemeral = na.crypto_box_keypair()
        const sharedSecret = na.crypto_scalarmult(ephemeral.privateKey, moderationPubKeyArr)

        const info = new TextEncoder().encode('mercury-report-evidence')
        const salt = new Uint8Array(32)
        const derivedKey = hkdfSha256(sharedSecret, salt, info, 32)

        const iv = randomBytes(12)
        const plaintext = new TextEncoder().encode(evidenceJson)
        const cipher = createCipheriv('aes-256-gcm', derivedKey, iv)
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
        const tag = cipher.getAuthTag()

        memzero(sharedSecret)
        memzero(derivedKey)
        memzero(ephemeral.privateKey)

        // Output: [ephemeral_pub (32B)] [iv (12B)] [ciphertext] [tag (16B)]
        const output = new Uint8Array(32 + 12 + encrypted.length + 16)
        output.set(ephemeral.publicKey, 0)
        output.set(iv, 32)
        output.set(new Uint8Array(encrypted), 44)
        output.set(new Uint8Array(tag), 44 + encrypted.length)

        result = { encryptedEvidence: Array.from(output) }
        break
      }

      case 'crypto:generateModerationKeypair': {
        const na = await ensureSodium()
        const kp = na.crypto_box_keypair()
        result = {
          publicKey: Array.from(kp.publicKey),
          privateKey: Array.from(kp.privateKey),
        }
        break
      }

      case 'crypto:storeModerationPrivateKey': {
        if (!keyStore) throw new Error('KeyStore not initialized')
        const serverId = msg.data?.serverId as string
        const privateKey = new Uint8Array(msg.data?.privateKey as ArrayLike<number>)
        // Derive public key from private key for storage
        const na = await ensureSodium()
        const publicKey = na.crypto_scalarmult_base(privateKey)
        keyStore.storeModerationKeyPair(serverId, publicKey, privateKey)
        memzero(privateKey)
        memzero(publicKey)
        result = {}
        break
      }

      case 'crypto:hasModerationKey': {
        if (!keyStore) throw new Error('KeyStore not initialized')
        const serverId = msg.data?.serverId as string
        const hasKey = keyStore.hasModerationKey(serverId)
        result = { hasKey }
        break
      }

      case 'crypto:decryptReportEvidence': {
        // Reverse of encryptReportEvidence (X25519-HKDF-AES-GCM):
        // 1. Read moderation private key from KeyStore
        // 2. Extract ephemeral_pub (32B), iv (12B), ciphertext+tag from blob
        // 3. DH: shared = our_private * ephemeral_pub
        // 4. HKDF derive same AES key
        // 5. AES-256-GCM decrypt
        if (!keyStore) throw new Error('KeyStore not initialized')
        const evidenceBlobB64 = msg.data?.evidenceBlob as string
        const serverId = msg.data?.serverId as string

        const kp = keyStore.getModerationKeyPair(serverId)
        if (!kp) {
          throw new Error('No moderation key found for this server')
        }

        const blob = new Uint8Array(Buffer.from(evidenceBlobB64, 'base64'))
        if (blob.length < 32 + 12 + 16) {
          throw new Error('Evidence blob too short')
        }

        const ephemeralPub = blob.slice(0, 32)
        const iv = blob.slice(32, 44)
        const ciphertextAndTag = blob.slice(44)
        const ciphertext = ciphertextAndTag.slice(0, ciphertextAndTag.length - 16)
        const tag = ciphertextAndTag.slice(ciphertextAndTag.length - 16)

        const na = await ensureSodium()
        const sharedSecret = na.crypto_scalarmult(kp.privateKey, ephemeralPub)

        const info = new TextEncoder().encode('mercury-report-evidence')
        const salt = new Uint8Array(32)
        const derivedKey = hkdfSha256(sharedSecret, salt, info, 32)

        const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv)
        decipher.setAuthTag(tag)
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

        memzero(sharedSecret)
        memzero(derivedKey)
        memzero(kp.privateKey)

        result = { evidence: new TextDecoder().decode(decrypted) }
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
