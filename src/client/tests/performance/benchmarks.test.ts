// Performance benchmarks for Mercury client crypto operations.
// Validates against targets from the client spec §12.
//
// Run with: pnpm run bench

import { describe, it, expect, beforeAll } from 'vitest'
import {
  ensureSodium,
  generateX25519KeyPair,
  randomBytes,
} from '../../src/worker/crypto/utils'
import {
  initSenderSession,
  initReceiverSession,
  ratchetEncrypt,
  ratchetDecrypt,
} from '../../src/worker/crypto/double-ratchet'
import {
  generateSenderKey,
  createDistributionMessage,
  importDistributionMessage,
  senderKeyEncrypt,
  senderKeyDecrypt,
} from '../../src/worker/crypto/sender-keys'
import {
  generateDeviceIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
} from '../../src/worker/crypto/keygen'
import {
  performX3DH,
  respondX3DH,
} from '../../src/worker/crypto/x3dh'
import type { SessionState, KeyBundle } from '../../src/worker/crypto/types'
import type { RatchetMessage } from '../../src/worker/crypto/double-ratchet'
import type { SenderKeyMessage } from '../../src/worker/crypto/sender-keys'

const enc = new TextEncoder()

beforeAll(async () => {
  await ensureSodium()
})

// --- Helpers ---

function setupDRPair() {
  const sharedSecret = randomBytes(32)
  const bobSPK = generateX25519KeyPair()
  return {
    aliceSession: initSenderSession(sharedSecret, bobSPK.publicKey),
    bobSession: initReceiverSession(sharedSecret, bobSPK),
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function p99(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.99)]
}

function printBenchResult(name: string, times: number[], target?: number) {
  const med = median(times)
  const p = p99(times)
  const min = Math.min(...times)
  const max = Math.max(...times)
  const status = target !== undefined ? (med <= target ? 'PASS' : 'FAIL') : ''
  const targetStr = target !== undefined ? ` (target: ${target}ms)` : ''

  console.log(
    `  ${status ? `[${status}] ` : ''}${name}: ` +
      `median=${med.toFixed(3)}ms, p99=${p.toFixed(3)}ms, ` +
      `min=${min.toFixed(3)}ms, max=${max.toFixed(3)}ms` +
      targetStr,
  )
}

// --- Benchmarks ---

