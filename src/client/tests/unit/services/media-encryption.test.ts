import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MediaKeyRing, KEY_RETENTION_MS } from '../../../src/renderer/services/media-key-ring'
import {
  encryptFrameData,
  decryptFrameData,
  generateMediaKey,
  exportMediaKey,
  importMediaKey,
  IV_LENGTH,
  HEADER_LENGTH,
} from '../../../src/renderer/services/frame-crypto'

// --- Helpers ---

async function makeTestKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

// ============================================================
// MediaKeyRing Tests
// ============================================================

describe('MediaKeyRing', () => {
  let keyRing: MediaKeyRing

  beforeEach(() => {
    keyRing = new MediaKeyRing()
  })

  afterEach(() => {
    keyRing.destroy()
  })

  describe('setInitialKey', () => {
    it('sets currentKey and currentEpoch without incrementing', async () => {
      const key = await makeTestKey()
      keyRing.setInitialKey(key, 0)

      expect(keyRing.currentKey).toBe(key)
      expect(keyRing.currentEpoch).toBe(0)
      expect(keyRing.getKeyForEpoch(0)).toBe(key)
    })

    it('allows setting a non-zero initial epoch', async () => {
      const key = await makeTestKey()
      keyRing.setInitialKey(key, 5)

      expect(keyRing.currentEpoch).toBe(5)
      expect(keyRing.getKeyForEpoch(5)).toBe(key)
    })
  })

  describe('rotateKey', () => {
    it('increments currentEpoch and sets new currentKey', async () => {
      const key0 = await makeTestKey()
      keyRing.setInitialKey(key0, 0)

      const key1 = await makeTestKey()
      keyRing.rotateKey(key1)

      expect(keyRing.currentEpoch).toBe(1)
      expect(keyRing.currentKey).toBe(key1)
      expect(keyRing.getKeyForEpoch(1)).toBe(key1)
    })

    it('retains old key for 5 seconds after rotation', async () => {
      vi.useFakeTimers()

      const key0 = await makeTestKey()
      keyRing.setInitialKey(key0, 0)

      const key1 = await makeTestKey()
      keyRing.rotateKey(key1)

      // Old key should still be available immediately after rotation
      expect(keyRing.getKeyForEpoch(0)).toBe(key0)

      // Advance 4 seconds — still available
      vi.advanceTimersByTime(4_000)
      expect(keyRing.getKeyForEpoch(0)).toBe(key0)

      vi.useRealTimers()
    })

    it('deletes old key after 5 seconds', async () => {
      vi.useFakeTimers()

      const key0 = await makeTestKey()
      keyRing.setInitialKey(key0, 0)

      const key1 = await makeTestKey()
      keyRing.rotateKey(key1)

      // Advance past 5 seconds
      vi.advanceTimersByTime(KEY_RETENTION_MS + 100)

      expect(keyRing.getKeyForEpoch(0)).toBeNull()

      vi.useRealTimers()
    })

    it('wraps epoch at 255 → 0', async () => {
      const key = await makeTestKey()
      keyRing.setInitialKey(key, 254)

      const key255 = await makeTestKey()
      keyRing.rotateKey(key255)
      expect(keyRing.currentEpoch).toBe(255)

      const key0 = await makeTestKey()
      keyRing.rotateKey(key0)
      expect(keyRing.currentEpoch).toBe(0)
      expect(keyRing.currentKey).toBe(key0)
      expect(keyRing.getKeyForEpoch(0)).toBe(key0)
    })

    it('handles multiple rapid rotations correctly', async () => {
      vi.useFakeTimers()

      const key0 = await makeTestKey()
      keyRing.setInitialKey(key0, 0)

      const key1 = await makeTestKey()
      keyRing.rotateKey(key1)

      const key2 = await makeTestKey()
      keyRing.rotateKey(key2)

      const key3 = await makeTestKey()
      keyRing.rotateKey(key3)

      // All keys should be accessible
      expect(keyRing.currentEpoch).toBe(3)
      expect(keyRing.getKeyForEpoch(0)).toBe(key0)
      expect(keyRing.getKeyForEpoch(1)).toBe(key1)
      expect(keyRing.getKeyForEpoch(2)).toBe(key2)
      expect(keyRing.getKeyForEpoch(3)).toBe(key3)

      // After 5 seconds, old keys should be gone
      vi.advanceTimersByTime(KEY_RETENTION_MS + 100)

      expect(keyRing.getKeyForEpoch(0)).toBeNull()
      expect(keyRing.getKeyForEpoch(1)).toBeNull()
      expect(keyRing.getKeyForEpoch(2)).toBeNull()
      // Current key should still be accessible
      expect(keyRing.getKeyForEpoch(3)).toBe(key3)

      vi.useRealTimers()
    })
  })

  describe('getKeyForEpoch', () => {
    it('returns key for current epoch', async () => {
      const key = await makeTestKey()
      keyRing.setInitialKey(key, 0)
      expect(keyRing.getKeyForEpoch(0)).toBe(key)
    })

    it('returns null for unknown epoch', async () => {
      const key = await makeTestKey()
      keyRing.setInitialKey(key, 0)
      expect(keyRing.getKeyForEpoch(99)).toBeNull()
    })

    it('returns null when no key has been set', () => {
      expect(keyRing.getKeyForEpoch(0)).toBeNull()
    })

    it('returns null for expired key via Date.now check', async () => {
      const key0 = await makeTestKey()
      keyRing.setInitialKey(key0, 0)

      const key1 = await makeTestKey()

      // Mock Date.now to simulate time passing
      const realNow = Date.now
      let fakeTime = realNow()
      vi.spyOn(Date, 'now').mockImplementation(() => fakeTime)

      keyRing.rotateKey(key1)

      // Old key should be available
      expect(keyRing.getKeyForEpoch(0)).toBe(key0)

      // Move time past expiry
      fakeTime += KEY_RETENTION_MS + 100

      // Old key should be expired
      expect(keyRing.getKeyForEpoch(0)).toBeNull()

      vi.restoreAllMocks()
    })
  })

  describe('destroy', () => {
    it('clears all keys and resets state', async () => {
      vi.useFakeTimers()

      const key = await makeTestKey()
      keyRing.setInitialKey(key, 0)

      const key1 = await makeTestKey()
      keyRing.rotateKey(key1)

      keyRing.destroy()

      expect(keyRing.currentKey).toBeNull()
      expect(keyRing.currentEpoch).toBe(0)
      expect(keyRing.getKeyForEpoch(0)).toBeNull()
      expect(keyRing.getKeyForEpoch(1)).toBeNull()

      vi.useRealTimers()
    })
  })
})

