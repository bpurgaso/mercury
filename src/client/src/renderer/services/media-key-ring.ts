/**
 * MediaKeyRing — manages AES-256-GCM keys for media frame E2E encryption.
 *
 * Holds the current key + epoch and retains previous keys for 5 seconds
 * after rotation to handle late-arriving UDP packets.
 *
 * See client-spec.md §4.7 and server-spec.md §6.8.
 */

const KEY_RETENTION_MS = 5_000

export class MediaKeyRing {
  private keys = new Map<number, { key: CryptoKey; expiresAt: number }>()
  private cleanupTimers = new Map<number, ReturnType<typeof setTimeout>>()

  currentEpoch = 0
  currentKey: CryptoKey | null = null

  /**
   * Set the initial key at call start (epoch 0). Does not increment epoch.
   */
  setInitialKey(key: CryptoKey, epoch = 0): void {
    this.currentEpoch = epoch
    this.currentKey = key
    this.keys.set(epoch, { key, expiresAt: Infinity })
  }

  /**
   * Rotate to a new key. Increments currentEpoch (wraps at 255 → 0),
   * retains the old key for 5 seconds, then deletes it.
   */
  rotateKey(newKey: CryptoKey): void {
    const oldEpoch = this.currentEpoch
    this.currentEpoch = (this.currentEpoch + 1) % 256
    this.currentKey = newKey

    // Store new key
    this.keys.set(this.currentEpoch, { key: newKey, expiresAt: Infinity })

    // Expire old key after retention window
    const oldEntry = this.keys.get(oldEpoch)
    if (oldEntry) {
      oldEntry.expiresAt = Date.now() + KEY_RETENTION_MS

      // Clear any existing timer for this epoch (rapid rotation)
      const existingTimer = this.cleanupTimers.get(oldEpoch)
      if (existingTimer) clearTimeout(existingTimer)

      const timer = setTimeout(() => {
        this.keys.delete(oldEpoch)
        this.cleanupTimers.delete(oldEpoch)
      }, KEY_RETENTION_MS)
      this.cleanupTimers.set(oldEpoch, timer)
    }
  }

  /**
   * Look up the key for a given epoch. Returns null if the epoch is
   * unknown or the key has expired.
   */
  getKeyForEpoch(epoch: number): CryptoKey | null {
    const entry = this.keys.get(epoch)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      // Expired — clean up eagerly
      this.keys.delete(epoch)
      return null
    }
    return entry.key
  }

  /**
   * Clear all keys and cancel pending cleanup timers.
   */
  destroy(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer)
    }
    this.cleanupTimers.clear()
    this.keys.clear()
    this.currentKey = null
    this.currentEpoch = 0
  }
}

export { KEY_RETENTION_MS }
