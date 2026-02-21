import { describe, it, expect, beforeAll } from 'vitest'
import {
  ensureSodium,
  generateX25519KeyPair,
  randomBytes,
} from '../../../src/worker/crypto/utils'
import {
  generateDeviceIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
} from '../../../src/worker/crypto/keygen'
import { performX3DH, respondX3DH } from '../../../src/worker/crypto/x3dh'
import type { KeyBundle } from '../../../src/worker/crypto/types'
import {
  initSenderSession,
  initReceiverSession,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeMessage,
  deserializeMessage,
} from '../../../src/worker/crypto/double-ratchet'
import type { SessionState } from '../../../src/worker/crypto/types'
import type { RatchetMessage } from '../../../src/worker/crypto/double-ratchet'

const enc = new TextEncoder()
const dec = new TextDecoder()

beforeAll(async () => {
  await ensureSodium()
})

/** Create a pair of Double Ratchet sessions using a random shared secret. */
function setupSessions(): { aliceSession: SessionState; bobSession: SessionState } {
  const sharedSecret = randomBytes(32)
  const bobSPK = generateX25519KeyPair()
  const aliceSession = initSenderSession(sharedSecret, bobSPK.publicKey)
  const bobSession = initReceiverSession(sharedSecret, bobSPK)
  return { aliceSession, bobSession }
}

/** Send multiple messages, returning updated session and all messages. */
function sendMany(
  session: SessionState,
  count: number,
): { session: SessionState; messages: RatchetMessage[] } {
  const messages: RatchetMessage[] = []
  let current = session
  for (let i = 0; i < count; i++) {
    const result = ratchetEncrypt(current, enc.encode(`msg-${i}`))
    current = result.session
    messages.push(result.message)
  }
  return { session: current, messages }
}

describe('Basic send/receive', () => {
  it('Alice sends 10 messages, Bob decrypts all in order', () => {
    let { aliceSession, bobSession } = setupSessions()

    for (let i = 0; i < 10; i++) {
      const plaintext = enc.encode(`hello-${i}`)
      const encrypted = ratchetEncrypt(aliceSession, plaintext)
      aliceSession = encrypted.session

      const decrypted = ratchetDecrypt(bobSession, encrypted.message)
      bobSession = decrypted.session

      expect(dec.decode(decrypted.plaintext)).toBe(`hello-${i}`)
    }
  })

  it('encrypts empty plaintext', () => {
    let { aliceSession, bobSession } = setupSessions()
    const encrypted = ratchetEncrypt(aliceSession, new Uint8Array(0))
    const decrypted = ratchetDecrypt(bobSession, encrypted.message)
    expect(decrypted.plaintext.length).toBe(0)
  })

  it('encrypts large plaintext', () => {
    let { aliceSession, bobSession } = setupSessions()
    const large = randomBytes(64 * 1024) // 64 KB
    const encrypted = ratchetEncrypt(aliceSession, large)
    const decrypted = ratchetDecrypt(bobSession, encrypted.message)
    expect(decrypted.plaintext).toEqual(large)
  })
})