// ============================================================
// Frame Encryption/Decryption Tests (using encryptFrameData/decryptFrameData)
// ============================================================

describe('Sender encrypt (encryptFrameData)', () => {
  it('produces output with correct frame layout: [epoch(1B)] [IV(12B)] [ciphertext]', async () => {
    const keyRing = new MediaKeyRing()
    const key = await makeTestKey()
    keyRing.setInitialKey(key, 0)

    const originalData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const result = await encryptFrameData(keyRing, originalData.buffer)

    expect(result).not.toBeNull()
    const output = new Uint8Array(result!)

    // Must be larger than header + original data (GCM adds 16-byte auth tag)
    expect(output.byteLength).toBeGreaterThan(HEADER_LENGTH + originalData.byteLength)

    // First byte should be the epoch
    expect(output[0]).toBe(0)

    // IV is bytes 1-12 (should be non-zero random)
    const iv = output.slice(1, HEADER_LENGTH)
    expect(iv.byteLength).toBe(IV_LENGTH)
    // Extremely unlikely all 12 bytes are zero
    expect(iv.some((b) => b !== 0)).toBe(true)

    keyRing.destroy()
  })

  it('epoch byte matches keyRing.currentEpoch', async () => {
    const keyRing = new MediaKeyRing()
    const key0 = await makeTestKey()
    keyRing.setInitialKey(key0, 0)

    const key1 = await makeTestKey()
    keyRing.rotateKey(key1)
    expect(keyRing.currentEpoch).toBe(1)

    const result = await encryptFrameData(keyRing, new Uint8Array([10, 20, 30]).buffer)
    const output = new Uint8Array(result!)
    expect(output[0]).toBe(1)

    keyRing.destroy()
  })

  it('ciphertext decrypts to original data with correct key and IV', async () => {
    const keyRing = new MediaKeyRing()
    const key = await makeTestKey()
    keyRing.setInitialKey(key, 0)

    const originalData = new Uint8Array([100, 200, 42, 0, 255])
    const result = await encryptFrameData(keyRing, originalData.buffer)

    const output = new Uint8Array(result!)
    const iv = output.slice(1, HEADER_LENGTH)
    const ciphertext = output.slice(HEADER_LENGTH)

    // Decrypt manually with the same key and IV
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    )

    expect(new Uint8Array(decrypted)).toEqual(originalData)

    keyRing.destroy()
  })

  it('returns null when no key is set', async () => {
    const keyRing = new MediaKeyRing()
    // No key set — currentKey is null

    const result = await encryptFrameData(keyRing, new Uint8Array([1, 2, 3]).buffer)
    expect(result).toBeNull()

    keyRing.destroy()
  })
})

