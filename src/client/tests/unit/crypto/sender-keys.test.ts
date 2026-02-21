import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  ensureSodium,
  generateX25519KeyPair,
  randomBytes,
} from '../../../src/worker/crypto/utils'
import {
  initSenderSession,
  initReceiverSession,
  ratchetEncrypt,
  ratchetDecrypt,
} from '../../../src/worker/crypto/double-ratchet'
import {
  generateSenderKey,
  ratchetChainKey,
  createDistributionMessage,
  importDistributionMessage,
  distributeSenderKey,
  receiveSenderKeyDistribution,
  senderKeyEncrypt,
  senderKeyDecrypt,
  needsRotation,
  getSenderKeyEpoch,
  clearSenderKeyData,
} from '../../../src/worker/crypto/sender-keys'
import type { SenderKey, SessionState } from '../../../src/worker/crypto/types'
import type { SenderKeyMessage } from '../../../src/worker/crypto/sender-keys'

const enc = new TextEncoder()
const dec = new TextDecoder()

beforeAll(async () => {
  await ensureSodium()
})

/** Create a pair of DR sessions: Alice (sender) ↔ Bob (receiver). */
function setupDRPair(): { aliceSession: SessionState; bobSession: SessionState } {
  const sharedSecret = randomBytes(32)
  const bobSPK = generateX25519KeyPair()
  return {
    aliceSession: initSenderSession(sharedSecret, bobSPK.publicKey),
    bobSession: initReceiverSession(sharedSecret, bobSPK),
  }
}

/** Encrypt N messages with a SenderKey, returning updated key and all messages. */
function encryptMany(
  senderKey: SenderKey,
  count: number,
  epoch: number,
): { senderKey: SenderKey; messages: SenderKeyMessage[] } {
  const messages: SenderKeyMessage[] = []
  let current = senderKey
  for (let i = 0; i < count; i++) {
    const result = senderKeyEncrypt(current, enc.encode(`msg-${i}`), epoch)
    current = result.senderKey
    messages.push(result.message)
  }
  return { senderKey: current, messages }
}

describe('Basic group send/receive', () => {
  it('Alice generates, distributes to Bob and Carol, all decrypt', () => {
    // Set up DR sessions: Alice↔Bob and Alice↔Carol
    const ab = setupDRPair()
    const ac = setupDRPair()

    // Alice generates SenderKey at epoch 0
    const aliceKey = generateSenderKey(0)

    // Distribute via DR
    const distMsg = createDistributionMessage(aliceKey)

    // To Bob
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    const bobAliceKey = importDistributionMessage(bobRecv.plaintext)

    // To Carol
    const toCarol = ratchetEncrypt(ac.aliceSession, distMsg)
    const carolRecv = ratchetDecrypt(ac.bobSession, toCarol.message)
    const carolAliceKey = importDistributionMessage(carolRecv.plaintext)

    // Alice encrypts one message
    const { senderKey: _, message } = senderKeyEncrypt(aliceKey, enc.encode('hello group'), 0)

    // Bob decrypts
    const bobResult = senderKeyDecrypt(bobAliceKey, message, 0)
    expect(dec.decode(bobResult.plaintext)).toBe('hello group')

    // Carol decrypts (with her own copy of the key)
    const carolResult = senderKeyDecrypt(carolAliceKey, message, 0)
    expect(dec.decode(carolResult.plaintext)).toBe('hello group')
  })

  it('handles multiple sequential messages', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    // Distribute to Bob
    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    let bobKey = importDistributionMessage(bobRecv.plaintext)

    // Alice sends 10 messages
    let currentAliceKey = aliceKey
    for (let i = 0; i < 10; i++) {
      const { senderKey: updated, message } = senderKeyEncrypt(
        currentAliceKey,
        enc.encode(`msg-${i}`),
        0,
      )
      currentAliceKey = updated

      const result = senderKeyDecrypt(bobKey, message, 0)
      bobKey = result.senderKey
      expect(dec.decode(result.plaintext)).toBe(`msg-${i}`)
    }
  })
})