describe('Bidirectional messaging', () => {
  it('Alice sends 3, Bob replies 3, Alice sends 3', () => {
    let { aliceSession, bobSession } = setupSessions()
    const results: string[] = []

    // Alice → Bob: 3 messages
    for (let i = 0; i < 3; i++) {
      const encrypted = ratchetEncrypt(aliceSession, enc.encode(`a2b-${i}`))
      aliceSession = encrypted.session
      const decrypted = ratchetDecrypt(bobSession, encrypted.message)
      bobSession = decrypted.session
      results.push(dec.decode(decrypted.plaintext))
    }

    // Bob → Alice: 3 messages (triggers DH ratchet on both sides)
    for (let i = 0; i < 3; i++) {
      const encrypted = ratchetEncrypt(bobSession, enc.encode(`b2a-${i}`))
      bobSession = encrypted.session
      const decrypted = ratchetDecrypt(aliceSession, encrypted.message)
      aliceSession = decrypted.session
      results.push(dec.decode(decrypted.plaintext))
    }

    // Alice → Bob: 3 more messages (another DH ratchet)
    for (let i = 0; i < 3; i++) {
      const encrypted = ratchetEncrypt(aliceSession, enc.encode(`a2b2-${i}`))
      aliceSession = encrypted.session
      const decrypted = ratchetDecrypt(bobSession, encrypted.message)
      bobSession = decrypted.session
      results.push(dec.decode(decrypted.plaintext))
    }

    expect(results).toEqual([
      'a2b-0', 'a2b-1', 'a2b-2',
      'b2a-0', 'b2a-1', 'b2a-2',
      'a2b2-0', 'a2b2-1', 'a2b2-2',
    ])
  })

  it('DH ratchet keys change on direction switch', () => {
    let { aliceSession, bobSession } = setupSessions()

    // Alice sends — capture her DH key
    const e1 = ratchetEncrypt(aliceSession, enc.encode('from-alice'))
    aliceSession = e1.session
    const aliceDH1 = e1.message.header.dh

    const d1 = ratchetDecrypt(bobSession, e1.message)
    bobSession = d1.session

    // Bob replies — his DH key should differ from Alice's
    const e2 = ratchetEncrypt(bobSession, enc.encode('from-bob'))
    bobSession = e2.session
    const bobDH1 = e2.message.header.dh

    expect(bobDH1).not.toEqual(aliceDH1)

    const d2 = ratchetDecrypt(aliceSession, e2.message)
    aliceSession = d2.session

    // Alice sends again — her DH key should have changed (new ratchet step)
    const e3 = ratchetEncrypt(aliceSession, enc.encode('from-alice-again'))
    aliceSession = e3.session
    const aliceDH2 = e3.message.header.dh

    expect(aliceDH2).not.toEqual(aliceDH1)

    const d3 = ratchetDecrypt(bobSession, e3.message)
    bobSession = d3.session
    expect(dec.decode(d3.plaintext)).toBe('from-alice-again')
  })
})

describe('Out-of-order delivery', () => {
  it('Alice sends 5, Bob receives in order 4,2,0,3,1', () => {
    const { aliceSession, bobSession } = setupSessions()
    const { messages } = sendMany(aliceSession, 5)

    const order = [4, 2, 0, 3, 1]
    let currentBob = bobSession
    const decrypted: string[] = []

    for (const idx of order) {
      const result = ratchetDecrypt(currentBob, messages[idx])
      currentBob = result.session
      decrypted.push(dec.decode(result.plaintext))
    }

    expect(decrypted).toEqual([
      'msg-4', 'msg-2', 'msg-0', 'msg-3', 'msg-1',
    ])
  })

  it('handles reverse-order delivery', () => {
    const { aliceSession, bobSession } = setupSessions()
    const { messages } = sendMany(aliceSession, 10)

    let currentBob = bobSession
    for (let i = 9; i >= 0; i--) {
      const result = ratchetDecrypt(currentBob, messages[i])
      currentBob = result.session
      expect(dec.decode(result.plaintext)).toBe(`msg-${i}`)
    }
  })
})

describe('Large gap', () => {
  it('Alice sends 100, deliver #99 first, then 0-98', () => {
    const { aliceSession, bobSession } = setupSessions()
    const { messages } = sendMany(aliceSession, 100)

    // Deliver message 99 first — stores 99 skipped keys (0-98)
    let currentBob = bobSession
    const result99 = ratchetDecrypt(currentBob, messages[99])
    currentBob = result99.session
    expect(dec.decode(result99.plaintext)).toBe('msg-99')

    // Deliver messages 0-98 using stored skipped keys
    for (let i = 0; i < 99; i++) {
      const result = ratchetDecrypt(currentBob, messages[i])
      currentBob = result.session
      expect(dec.decode(result.plaintext)).toBe(`msg-${i}`)
    }
  })
})

