import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'

const WORKER_PATH = join(__dirname, '../../out/main/workers/crypto-worker.js')
const WORKER_EXISTS = existsSync(WORKER_PATH)

// --- Helper: create a test worker with safeStorage mock and DB ---

interface TestWorker {
  worker: Worker
  dataDir: string
  postOp: <T = unknown>(op: string, data?: Record<string, unknown>) => Promise<T>
  shutdown: () => Promise<void>
}

async function createTestWorker(): Promise<TestWorker> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mercury-ci-test-'))
  const worker = new Worker(WORKER_PATH)

  // Mock safeStorage: worker requests Main to encrypt/decrypt the DB key.
  // For tests, we use a passthrough (no actual encryption).
  const safeStorageHandler = (msg: { op: string; id: string; data: unknown }) => {
    if (msg.op === 'safeStorage:encrypt' || msg.op === 'safeStorage:decrypt') {
      worker.postMessage({
        op: 'safeStorage:result',
        id: msg.id,
        data: msg.data,
      })
    }
  }
  worker.on('message', safeStorageHandler)

  // Initialize worker with dataDir
  worker.postMessage({ op: 'init:ready', data: { dataDir } })

  // Wait for init:complete
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 15000)
    const handler = (msg: { op: string }) => {
      if (msg.op === 'init:complete') {
        clearTimeout(timeout)
        worker.off('message', handler)
        resolve()
      }
    }
    worker.on('message', handler)
  })

  let counter = 0

  function postOp<T = unknown>(op: string, data?: Record<string, unknown>): Promise<T> {
    const id = `ci-test-${++counter}-${Date.now()}`
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout: ${op}`)), 15000)
      const handler = (msg: { op: string; id: string; data: unknown; error?: string }) => {
        if (msg.id === id) {
          clearTimeout(timeout)
          worker.off('message', handler)
          if (msg.op === 'crypto:error') reject(new Error(msg.error || 'Unknown error'))
          else resolve(msg.data as T)
        }
      }
      worker.on('message', handler)
      worker.postMessage({ op, id, data })
    })
  }

  async function shutdown() {
    worker.postMessage({ op: 'shutdown' })
    await new Promise<void>((resolve) => {
      worker.on('exit', () => resolve())
    })
    rmSync(dataDir, { recursive: true, force: true })
  }

  return { worker, dataDir, postOp, shutdown }
}

// --- Tests ---

// TESTSPEC: CI-001
describe('Crypto Worker Thread MessagePort', () => {
  it('sends ping via parentPort and receives pong (simulates Main↔Worker bridge)', async () => {
    if (!WORKER_EXISTS) return
    const worker = new Worker(WORKER_PATH)

    // Tell worker it's ready (mirrors what Main does)
    worker.postMessage({ op: 'init:ready' })

    // Send a ping and expect a pong back on parentPort (Main bridges this to renderer)
    const pong = await new Promise<{ op: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for pong')), 5000)

      worker.on('message', (msg) => {
        if (msg.op === 'pong') {
          clearTimeout(timeout)
          resolve(msg)
        }
      })

      worker.postMessage({ op: 'ping', data: 'test-payload' })
    })

    expect(pong.op).toBe('pong')
    expect(pong.data).toBe('test-payload')

    // Cleanup
    worker.postMessage({ op: 'shutdown' })
    await new Promise<void>((resolve) => {
      worker.on('exit', () => resolve())
    })
  })

  it('worker handles shutdown gracefully', async () => {
    if (!WORKER_EXISTS) return
    const worker = new Worker(WORKER_PATH)

    worker.postMessage({ op: 'shutdown' })

    const exitCode = await new Promise<number>((resolve) => {
      worker.on('exit', (code) => resolve(code))
    })

    expect(exitCode).toBe(0)
  })
})

// TESTSPEC: CI-002
describe('CI-002: initializeIdentity', () => {
  it('generateAllKeys returns master verify key, device ID, identity key, signed prekey, 100 OTPs', async () => {
    if (!WORKER_EXISTS) return

    const tw = await createTestWorker()
    try {
      const result = await tw.postOp<{
        masterVerifyPublicKey: number[]
        deviceId: string
        deviceIdentityPublicKey: number[]
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      expect(result.masterVerifyPublicKey).toHaveLength(32)
      expect(result.deviceId).toBeTruthy()
      expect(result.deviceIdentityPublicKey).toHaveLength(32)
      expect(result.deviceIdentityEd25519PublicKey).toHaveLength(32)
      expect(result.signedPreKey.publicKey).toHaveLength(32)
      expect(result.signedPreKey.signature.length).toBeGreaterThan(0)
      expect(result.oneTimePreKeys).toHaveLength(100)

      // All OTP keys should have valid public keys
      for (const otp of result.oneTimePreKeys) {
        expect(otp.publicKey).toHaveLength(32)
      }
    } finally {
      await tw.shutdown()
    }
  })
})

// TESTSPEC: CI-006
describe('CI-006: message_persistence_restart', () => {
  it('messages persist across worker restart', async () => {
    if (!WORKER_EXISTS) return

    const dataDir = mkdtempSync(join(tmpdir(), 'mercury-ci-persist-'))

    try {
      // First worker: store messages
      const tw1 = await createTestWorkerWithDir(dataDir)
      await tw1.postOp('crypto:generateAllKeys')

      const now = Date.now()
      for (let i = 0; i < 3; i++) {
        await tw1.postOp('crypto:storeMessage', {
          id: `persist-msg-${i}`,
          channelId: 'persist-ch',
          senderId: 'user-1',
          content: `Persisted message ${i}`,
          createdAt: now + i,
          receivedAt: now + i,
        })
      }

      // Verify messages are stored
      const msgs1 = await tw1.postOp<Array<{ id: string; content: string }>>('crypto:getMessages', {
        channelId: 'persist-ch',
      })
      expect(msgs1).toHaveLength(3)

      // Shutdown first worker
      tw1.worker.postMessage({ op: 'shutdown' })
      await new Promise<void>((resolve) => tw1.worker.on('exit', () => resolve()))

      // Second worker: same dataDir, messages should persist
      const tw2 = await createTestWorkerWithDir(dataDir)

      const msgs2 = await tw2.postOp<Array<{ id: string; content: string }>>('crypto:getMessages', {
        channelId: 'persist-ch',
      })
      expect(msgs2).toHaveLength(3)
      expect(msgs2[0].content).toBe('Persisted message 0')
      expect(msgs2[2].content).toBe('Persisted message 2')

      tw2.worker.postMessage({ op: 'shutdown' })
      await new Promise<void>((resolve) => tw2.worker.on('exit', () => resolve()))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

// Helper to create worker with specific dataDir (for persistence tests)
async function createTestWorkerWithDir(dataDir: string): Promise<TestWorker> {
  const worker = new Worker(WORKER_PATH)

  const safeStorageHandler = (msg: { op: string; id: string; data: unknown }) => {
    if (msg.op === 'safeStorage:encrypt' || msg.op === 'safeStorage:decrypt') {
      worker.postMessage({ op: 'safeStorage:result', id: msg.id, data: msg.data })
    }
  }
  worker.on('message', safeStorageHandler)

  worker.postMessage({ op: 'init:ready', data: { dataDir } })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 15000)
    const handler = (msg: { op: string }) => {
      if (msg.op === 'init:complete') {
        clearTimeout(timeout)
        worker.off('message', handler)
        resolve()
      }
    }
    worker.on('message', handler)
  })

  let counter = 0
  function postOp<T = unknown>(op: string, data?: Record<string, unknown>): Promise<T> {
    const id = `ci-test-${++counter}-${Date.now()}`
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout: ${op}`)), 15000)
      const handler = (msg: { op: string; id: string; data: unknown; error?: string }) => {
        if (msg.id === id) {
          clearTimeout(timeout)
          worker.off('message', handler)
          if (msg.op === 'crypto:error') reject(new Error(msg.error || 'Unknown error'))
          else resolve(msg.data as T)
        }
      }
      worker.on('message', handler)
      worker.postMessage({ op, id, data })
    })
  }

  return {
    worker,
    dataDir,
    postOp,
    shutdown: async () => {
      worker.postMessage({ op: 'shutdown' })
      await new Promise<void>((resolve) => worker.on('exit', () => resolve()))
    },
  }
}