describe('Chain ratchet', () => {
  it('Alice sends 5 messages, Bob decrypts all, each uses different message key', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    // Distribute to Bob
    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    let bobKey = importDistributionMessage(bobRecv.plaintext)

    // Alice sends 5 messages
    const { messages } = encryptMany(aliceKey, 5, 0)

    // Verify all have distinct iterations
    const iterations = messages.map((m) => m.iteration)
    expect(iterations).toEqual([0, 1, 2, 3, 4])

    // Verify all ciphertexts are different (different message keys)
    for (let i = 0; i < messages.length; i++) {
      for (let j = i + 1; j < messages.length; j++) {
        expect(messages[i].ciphertext).not.toEqual(messages[j].ciphertext)
      }
    }

    // Bob decrypts all 5
    for (let i = 0; i < 5; i++) {
      const result = senderKeyDecrypt(bobKey, messages[i], 0)
      bobKey = result.senderKey
      expect(dec.decode(result.plaintext)).toBe(`msg-${i}`)
    }
  })

  it('ratchetChainKey produces deterministic outputs from same input', () => {
    const chainKey = randomBytes(32)
    const copy = new Uint8Array(chainKey)

    const result1 = ratchetChainKey(chainKey)
    const result2 = ratchetChainKey(copy)

    expect(result1.newChainKey).toEqual(result2.newChainKey)
    expect(result1.messageKey).toEqual(result2.messageKey)
    // New chain key and message key must differ from each other
    expect(result1.newChainKey).not.toEqual(result1.messageKey)
  })

  it('successive ratchets produce different keys', () => {
    let chainKey = randomBytes(32)
    const messageKeys: Uint8Array[] = []

    for (let i = 0; i < 5; i++) {
      const { newChainKey, messageKey } = ratchetChainKey(chainKey)
      messageKeys.push(messageKey)
      chainKey = newChainKey
    }

    // All message keys should be unique
    for (let i = 0; i < messageKeys.length; i++) {
      for (let j = i + 1; j < messageKeys.length; j++) {
        expect(messageKeys[i]).not.toEqual(messageKeys[j])
      }
    }
  })
})

describe('Out-of-order delivery', () => {
  it('deliver message 4 first, then 0-3', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    // Distribute to Bob
    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    let bobKey = importDistributionMessage(bobRecv.plaintext)

    // Alice sends 5 messages
    const { messages } = encryptMany(aliceKey, 5, 0)

    // Deliver message 4 first — Bob ratchets forward, stores keys for 0-3
    const result4 = senderKeyDecrypt(bobKey, messages[4], 0)
    bobKey = result4.senderKey
    expect(dec.decode(result4.plaintext)).toBe('msg-4')

    // Deliver 0-3 using stored skipped keys
    for (let i = 0; i < 4; i++) {
      const result = senderKeyDecrypt(bobKey, messages[i], 0)
      bobKey = result.senderKey
      expect(dec.decode(result.plaintext)).toBe(`msg-${i}`)
    }
  })

  it('deliver in completely reversed order', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    let bobKey = importDistributionMessage(bobRecv.plaintext)

    const { messages } = encryptMany(aliceKey, 10, 0)

    // Deliver in reverse order
    for (let i = 9; i >= 0; i--) {
      const result = senderKeyDecrypt(bobKey, messages[i], 0)
      bobKey = result.senderKey
      expect(dec.decode(result.plaintext)).toBe(`msg-${i}`)
    }
  })

  it('deliver in random order', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    let bobKey = importDistributionMessage(bobRecv.plaintext)

    const { messages } = encryptMany(aliceKey, 5, 0)

    // Deliver in order: 3, 0, 4, 1, 2
    const order = [3, 0, 4, 1, 2]
    for (const idx of order) {
      const result = senderKeyDecrypt(bobKey, messages[idx], 0)
      bobKey = result.senderKey
      expect(dec.decode(result.plaintext)).toBe(`msg-${idx}`)
    }
  })
})