describe('Skipped key limit', () => {
  it('throws when gap exceeds MAX_SKIP (1000)', () => {
    const { aliceSession, bobSession } = setupSessions()

    // Send 1002 messages
    const { messages } = sendMany(aliceSession, 1002)

    // Trying to deliver message 1001 (gap of 1001) should throw
    expect(() => ratchetDecrypt(bobSession, messages[1001])).toThrow(
      'too many skipped messages',
    )
  })

  it('evicts oldest skipped keys when total exceeds 1000', () => {
    let { aliceSession, bobSession } = setupSessions()

    // Cycle 1: Alice sends 502, Bob receives only message 501 (stores 501 skipped)
    const batch1 = sendMany(aliceSession, 502)
    aliceSession = batch1.session
    const recv1 = ratchetDecrypt(bobSession, batch1.messages[501])
    bobSession = recv1.session
    expect(dec.decode(recv1.plaintext)).toBe('msg-501')

    // Bob replies to trigger ratchet cycle
    const bobReply = ratchetEncrypt(bobSession, enc.encode('bob-reply'))
    bobSession = bobReply.session
    const aliceRecv = ratchetDecrypt(aliceSession, bobReply.message)
    aliceSession = aliceRecv.session

    // Cycle 2: Alice sends 501, Bob receives only message 500 (stores 500 skipped)
    const batch2 = sendMany(aliceSession, 501)
    aliceSession = batch2.session
    const recv2 = ratchetDecrypt(bobSession, batch2.messages[500])
    bobSession = recv2.session
    expect(dec.decode(recv2.plaintext)).toBe('msg-500')

    // Total skipped: 501 + 500 = 1001 → oldest 1 should be evicted
    // Message 0 from batch 1 was the oldest and should be evicted
    expect(() => ratchetDecrypt(bobSession, batch1.messages[0])).toThrow(
      'message authentication failed',
    )

    // Message 1 from batch 1 should still be in MKSKIPPED
    const recvOld = ratchetDecrypt(bobSession, batch1.messages[1])
    bobSession = recvOld.session
    expect(dec.decode(recvOld.plaintext)).toBe('msg-1')

    // Message 0 from batch 2 should still work too
    const recvNew = ratchetDecrypt(bobSession, batch2.messages[0])
    bobSession = recvNew.session
    expect(dec.decode(recvNew.plaintext)).toBe('msg-0')
  })
})

describe('Persistence round-trip', () => {
  it('serialized session continues encrypting/decrypting', () => {
    let { aliceSession, bobSession } = setupSessions()

    // Exchange a few messages to advance the ratchet
    for (let i = 0; i < 3; i++) {
      const e = ratchetEncrypt(aliceSession, enc.encode(`pre-${i}`))
      aliceSession = e.session
      const d = ratchetDecrypt(bobSession, e.message)
      bobSession = d.session
    }

    // Bob replies to trigger DH ratchet
    const reply = ratchetEncrypt(bobSession, enc.encode('reply'))
    bobSession = reply.session
    const recvReply = ratchetDecrypt(aliceSession, reply.message)
    aliceSession = recvReply.session

    // "Persist" sessions by round-tripping through SessionState
    // (SessionState.data is a Uint8Array — simulate storage by copying)
    const alicePersisted: SessionState = { data: new Uint8Array(aliceSession.data) }
    const bobPersisted: SessionState = { data: new Uint8Array(bobSession.data) }

    // Continue with "restored" sessions
    const e1 = ratchetEncrypt(alicePersisted, enc.encode('after-persist'))
    const d1 = ratchetDecrypt(bobPersisted, e1.message)
    expect(dec.decode(d1.plaintext)).toBe('after-persist')

    // And in the other direction
    const e2 = ratchetEncrypt(d1.session, enc.encode('bob-after-persist'))
    const d2 = ratchetDecrypt(e1.session, e2.message)
    expect(dec.decode(d2.plaintext)).toBe('bob-after-persist')
  })

  it('session data round-trips through buffer copy', () => {
    const { aliceSession } = setupSessions()

    // Verify the session data is valid by creating a copy and using it
    const copy = { data: Uint8Array.from(aliceSession.data) }
    const original = ratchetEncrypt(aliceSession, enc.encode('test'))
    const fromCopy = ratchetEncrypt(copy, enc.encode('test'))

    // Both should produce valid messages (different ciphertexts due to random nonces)
    expect(original.message.header.n).toBe(fromCopy.message.header.n)
    expect(original.message.header.pn).toBe(fromCopy.message.header.pn)
    expect(original.message.header.dh).toEqual(fromCopy.message.header.dh)
  })
})