describe('Receiver decrypt (decryptFrameData)', () => {
  /** Helper: encrypt data the same way the sender would. */
  async function buildEncryptedFrame(
    key: CryptoKey,
    epoch: number,
    plaintext: Uint8Array,
  ): Promise<ArrayBuffer> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext,
    )
    const ciphertextBytes = new Uint8Array(ciphertext)
    const output = new Uint8Array(HEADER_LENGTH + ciphertextBytes.byteLength)
    output[0] = epoch
    output.set(iv, 1)
    output.set(ciphertextBytes, HEADER_LENGTH)
    return output.buffer
  }

  it('decrypts frame correctly with known key', async () => {
    const keyRing = new MediaKeyRing()
    const key = await makeTestKey()
    keyRing.setInitialKey(key, 0)

    const originalData = new Uint8Array([10, 20, 30, 40, 50])
    const encryptedBuffer = await buildEncryptedFrame(key, 0, originalData)

    const result = await decryptFrameData(keyRing, encryptedBuffer)
    expect(result).not.toBeNull()
    expect(new Uint8Array(result!)).toEqual(originalData)

    keyRing.destroy()
  })

  it('returns null when epoch is unknown (frame dropped)', async () => {
    const keyRing = new MediaKeyRing()
    const key = await makeTestKey()
    keyRing.setInitialKey(key, 0)

    // Encrypt with epoch 5 (not in key ring)
    const encryptedBuffer = await buildEncryptedFrame(key, 5, new Uint8Array([1, 2, 3]))
    const result = await decryptFrameData(keyRing, encryptedBuffer)
    expect(result).toBeNull()

    keyRing.destroy()
  })

  it('returns null when ciphertext is corrupted', async () => {
    const keyRing = new MediaKeyRing()
    const key = await makeTestKey()
    keyRing.setInitialKey(key, 0)

    // Build a valid-looking frame but with garbage ciphertext
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
    const garbageCiphertext = crypto.getRandomValues(new Uint8Array(32))
    const output = new Uint8Array(HEADER_LENGTH + garbageCiphertext.byteLength)
    output[0] = 0
    output.set(iv, 1)
    output.set(garbageCiphertext, HEADER_LENGTH)

    const result = await decryptFrameData(keyRing, output.buffer)
    expect(result).toBeNull()

    keyRing.destroy()
  })

  it('returns null when data is too small for header', async () => {
    const keyRing = new MediaKeyRing()
    const key = await makeTestKey()
    keyRing.setInitialKey(key, 0)

    // Only 5 bytes — less than HEADER_LENGTH (13)
    const result = await decryptFrameData(keyRing, new Uint8Array(5).buffer)
    expect(result).toBeNull()

    keyRing.destroy()
  })
})

// ============================================================
// End-to-End: Sender → Receiver with Key Rotation
// ============================================================