describe('Lazy rotation on member removal', () => {
  it('full lazy rotation flow: remove Carol, Alice rotates on next send', () => {
    // --- Setup: 3-member channel at epoch 0 ---
    const ab = setupDRPair() // Alice ↔ Bob
    const ac = setupDRPair() // Alice ↔ Carol

    const aliceKeyV0 = generateSenderKey(0)

    // Distribute v0 key to Bob and Carol
    const distV0 = createDistributionMessage(aliceKeyV0)
    const toBobV0 = ratchetEncrypt(ab.aliceSession, distV0)
    const bobRecvV0 = ratchetDecrypt(ab.bobSession, toBobV0.message)
    const bobAliceKeyV0 = importDistributionMessage(bobRecvV0.plaintext)

    const toCarolV0 = ratchetEncrypt(ac.aliceSession, distV0)
    const carolRecvV0 = ratchetDecrypt(ac.bobSession, toCarolV0.message)
    const carolAliceKeyV0 = importDistributionMessage(carolRecvV0.plaintext)

    // --- Carol is removed → epoch becomes 1 ---
    expect(needsRotation(aliceKeyV0, 1)).toBe(true)
    expect(needsRotation(aliceKeyV0, 0)).toBe(false)

    // --- Alice generates new key at epoch 1, distributes to Bob only ---
    const aliceKeyV1 = generateSenderKey(1)
    expect(getSenderKeyEpoch(aliceKeyV1)).toBe(1)

    // Distribute v1 to Bob using updated DR sessions
    const distV1 = createDistributionMessage(aliceKeyV1)
    const toBobV1 = ratchetEncrypt(toBobV0.session, distV1)
    const bobRecvV1 = ratchetDecrypt(bobRecvV0.session, toBobV1.message)
    const bobAliceKeyV1 = importDistributionMessage(bobRecvV1.plaintext)

    // --- Alice encrypts with new key ---
    const { message: newMsg } = senderKeyEncrypt(
      aliceKeyV1,
      enc.encode('post-removal'),
      1,
    )

    // Bob decrypts with v1 key — success
    const bobResult = senderKeyDecrypt(bobAliceKeyV1, newMsg, 1)
    expect(dec.decode(bobResult.plaintext)).toBe('post-removal')

    // Carol tries with v0 key — fails (epoch mismatch)
    expect(() => senderKeyDecrypt(carolAliceKeyV0, newMsg, 0)).toThrow(
      'epoch mismatch',
    )
  })

  it('old epoch key cannot encrypt after rotation', () => {
    const oldKey = generateSenderKey(0)
    expect(() => senderKeyEncrypt(oldKey, enc.encode('stale'), 1)).toThrow(
      'epoch mismatch',
    )
  })
})

describe('Epoch validation', () => {
  it('rejects message with epoch below minEpoch', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    // Distribute to Bob
    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    const bobKey = importDistributionMessage(bobRecv.plaintext)

    // Alice encrypts at epoch 0
    const { message } = senderKeyEncrypt(aliceKey, enc.encode('old message'), 0)

    // Bob processes a member removal → his minEpoch is now 1
    // Decrypt should reject the epoch-0 message
    expect(() => senderKeyDecrypt(bobKey, message, 1)).toThrow('stale epoch')
  })

  it('rejects message with epoch mismatching the receiver key', () => {
    // Alice has key at epoch 1
    const aliceKey = generateSenderKey(1)
    const { message } = senderKeyEncrypt(aliceKey, enc.encode('test'), 1)

    // Bob has an old key at epoch 0 (somehow didn't get the new distribution)
    const oldKey = generateSenderKey(0)
    // Manually create a received version of the old key
    const distMsg = createDistributionMessage(oldKey)
    const bobKey = importDistributionMessage(distMsg)

    // Message epoch 1 != key epoch 0
    expect(() => senderKeyDecrypt(bobKey, message, 0)).toThrow('epoch mismatch')
  })

  it('accepts message when epoch equals minEpoch', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(2)

    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    const bobKey = importDistributionMessage(bobRecv.plaintext)

    const { message } = senderKeyEncrypt(aliceKey, enc.encode('epoch-2'), 2)
    const result = senderKeyDecrypt(bobKey, message, 2)
    expect(dec.decode(result.plaintext)).toBe('epoch-2')
  })
})