describe('Wrong session', () => {
  it('message from one session cannot be decrypted by another', () => {
    const session1 = setupSessions()
    const session2 = setupSessions()

    // Alice1 sends to Bob1
    const encrypted = ratchetEncrypt(session1.aliceSession, enc.encode('secret'))

    // Bob2 (different session) tries to decrypt → auth failure
    expect(() => ratchetDecrypt(session2.bobSession, encrypted.message)).toThrow(
      'message authentication failed',
    )
  })

  it('tampered ciphertext fails authentication', () => {
    const { aliceSession, bobSession } = setupSessions()
    const encrypted = ratchetEncrypt(aliceSession, enc.encode('original'))

    // Tamper with ciphertext
    const tampered: RatchetMessage = {
      ...encrypted.message,
      ciphertext: new Uint8Array(encrypted.message.ciphertext),
    }
    tampered.ciphertext[0] ^= 0xff

    expect(() => ratchetDecrypt(bobSession, tampered)).toThrow(
      'message authentication failed',
    )
  })

  it('tampered header fails authentication', () => {
    const { aliceSession, bobSession } = setupSessions()
    const encrypted = ratchetEncrypt(aliceSession, enc.encode('original'))

    // Tamper with header (change message number)
    const tampered: RatchetMessage = {
      ...encrypted.message,
      header: { ...encrypted.message.header, n: 999 },
    }

    // This will either throw "too many skipped" or "auth failed"
    expect(() => ratchetDecrypt(bobSession, tampered)).toThrow()
  })
})

describe('Forward secrecy', () => {
  it('same message cannot be decrypted twice with updated session', () => {
    const { aliceSession, bobSession } = setupSessions()

    const encrypted = ratchetEncrypt(aliceSession, enc.encode('one-time'))
    const decrypted = ratchetDecrypt(bobSession, encrypted.message)
    expect(dec.decode(decrypted.plaintext)).toBe('one-time')

    // Try to decrypt the same message with the UPDATED session — should fail
    // because the chain key has advanced past this message number
    expect(() => ratchetDecrypt(decrypted.session, encrypted.message)).toThrow(
      'message authentication failed',
    )
  })

  it('replaying an old message fails after ratchet cycles advance the state', () => {
    let { aliceSession, bobSession } = setupSessions()

    // Alice sends on first chain
    const e1 = ratchetEncrypt(aliceSession, enc.encode('chain-1'))
    aliceSession = e1.session

    // Bob decrypts
    const d1 = ratchetDecrypt(bobSession, e1.message)
    bobSession = d1.session
    expect(dec.decode(d1.plaintext)).toBe('chain-1')

    // Multiple ratchet cycles to advance Bob's state
    const e2 = ratchetEncrypt(bobSession, enc.encode('reply'))
    bobSession = e2.session
    const d2 = ratchetDecrypt(aliceSession, e2.message)
    aliceSession = d2.session

    const e3 = ratchetEncrypt(aliceSession, enc.encode('chain-2'))
    aliceSession = e3.session
    const d3 = ratchetDecrypt(bobSession, e3.message)
    bobSession = d3.session
    expect(dec.decode(d3.plaintext)).toBe('chain-2')

    // Bob's RK, DHs, and chain keys have all advanced through DH ratchets.
    // Replaying e1 triggers a DH ratchet with the wrong root key,
    // producing incorrect chain keys → auth failure.
    expect(() => ratchetDecrypt(bobSession, e1.message)).toThrow(
      'message authentication failed',
    )
  })
})

describe('Wire format serialization', () => {
  it('round-trips a RatchetMessage through serialize/deserialize', () => {
    const { aliceSession } = setupSessions()
    const encrypted = ratchetEncrypt(aliceSession, enc.encode('wire-test'))

    const wire = serializeMessage(encrypted.message)
    const restored = deserializeMessage(wire)

    expect(restored.header.dh).toEqual(encrypted.message.header.dh)
    expect(restored.header.pn).toBe(encrypted.message.header.pn)
    expect(restored.header.n).toBe(encrypted.message.header.n)
    expect(restored.nonce).toEqual(encrypted.message.nonce)
    expect(restored.ciphertext).toEqual(encrypted.message.ciphertext)
  })

  it('wire format overhead is 80 bytes + plaintext', () => {
    const { aliceSession } = setupSessions()
    const plaintext = enc.encode('hello') // 5 bytes
    const encrypted = ratchetEncrypt(aliceSession, plaintext)
    const wire = serializeMessage(encrypted.message)

    // 40 (header) + 24 (nonce) + 5 (plaintext) + 16 (tag) = 85
    expect(wire.length).toBe(85)
  })

  it('rejects too-short wire data', () => {
    expect(() => deserializeMessage(new Uint8Array(79))).toThrow('Invalid message size')
  })

  it('deserialized message decrypts correctly', () => {
    const { aliceSession, bobSession } = setupSessions()
    const encrypted = ratchetEncrypt(aliceSession, enc.encode('roundtrip'))

    const wire = serializeMessage(encrypted.message)
    const restored = deserializeMessage(wire)
    const decrypted = ratchetDecrypt(bobSession, restored)

    expect(dec.decode(decrypted.plaintext)).toBe('roundtrip')
  })
})