describe('Sender → Receiver roundtrip', () => {
  it('encrypt then decrypt with same key yields original data', async () => {
    const keyRing = new MediaKeyRing()
    const key = await makeTestKey()
    keyRing.setInitialKey(key, 0)

    const originalData = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    const encrypted = await encryptFrameData(keyRing, originalData.buffer)
    expect(encrypted).not.toBeNull()

    const decrypted = await decryptFrameData(keyRing, encrypted!)
    expect(decrypted).not.toBeNull()
    expect(new Uint8Array(decrypted!)).toEqual(originalData)

    keyRing.destroy()
  })

  it('old-epoch frames decrypt within 5-second window after rotation', async () => {
    vi.useFakeTimers()

    const keyRing = new MediaKeyRing()
    const key0 = await makeTestKey()
    keyRing.setInitialKey(key0, 0)

    // Encrypt a frame with epoch 0
    const originalData = new Uint8Array([42, 43, 44])
    const encryptedFrame = await encryptFrameData(keyRing, originalData.buffer)
    expect(encryptedFrame).not.toBeNull()

    // Verify epoch byte is 0
    expect(new Uint8Array(encryptedFrame!)[0]).toBe(0)

    // Rotate to new key
    const key1 = await makeTestKey()
    keyRing.rotateKey(key1)
    expect(keyRing.currentEpoch).toBe(1)

    // The old-epoch frame should still decrypt (within 5s window)
    const decrypted = await decryptFrameData(keyRing, encryptedFrame!)
    expect(decrypted).not.toBeNull()
    expect(new Uint8Array(decrypted!)).toEqual(originalData)

    vi.useRealTimers()
    keyRing.destroy()
  })

  it('old-epoch frames are dropped after 5-second retention window', async () => {
    vi.useFakeTimers()

    const keyRing = new MediaKeyRing()
    const key0 = await makeTestKey()
    keyRing.setInitialKey(key0, 0)

    // Encrypt a frame with epoch 0
    const originalData = new Uint8Array([42, 43, 44])
    const encryptedFrame = await encryptFrameData(keyRing, originalData.buffer)
    expect(encryptedFrame).not.toBeNull()

    // Rotate to new key
    const key1 = await makeTestKey()
    keyRing.rotateKey(key1)

    // Wait past retention window
    vi.advanceTimersByTime(KEY_RETENTION_MS + 100)

    // The old-epoch frame should now be dropped
    const result = await decryptFrameData(keyRing, encryptedFrame!)
    expect(result).toBeNull()

    vi.useRealTimers()
    keyRing.destroy()
  })

  it('new frames use new epoch after rotation', async () => {
    const keyRing = new MediaKeyRing()
    const key0 = await makeTestKey()
    keyRing.setInitialKey(key0, 0)

    // Rotate
    const key1 = await makeTestKey()
    keyRing.rotateKey(key1)

    // Encrypt with new epoch
    const result = await encryptFrameData(keyRing, new Uint8Array([1, 2, 3]).buffer)
    expect(result).not.toBeNull()
    expect(new Uint8Array(result!)[0]).toBe(1) // epoch should be 1

    keyRing.destroy()
  })
})

// ============================================================
// Key Generation and Export/Import
// ============================================================

describe('Key generation and serialization', () => {
  it('generateMediaKey creates a 256-bit AES-GCM key', async () => {
    const key = await generateMediaKey()
    expect(key.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect(key.extractable).toBe(true)
    expect(key.usages).toContain('encrypt')
    expect(key.usages).toContain('decrypt')
  })

  it('exportMediaKey returns 32 bytes', async () => {
    const key = await generateMediaKey()
    const raw = await exportMediaKey(key)
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(raw.byteLength).toBe(32)
  })

  it('importMediaKey creates a non-extractable key', async () => {
    const key = await generateMediaKey()
    const raw = await exportMediaKey(key)
    const imported = await importMediaKey(raw)

    expect(imported.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect(imported.extractable).toBe(false)
    expect(imported.usages).toContain('encrypt')
    expect(imported.usages).toContain('decrypt')
  })

  it('roundtrip: export → import → encrypt/decrypt works', async () => {
    const originalKey = await generateMediaKey()
    const raw = await exportMediaKey(originalKey)
    const importedKey = await importMediaKey(raw)

    const plaintext = new Uint8Array([1, 2, 3, 4, 5])
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      originalKey,
      plaintext,
    )

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      importedKey,
      ciphertext,
    )

    expect(new Uint8Array(decrypted)).toEqual(plaintext)
  })
})

// ============================================================
// Key Distribution Scenarios
// ============================================================