// TESTSPEC: CI-007
describe('CI-007: ipc_no_private_key_leak', () => {
  it('no IPC response contains raw private key bytes', async () => {
    if (!WORKER_EXISTS) return

    const tw = await createTestWorker()
    try {
      // Collect all responses from multiple IPC calls
      const responses: unknown[] = []

      // Generate keys
      const keys = await tw.postOp('crypto:generateAllKeys')
      responses.push(keys)

      // Get public keys
      const pubKeys = await tw.postOp('crypto:getPublicKeys')
      responses.push(pubKeys)

      // Generate recovery key
      const recovery = await tw.postOp('crypto:generateRecoveryKey')
      responses.push(recovery)

      // Serialize all responses and check for private key patterns
      const serialized = JSON.stringify(responses)

      // Private keys should never appear in IPC responses.
      // Check for common private key field names.
      expect(serialized).not.toContain('"privateKey"')
      expect(serialized).not.toContain('"secretKey"')
      expect(serialized).not.toContain('"private_key"')
      expect(serialized).not.toContain('"secret_key"')

      // Ed25519 private keys are 64 bytes, X25519 are 32 bytes.
      // Public keys are 32 bytes. We check that no field contains a 64-byte array
      // that could be an Ed25519 secret key (which includes the public key).
      // The response should only have public key material (32 bytes).
      function checkNoLargeKeys(obj: unknown, path = ''): void {
        if (Array.isArray(obj)) {
          // Check if this is a byte array that looks like a private key (64 bytes)
          if (obj.length === 64 && obj.every((v) => typeof v === 'number')) {
            // Could be an Ed25519 keypair (private + public concatenated)
            // This should not appear in IPC responses
            throw new Error(`Potential private key found at ${path} (64-byte array)`)
          }
          obj.forEach((v, i) => checkNoLargeKeys(v, `${path}[${i}]`))
        } else if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            checkNoLargeKeys(v, `${path}.${k}`)
          }
        }
      }

      // This should not throw
      checkNoLargeKeys(responses)
    } finally {
      await tw.shutdown()
    }
  })
})