describe('X3DH integration', () => {
  it('Double Ratchet works with real X3DH key agreement', async () => {
    const aliceIdentity = await generateDeviceIdentityKeyPair()
    const bobIdentity = await generateDeviceIdentityKeyPair()
    const bobSPK = await generateSignedPreKey(bobIdentity, 1)
    const bobOTPs = await generateOneTimePreKeys(0, 5)

    const bobBundle: KeyBundle = {
      identityKey: bobIdentity.publicKey,
      signedPreKey: {
        keyId: bobSPK.keyId,
        publicKey: bobSPK.keyPair.publicKey,
        signature: bobSPK.signature,
      },
      oneTimePreKey: {
        keyId: bobOTPs[0].keyId,
        publicKey: bobOTPs[0].keyPair.publicKey,
      },
    }

    // X3DH key agreement
    const aliceX3DH = performX3DH(aliceIdentity, bobBundle)
    const bobSharedSecret = respondX3DH(
      bobIdentity,
      bobSPK,
      bobOTPs[0],
      aliceIdentity.publicKey,
      aliceX3DH.ephemeralPublicKey,
    )

    // Initialize Double Ratchet sessions
    let aliceSession = initSenderSession(aliceX3DH.sharedSecret, bobSPK.keyPair.publicKey)
    let bobSession = initReceiverSession(bobSharedSecret, bobSPK.keyPair)

    // Bidirectional messaging
    const e1 = ratchetEncrypt(aliceSession, enc.encode('hello bob'))
    aliceSession = e1.session
    const d1 = ratchetDecrypt(bobSession, e1.message)
    bobSession = d1.session
    expect(dec.decode(d1.plaintext)).toBe('hello bob')

    const e2 = ratchetEncrypt(bobSession, enc.encode('hello alice'))
    bobSession = e2.session
    const d2 = ratchetDecrypt(aliceSession, e2.message)
    aliceSession = d2.session
    expect(dec.decode(d2.plaintext)).toBe('hello alice')

    const e3 = ratchetEncrypt(aliceSession, enc.encode('goodbye'))
    aliceSession = e3.session
    const d3 = ratchetDecrypt(bobSession, e3.message)
    bobSession = d3.session
    expect(dec.decode(d3.plaintext)).toBe('goodbye')
  })
})

describe('Input validation', () => {
  it('initSenderSession rejects wrong-length shared secret', () => {
    expect(() => initSenderSession(new Uint8Array(16), new Uint8Array(32))).toThrow(
      'Invalid shared secret length',
    )
  })

  it('initSenderSession rejects wrong-length DH key', () => {
    expect(() => initSenderSession(new Uint8Array(32), new Uint8Array(16))).toThrow(
      'Invalid DH public key length',
    )
  })

  it('initReceiverSession rejects wrong-length shared secret', () => {
    const kp = generateX25519KeyPair()
    expect(() => initReceiverSession(new Uint8Array(16), kp)).toThrow(
      'Invalid shared secret length',
    )
  })

  it('receiver cannot encrypt before receiving', () => {
    const sharedSecret = randomBytes(32)
    const bobSPK = generateX25519KeyPair()
    const bobSession = initReceiverSession(sharedSecret, bobSPK)

    expect(() => ratchetEncrypt(bobSession, enc.encode('too early'))).toThrow(
      'cannot encrypt without sending chain key',
    )
  })
})