describe('Performance Benchmarks', () => {
  const ITERATIONS = 100

  describe('Double Ratchet (DM encryption)', () => {
    it('message encrypt latency < 200ms', () => {
      console.log('\n=== Double Ratchet Encrypt Benchmark ===')

      const plaintext = enc.encode('Hello, this is a test message for benchmarking!')
      const times: number[] = []

      // Each iteration gets a fresh session (ratchetEncrypt consumes the state)
      let { aliceSession } = setupDRPair()
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now()
        const r = ratchetEncrypt(aliceSession, plaintext)
        times.push(performance.now() - start)
        aliceSession = r.session
      }

      printBenchResult('DR encrypt', times, 200)
      expect(median(times)).toBeLessThan(200)
    })

    it('message decrypt latency < 5ms', () => {
      console.log('\n=== Double Ratchet Decrypt Benchmark ===')

      const plaintext = enc.encode('Hello, this is a test message for benchmarking!')

      // Pre-generate messages with one session pair
      let { aliceSession, bobSession } = setupDRPair()
      const messages: RatchetMessage[] = []
      for (let i = 0; i < ITERATIONS; i++) {
        const r = ratchetEncrypt(aliceSession, plaintext)
        aliceSession = r.session
        messages.push(r.message)
      }

      // Benchmark decryption
      const times: number[] = []
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now()
        const r = ratchetDecrypt(bobSession, messages[i])
        times.push(performance.now() - start)
        bobSession = r.session
      }

      printBenchResult('DR decrypt', times, 5)
      expect(median(times)).toBeLessThan(5)
    })
  })

  describe('Sender Keys (group encryption)', () => {
    it('encrypt latency < 5ms per message', () => {
      console.log('\n=== Sender Key Encrypt Benchmark ===')

      let senderKey = generateSenderKey(0)
      const plaintext = enc.encode('Group message for benchmarking sender key encrypt')

      const times: number[] = []
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now()
        const r = senderKeyEncrypt(senderKey, plaintext, 0)
        times.push(performance.now() - start)
        senderKey = r.senderKey
      }

      printBenchResult('SK encrypt', times, 5)
      expect(median(times)).toBeLessThan(5)
    })

    it('decrypt latency < 5ms per message', () => {
      console.log('\n=== Sender Key Decrypt Benchmark ===')

      let senderKey = generateSenderKey(0)
      const plaintext = enc.encode('Group message for benchmarking sender key decrypt')
      const distMsg = createDistributionMessage(senderKey)

      // Pre-generate messages
      const messages: SenderKeyMessage[] = []
      for (let i = 0; i < ITERATIONS; i++) {
        const r = senderKeyEncrypt(senderKey, plaintext, 0)
        senderKey = r.senderKey
        messages.push(r.message)
      }

      // Import the sender key for "receiver"
      let receiverKey = importDistributionMessage(distMsg)

      // Benchmark decryption
      const times: number[] = []
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now()
        const r = senderKeyDecrypt(receiverKey, messages[i])
        times.push(performance.now() - start)
        receiverKey = r.senderKey
      }

      printBenchResult('SK decrypt', times, 5)
      expect(median(times)).toBeLessThan(5)
    })

    it('lazy rotation for 99 recipients < 3 seconds', () => {
      console.log('\n=== Sender Key Lazy Rotation (99 recipients) Benchmark ===')

      // Simulate: generate new SenderKey + 99 pairwise DR encryptions
      const RECIPIENT_COUNT = 99
      const RUNS = 5

      // Pre-create 99 DR session pairs (need both sides for valid sessions)
      const sessionPairs = Array.from({ length: RECIPIENT_COUNT }, () => setupDRPair())

      const times: number[] = []
      for (let run = 0; run < RUNS; run++) {
        const start = performance.now()

        // Generate new SenderKey
        const newKey = generateSenderKey(run + 1)
        const distMsg = createDistributionMessage(newKey)

        // Encrypt distribution message for each recipient via DR
        for (let i = 0; i < RECIPIENT_COUNT; i++) {
          const r = ratchetEncrypt(sessionPairs[i].aliceSession, distMsg)
          sessionPairs[i].aliceSession = r.session
        }

        times.push(performance.now() - start)
      }

      printBenchResult('SK rotation (99 recipients)', times, 3000)
      expect(median(times)).toBeLessThan(3000)
    })
  })

  describe('Message send pipeline', () => {
    it('encrypt + serialize < 200ms', () => {
      console.log('\n=== Message Send Pipeline Benchmark ===')

      // Simulates: encryptMessage() → serialize → ready for WebSocket send
      let { aliceSession } = setupDRPair()
      const message = JSON.stringify({
        content: 'Hello, this is a realistic chat message!',
        nonce: 12345,
        timestamp: Date.now(),
      })
      const plaintext = enc.encode(message)

      const times: number[] = []
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now()
        const r = ratchetEncrypt(aliceSession, plaintext)
        // Simulate serialization to JSON (what would go over WebSocket)
        JSON.stringify({
          ciphertext: Buffer.from(r.message.ciphertext).toString('base64'),
          header: {
            dh: Buffer.from(r.message.header.dh).toString('base64'),
            pn: r.message.header.pn,
            n: r.message.header.n,
          },
        })
        times.push(performance.now() - start)
        aliceSession = r.session
      }

      printBenchResult('Message send pipeline', times, 200)
      expect(median(times)).toBeLessThan(200)
    })
  })

  // TESTSPEC: PERF-009
  describe('X3DH handshake', () => {
    it('handshake time < 50ms (100 handshakes)', async () => {
      console.log('\n=== X3DH Handshake Benchmark ===')

      // Pre-generate Bob's identity + key bundle once
      const bobIdentity = await generateDeviceIdentityKeyPair()
      const bobSignedPreKey = await generateSignedPreKey(bobIdentity, 1)
      const bobOTPs = await generateOneTimePreKeys(0, ITERATIONS)

      const times: number[] = []
      for (let i = 0; i < ITERATIONS; i++) {
        const aliceIdentity = await generateDeviceIdentityKeyPair()
        const bobBundle: KeyBundle = {
          identityKey: bobIdentity.publicKey,
          signedPreKey: {
            keyId: bobSignedPreKey.keyId,
            publicKey: bobSignedPreKey.keyPair.publicKey,
            signature: bobSignedPreKey.signature,
          },
          oneTimePreKey: {
            keyId: bobOTPs[i].keyId,
            publicKey: bobOTPs[i].keyPair.publicKey,
          },
        }

        const start = performance.now()
        const aliceResult = performX3DH(aliceIdentity, bobBundle)
        respondX3DH(
          bobIdentity,
          bobSignedPreKey,
          bobOTPs[i],
          aliceIdentity.publicKey,
          aliceResult.ephemeralPublicKey,
        )
        times.push(performance.now() - start)
      }

      printBenchResult('X3DH handshake', times, 50)
      expect(median(times)).toBeLessThan(50)
    })
  })
})