describe('Distribution via Double Ratchet', () => {
  it('calls encrypt for each member device (mock)', () => {
    const sk = generateSenderKey(0)
    const devices = [
      { userId: 'bob', deviceId: 'dev-b1' },
      { userId: 'carol', deviceId: 'dev-c1' },
      { userId: 'dave', deviceId: 'dev-d1' },
    ]

    const encryptCalls: Array<{ userId: string; deviceId: string }> = []
    const mockSessions = new Map<string, SessionState>()
    for (const d of devices) {
      mockSessions.set(`${d.userId}:${d.deviceId}`, { data: randomBytes(200) })
    }

    const mockEncrypt = vi.fn(
      (session: SessionState, plaintext: Uint8Array) => ({
        session: { data: new Uint8Array(session.data) } as SessionState,
        message: {
          header: { dh: new Uint8Array(32), pn: 0, n: 0 },
          ciphertext: new Uint8Array(plaintext.length + 16),
          nonce: new Uint8Array(24),
        },
      }),
    )

    const getSession = (userId: string, deviceId: string): SessionState => {
      const key = `${userId}:${deviceId}`
      encryptCalls.push({ userId, deviceId })
      return mockSessions.get(key)!
    }

    const results = distributeSenderKey(sk, devices, getSession, mockEncrypt)

    // Verify encrypt was called once per device
    expect(mockEncrypt).toHaveBeenCalledTimes(3)
    expect(results.length).toBe(3)

    // Verify each device got its own call
    expect(encryptCalls).toEqual([
      { userId: 'bob', deviceId: 'dev-b1' },
      { userId: 'carol', deviceId: 'dev-c1' },
      { userId: 'dave', deviceId: 'dev-d1' },
    ])

    // Verify the plaintext passed to encrypt was 72 bytes (distribution message)
    for (const call of mockEncrypt.mock.calls) {
      expect(call[1].length).toBe(72)
    }
  })

  it('end-to-end: distribute and receive via real DR', () => {
    const ab = setupDRPair()

    const aliceKey = generateSenderKey(0)

    const devices = [{ userId: 'bob', deviceId: 'dev1' }]
    const getSession = () => ab.aliceSession

    const results = distributeSenderKey(aliceKey, devices, getSession)
    expect(results.length).toBe(1)

    // Bob receives and decrypts
    const { senderKey: bobKey } = receiveSenderKeyDistribution(
      results[0].message,
      ab.bobSession,
    )

    // Verify Bob can decrypt Alice's messages
    const { message } = senderKeyEncrypt(aliceKey, enc.encode('via-dr'), 0)
    const result = senderKeyDecrypt(bobKey, message, 0)
    expect(dec.decode(result.plaintext)).toBe('via-dr')
  })

  it('rejects distribution to more than 99 devices', () => {
    const sk = generateSenderKey(0)
    const devices = Array.from({ length: 100 }, (_, i) => ({
      userId: `user-${i}`,
      deviceId: `dev-${i}`,
    }))

    expect(() =>
      distributeSenderKey(sk, devices, () => ({ data: new Uint8Array(0) })),
    ).toThrow('100-member cap')
  })

  it('distribution message is exactly 72 bytes', () => {
    const sk = generateSenderKey(0)
    const distMsg = createDistributionMessage(sk)
    expect(distMsg.length).toBe(72)
  })

  it('distribution message does not contain private signing key', () => {
    const sk = generateSenderKey(0)
    const distMsg = createDistributionMessage(sk)
    const imported = importDistributionMessage(distMsg)

    // The imported key should not be able to encrypt (no private signing key)
    expect(() => senderKeyEncrypt(imported, enc.encode('test'), 0)).toThrow(
      'cannot encrypt without private signing key',
    )
  })

  it('rejects invalid distribution message length', () => {
    expect(() => importDistributionMessage(new Uint8Array(71))).toThrow(
      'invalid distribution message length',
    )
    expect(() => importDistributionMessage(new Uint8Array(73))).toThrow(
      'invalid distribution message length',
    )
  })
})