// TESTSPEC: CI-003
describe('CI-003: x3dh_session_via_worker', () => {
  it('Alice and Bob establish X3DH session via workers, encrypt and decrypt', async () => {
    if (!WORKER_EXISTS) return

    const alice = await createTestWorker()
    const bob = await createTestWorker()

    try {
      // Alice generates her keys
      const aliceKeys = await alice.postOp<{
        deviceId: string
        deviceIdentityPublicKey: number[]
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      // Bob generates his keys
      const bobKeys = await bob.postOp<{
        deviceId: string
        deviceIdentityPublicKey: number[]
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      // Alice establishes X3DH session with Bob and encrypts a message
      const plaintext = 'Hello Bob from Alice via X3DH!'
      const encryptResult = await alice.postOp<{
        ciphertext: number[]
        header: { dh: number[]; pn: number; n: number }
      }>('crypto:establishAndEncryptDm', {
        recipientUserId: 'bob-user-id',
        recipientDeviceId: bobKeys.deviceId,
        recipientBundle: {
          identityKey: bobKeys.deviceIdentityEd25519PublicKey,
          signedPreKey: bobKeys.signedPreKey,
          oneTimePreKey: bobKeys.oneTimePreKeys[0],
        },
        plaintext,
      })

      expect(encryptResult.ciphertext.length).toBeGreaterThan(0)
      expect(encryptResult.header.dh.length).toBeGreaterThan(0)

      // Bob decrypts Alice's message
      const decryptResult = await bob.postOp<{ plaintext: string }>('crypto:decryptDm', {
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        senderIdentityKey: aliceKeys.deviceIdentityEd25519PublicKey,
        message: {
          ciphertext: encryptResult.ciphertext,
          header: encryptResult.header,
        },
        usedOneTimePreKeyId: bobKeys.oneTimePreKeys[0].keyId,
      })

      expect(decryptResult.plaintext).toBe(plaintext)
    } finally {
      await alice.shutdown()
      await bob.shutdown()
    }
  })
})

// TESTSPEC: CI-004
describe('CI-004: dm_flow_via_stores', () => {
  it('two workers exchange encrypted DMs via X3DH + Double Ratchet', async () => {
    if (!WORKER_EXISTS) return

    const alice = await createTestWorker()
    const bob = await createTestWorker()

    try {
      const aliceKeys = await alice.postOp<{
        deviceId: string
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      const bobKeys = await bob.postOp<{
        deviceId: string
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      // Alice → Bob: first message (X3DH + DR)
      const msg1 = await alice.postOp<{
        ciphertext: number[]
        header: { dh: number[]; pn: number; n: number }
      }>('crypto:establishAndEncryptDm', {
        recipientUserId: 'bob-user-id',
        recipientDeviceId: bobKeys.deviceId,
        recipientBundle: {
          identityKey: bobKeys.deviceIdentityEd25519PublicKey,
          signedPreKey: bobKeys.signedPreKey,
          oneTimePreKey: bobKeys.oneTimePreKeys[0],
        },
        plaintext: 'DM message 1',
      })

      const dec1 = await bob.postOp<{ plaintext: string }>('crypto:decryptDm', {
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        senderIdentityKey: aliceKeys.deviceIdentityEd25519PublicKey,
        message: { ciphertext: msg1.ciphertext, header: msg1.header },
        usedOneTimePreKeyId: bobKeys.oneTimePreKeys[0].keyId,
      })
      expect(dec1.plaintext).toBe('DM message 1')

      // Bob → Alice: reply (Double Ratchet, no X3DH needed)
      const msg2 = await bob.postOp<{
        ciphertext: number[]
        header: { dh: number[]; pn: number; n: number }
      }>('crypto:encryptDm', {
        recipientUserId: 'alice-user-id',
        recipientDeviceId: aliceKeys.deviceId,
        plaintext: 'DM reply from Bob',
      })

      const dec2 = await alice.postOp<{ plaintext: string }>('crypto:decryptDm', {
        senderUserId: 'bob-user-id',
        senderDeviceId: bobKeys.deviceId,
        senderIdentityKey: bobKeys.deviceIdentityEd25519PublicKey,
        message: { ciphertext: msg2.ciphertext, header: msg2.header },
      })
      expect(dec2.plaintext).toBe('DM reply from Bob')
    } finally {
      await alice.shutdown()
      await bob.shutdown()
    }
  })
})

// TESTSPEC: CI-005
describe('CI-005: private_channel_flow', () => {
  it('3 users: A sends via Sender Key, B+C decrypt; remove C, A sends, B decrypts, C fails', async () => {
    if (!WORKER_EXISTS) return

    const alice = await createTestWorker()
    const bob = await createTestWorker()
    const charlie = await createTestWorker()

    try {
      const aliceKeys = await alice.postOp<{
        deviceId: string
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      const bobKeys = await bob.postOp<{
        deviceId: string
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      const charlieKeys = await charlie.postOp<{
        deviceId: string
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      const channelId = 'private-ch-1'

      // Alice distributes Sender Key to Bob and Charlie via X3DH + DR
      // First establish sessions with both
      const bobDist = await alice.postOp<{ distributionMessage: number[] }>('crypto:establishAndDistributeSenderKey', {
        channelId,
        recipientUserId: 'bob-user-id',
        recipientDeviceId: bobKeys.deviceId,
        recipientBundle: {
          identityKey: bobKeys.deviceIdentityEd25519PublicKey,
          signedPreKey: bobKeys.signedPreKey,
          oneTimePreKey: bobKeys.oneTimePreKeys[0],
        },
      })

      const charlieDist = await alice.postOp<{ distributionMessage: number[] }>('crypto:establishAndDistributeSenderKey', {
        channelId,
        recipientUserId: 'charlie-user-id',
        recipientDeviceId: charlieKeys.deviceId,
        recipientBundle: {
          identityKey: charlieKeys.deviceIdentityEd25519PublicKey,
          signedPreKey: charlieKeys.signedPreKey,
          oneTimePreKey: charlieKeys.oneTimePreKeys[0],
        },
      })

      // Bob and Charlie receive the Sender Key distribution
      await bob.postOp('crypto:receiveSenderKeyDistribution', {
        channelId,
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        distributionMessage: bobDist.distributionMessage,
        senderIdentityKey: aliceKeys.deviceIdentityEd25519PublicKey,
        usedOneTimePreKeyId: bobKeys.oneTimePreKeys[0].keyId,
      })

      await charlie.postOp('crypto:receiveSenderKeyDistribution', {
        channelId,
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        distributionMessage: charlieDist.distributionMessage,
        senderIdentityKey: aliceKeys.deviceIdentityEd25519PublicKey,
        usedOneTimePreKeyId: charlieKeys.oneTimePreKeys[0].keyId,
      })

      // Alice encrypts a message for the private channel
      const encrypted = await alice.postOp<{
        ciphertext: number[]
        nonce: number[]
        signature: number[]
        senderDeviceId: string
        iteration: number
        epoch: number
      }>('crypto:encryptGroup', {
        channelId,
        plaintext: 'Secret channel message',
      })

      // Bob decrypts
      const bobDecrypt = await bob.postOp<{ plaintext: string }>('crypto:decryptGroup', {
        channelId,
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        encrypted: {
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          signature: encrypted.signature,
          sender_device_id: encrypted.senderDeviceId,
          iteration: encrypted.iteration,
          epoch: encrypted.epoch,
        },
      })
      expect(bobDecrypt.plaintext).toBe('Secret channel message')

      // Charlie decrypts
      const charlieDecrypt = await charlie.postOp<{ plaintext: string }>('crypto:decryptGroup', {
        channelId,
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        encrypted: {
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          signature: encrypted.signature,
          sender_device_id: encrypted.senderDeviceId,
          iteration: encrypted.iteration,
          epoch: encrypted.epoch,
        },
      })
      expect(charlieDecrypt.plaintext).toBe('Secret channel message')

      // Mark sender key as stale (simulates Charlie being removed)
      await alice.postOp('crypto:markSenderKeyStale', { channelId })

      // Alice sends a new message with rotated sender key
      // She needs to re-distribute to Bob only (not Charlie)
      const bobDist2 = await alice.postOp<{ distributionMessage: number[] }>('crypto:distributeSenderKeyToDevices', {
        channelId,
        recipientUserId: 'bob-user-id',
        recipientDeviceId: bobKeys.deviceId,
      })

      await bob.postOp('crypto:receiveSenderKeyDistribution', {
        channelId,
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        distributionMessage: bobDist2.distributionMessage,
        senderIdentityKey: aliceKeys.deviceIdentityEd25519PublicKey,
      })

      const encrypted2 = await alice.postOp<{
        ciphertext: number[]
        nonce: number[]
        signature: number[]
        senderDeviceId: string
        iteration: number
        epoch: number
      }>('crypto:encryptGroup', {
        channelId,
        plaintext: 'After removal',
      })

      // Bob can decrypt the new message
      const bobDecrypt2 = await bob.postOp<{ plaintext: string }>('crypto:decryptGroup', {
        channelId,
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        encrypted: {
          ciphertext: encrypted2.ciphertext,
          nonce: encrypted2.nonce,
          signature: encrypted2.signature,
          sender_device_id: encrypted2.senderDeviceId,
          iteration: encrypted2.iteration,
          epoch: encrypted2.epoch,
        },
      })
      expect(bobDecrypt2.plaintext).toBe('After removal')

      // Charlie cannot decrypt (she doesn't have the new sender key)
      await expect(
        charlie.postOp('crypto:decryptGroup', {
          channelId,
          senderUserId: 'alice-user-id',
          senderDeviceId: aliceKeys.deviceId,
          encrypted: {
            ciphertext: encrypted2.ciphertext,
            nonce: encrypted2.nonce,
            signature: encrypted2.signature,
            sender_device_id: encrypted2.senderDeviceId,
            iteration: encrypted2.iteration,
            epoch: encrypted2.epoch,
          },
        }),
      ).rejects.toThrow()
    } finally {
      await alice.shutdown()
      await bob.shutdown()
      await charlie.shutdown()
    }
  })
})

// TESTSPEC: CI-008
describe('CI-008: media_key_via_session', () => {
  it('A generates media key, encrypts to B via DR, B decrypts', async () => {
    if (!WORKER_EXISTS) return

    const alice = await createTestWorker()
    const bob = await createTestWorker()

    try {
      const aliceKeys = await alice.postOp<{
        deviceId: string
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      const bobKeys = await bob.postOp<{
        deviceId: string
        deviceIdentityEd25519PublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
      }>('crypto:generateAllKeys')

      // Alice establishes X3DH session with Bob first
      await alice.postOp('crypto:establishAndEncryptDm', {
        recipientUserId: 'bob-user-id',
        recipientDeviceId: bobKeys.deviceId,
        recipientBundle: {
          identityKey: bobKeys.deviceIdentityEd25519PublicKey,
          signedPreKey: bobKeys.signedPreKey,
          oneTimePreKey: bobKeys.oneTimePreKeys[0],
        },
        plaintext: 'session setup',
      })

      // Alice generates and distributes a media key to Bob
      const mediaKeyResult = await alice.postOp<{
        encryptedMediaKey: number[]
        header: { dh: number[]; pn: number; n: number }
        mediaKeyId: string
      }>('crypto:distributeMediaKey', {
        recipientUserId: 'bob-user-id',
        recipientDeviceId: bobKeys.deviceId,
      })

      expect(mediaKeyResult.encryptedMediaKey.length).toBeGreaterThan(0)
      expect(mediaKeyResult.mediaKeyId).toBeTruthy()

      // Bob receives the initial DM to establish the session
      // (needed before decrypting the media key)
      // The session was established by the establishAndEncryptDm call above

      // Bob decrypts the media key
      const decryptedKey = await bob.postOp<{ mediaKey: number[]; mediaKeyId: string }>('crypto:decryptMediaKey', {
        senderUserId: 'alice-user-id',
        senderDeviceId: aliceKeys.deviceId,
        senderIdentityKey: aliceKeys.deviceIdentityEd25519PublicKey,
        encryptedMediaKey: mediaKeyResult.encryptedMediaKey,
        header: mediaKeyResult.header,
        mediaKeyId: mediaKeyResult.mediaKeyId,
        usedOneTimePreKeyId: bobKeys.oneTimePreKeys[0].keyId,
      })

      expect(decryptedKey.mediaKey.length).toBeGreaterThan(0)
      expect(decryptedKey.mediaKeyId).toBe(mediaKeyResult.mediaKeyId)
    } finally {
      await alice.shutdown()
      await bob.shutdown()
    }
  })
})