describe('Key distribution', () => {
  it('media_key message format is correct', async () => {
    const key = await generateMediaKey()
    const raw = await exportMediaKey(key)

    const mediaKeyMessage = {
      type: 'media_key' as const,
      room_id: 'room-123',
      key: raw,
      epoch: 0,
    }

    expect(mediaKeyMessage.type).toBe('media_key')
    expect(mediaKeyMessage.room_id).toBe('room-123')
    expect(mediaKeyMessage.key.byteLength).toBe(32)
    expect(mediaKeyMessage.epoch).toBe(0)
  })

  it('received media key can be imported and used to decrypt frames', async () => {
    // Simulate: sender generates key, exports, "sends" to receiver
    const senderKeyRing = new MediaKeyRing()
    const senderKey = await generateMediaKey()
    senderKeyRing.setInitialKey(senderKey, 0)

    // Sender encrypts a frame
    const originalData = new Uint8Array([11, 22, 33])
    const encrypted = await encryptFrameData(senderKeyRing, originalData.buffer)
    expect(encrypted).not.toBeNull()

    // "Distribute" key: export → transmit → import
    const rawKey = await exportMediaKey(senderKey)
    const receiverKey = await importMediaKey(rawKey)

    // Receiver sets up key ring with imported key
    const receiverKeyRing = new MediaKeyRing()
    receiverKeyRing.setInitialKey(receiverKey, 0)

    // Receiver decrypts the frame
    const decrypted = await decryptFrameData(receiverKeyRing, encrypted!)
    expect(decrypted).not.toBeNull()
    expect(new Uint8Array(decrypted!)).toEqual(originalData)

    senderKeyRing.destroy()
    receiverKeyRing.destroy()
  })

  it('key rotation: all participants transition to new epoch', async () => {
    vi.useFakeTimers()

    // Set up two key rings (simulating two participants)
    const keyRingA = new MediaKeyRing()
    const keyRingB = new MediaKeyRing()

    // Initial key
    const key0 = await generateMediaKey()
    const raw0 = await exportMediaKey(key0)
    const key0B = await importMediaKey(raw0)

    keyRingA.setInitialKey(key0, 0)
    keyRingB.setInitialKey(key0B, 0)

    // Rotate: participant A generates new key, distributes to B
    const key1 = await generateMediaKey()
    const raw1 = await exportMediaKey(key1)
    const key1B = await importMediaKey(raw1)

    keyRingA.rotateKey(key1)
    keyRingB.rotateKey(key1B)

    expect(keyRingA.currentEpoch).toBe(1)
    expect(keyRingB.currentEpoch).toBe(1)

    // A encrypts with new epoch
    const encrypted = await encryptFrameData(keyRingA, new Uint8Array([77, 88, 99]).buffer)
    expect(encrypted).not.toBeNull()
    expect(new Uint8Array(encrypted!)[0]).toBe(1) // epoch 1

    // B decrypts successfully
    const decrypted = await decryptFrameData(keyRingB, encrypted!)
    expect(decrypted).not.toBeNull()
    expect(new Uint8Array(decrypted!)).toEqual(new Uint8Array([77, 88, 99]))

    vi.useRealTimers()
    keyRingA.destroy()
    keyRingB.destroy()
  })

  it('participant leave: leaver cannot decrypt after re-key', async () => {
    const keyRingA = new MediaKeyRing() // stays
    const keyRingLeaver = new MediaKeyRing() // leaves

    // Shared initial key
    const key0 = await generateMediaKey()
    const raw0 = await exportMediaKey(key0)
    keyRingA.setInitialKey(key0, 0)
    keyRingLeaver.setInitialKey(await importMediaKey(raw0), 0)

    // Re-key: new key distributed to A but NOT to leaver
    const key1 = await generateMediaKey()
    keyRingA.rotateKey(key1)
    // keyRingLeaver does NOT receive key1

    // A encrypts with new epoch 1
    const encrypted = await encryptFrameData(keyRingA, new Uint8Array([1, 2, 3]).buffer)
    expect(encrypted).not.toBeNull()

    // Leaver tries to decrypt — should fail (epoch 1 unknown)
    const result = await decryptFrameData(keyRingLeaver, encrypted!)
    expect(result).toBeNull()

    keyRingA.destroy()
    keyRingLeaver.destroy()
  })
})