describe('Input validation', () => {
  it('ratchetChainKey rejects wrong-length key', () => {
    expect(() => ratchetChainKey(new Uint8Array(16))).toThrow('Invalid chain key length')
  })

  it('generateSenderKey creates key with correct epoch', () => {
    const sk = generateSenderKey(42)
    expect(getSenderKeyEpoch(sk)).toBe(42)
  })

  it('needsRotation returns false when epochs match', () => {
    const sk = generateSenderKey(5)
    expect(needsRotation(sk, 5)).toBe(false)
  })

  it('needsRotation returns true when epochs differ', () => {
    const sk = generateSenderKey(5)
    expect(needsRotation(sk, 6)).toBe(true)
  })
})

describe('Signature verification', () => {
  it('rejects tampered ciphertext', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    const bobKey = importDistributionMessage(bobRecv.plaintext)

    const { message } = senderKeyEncrypt(aliceKey, enc.encode('original'), 0)

    // Tamper with ciphertext
    const tampered: SenderKeyMessage = {
      ...message,
      ciphertext: new Uint8Array(message.ciphertext),
    }
    tampered.ciphertext[0] ^= 0xff

    expect(() => senderKeyDecrypt(bobKey, tampered, 0)).toThrow(
      'signature verification failed',
    )
  })

  it('rejects tampered iteration', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    const bobKey = importDistributionMessage(bobRecv.plaintext)

    const { message } = senderKeyEncrypt(aliceKey, enc.encode('original'), 0)

    // Tamper with iteration (signature won't match)
    const tampered: SenderKeyMessage = { ...message, iteration: 999 }

    expect(() => senderKeyDecrypt(bobKey, tampered, 0)).toThrow(
      'signature verification failed',
    )
  })
})

describe('Skipped key limits', () => {
  it('rejects gap exceeding MAX_SKIP (1000)', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    const bobKey = importDistributionMessage(bobRecv.plaintext)

    // Send 1002 messages
    const { messages } = encryptMany(aliceKey, 1002, 0)

    // Try to deliver message 1001 (gap of 1001) — should reject
    expect(() => senderKeyDecrypt(bobKey, messages[1001], 0)).toThrow(
      'too many skipped messages',
    )
  })
})

describe('Memory safety', () => {
  function isZeroed(buf: Uint8Array): boolean {
    return buf.every((b) => b === 0)
  }

  it('clearSenderKeyData zeros the buffer', () => {
    const sk = generateSenderKey(0)
    expect(isZeroed(sk.data)).toBe(false)

    clearSenderKeyData(sk)
    expect(isZeroed(sk.data)).toBe(true)
  })
})

describe('Persistence', () => {
  it('SenderKey survives round-trip through buffer copy', () => {
    const ab = setupDRPair()
    const aliceKey = generateSenderKey(0)

    // Distribute
    const distMsg = createDistributionMessage(aliceKey)
    const toBob = ratchetEncrypt(ab.aliceSession, distMsg)
    const bobRecv = ratchetDecrypt(ab.bobSession, toBob.message)
    const bobKey = importDistributionMessage(bobRecv.plaintext)

    // "Persist" Bob's key
    const persisted: SenderKey = { data: new Uint8Array(bobKey.data) }

    // Alice encrypts
    const { message } = senderKeyEncrypt(aliceKey, enc.encode('persisted'), 0)

    // Bob decrypts with "restored" key
    const result = senderKeyDecrypt(persisted, message, 0)
    expect(dec.decode(result.plaintext)).toBe('persisted')
  })
})
