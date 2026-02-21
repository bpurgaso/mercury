// Safety number generation for identity verification.
// See client-spec.md §4.1 for the trust model.

import { createHash } from 'crypto'

/**
 * Generate a deterministic safety number from two Ed25519 Master Verify Key
 * public keys. The MVK is the user's long-term identity key that persists
 * across device changes and recovery, so safety numbers remain stable even
 * when a user switches devices.
 *
 * Algorithm:
 * 1. Sort the two 32-byte public keys lexicographically
 * 2. Hash with two rounds of SHA-256 (different domain separators) to get 64 bytes
 * 3. Take first 60 bytes → 12 groups of 5 bytes → each mod 100000 → 5-digit group
 *
 * Both parties computing the safety number for the same pair get the identical result.
 */
export function generateSafetyNumber(
  ourMasterVerifyKey: Uint8Array,
  theirMasterVerifyKey: Uint8Array,
): string {
  if (ourMasterVerifyKey.length !== 32 || theirMasterVerifyKey.length !== 32) {
    throw new Error('Master verify keys must be 32 bytes (Ed25519 public keys)')
  }

  // Sort lexicographically so both parties produce the same order
  const cmp = compareBytes(ourMasterVerifyKey, theirMasterVerifyKey)
  const first = cmp <= 0 ? ourMasterVerifyKey : theirMasterVerifyKey
  const second = cmp <= 0 ? theirMasterVerifyKey : ourMasterVerifyKey

  // Concatenate sorted keys
  const combined = new Uint8Array(64)
  combined.set(first, 0)
  combined.set(second, 32)

  // Two rounds of SHA-256 with domain separators to get 64 bytes
  const hash1 = createHash('sha256')
    .update(Buffer.from([0x01])) // domain separator: round 1
    .update(combined)
    .digest()
  const hash2 = createHash('sha256')
    .update(Buffer.from([0x02])) // domain separator: round 2
    .update(combined)
    .digest()

  // Concatenate: 64 bytes total, use first 60
  const hashBytes = Buffer.concat([hash1, hash2])

  // 12 groups of 5 bytes → each interpreted as big-endian mod 100000
  const groups: string[] = []
  for (let i = 0; i < 12; i++) {
    const offset = i * 5
    // Read 5 bytes as big-endian number using BigInt to avoid overflow
    let value = 0n
    for (let j = 0; j < 5; j++) {
      value = (value << 8n) | BigInt(hashBytes[offset + j])
    }
    const group = Number(value % 100000n)
    groups.push(group.toString().padStart(5, '0'))
  }

  return groups.join(' ')
}

/** Compare two Uint8Arrays lexicographically. Returns <0, 0, or >0. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}
