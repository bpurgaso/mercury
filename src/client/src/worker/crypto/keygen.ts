// Key generation functions for Mercury's E2E encryption.
// See client-spec.md §4.2 for the registration flow.

import {
  ensureSodium,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  sign,
} from './utils'
import type { SigningKeyPair, KeyPair, SignedPreKey, PreKey } from './types'

/**
 * Generate the Master Verify Key (Ed25519 signing keypair).
 * This is the root of user identity — signs device lists.
 */
export async function generateMasterVerifyKeyPair(): Promise<SigningKeyPair> {
  await ensureSodium()
  return generateEd25519KeyPair()
}

/**
 * Generate a Device Identity Key (X25519 key agreement keypair).
 * Used for X3DH key exchange.
 */
export async function generateDeviceIdentityKeyPair(): Promise<KeyPair> {
  await ensureSodium()
  return generateX25519KeyPair()
}

/**
 * Generate a Signed Pre-Key: an X25519 keypair whose public key
 * is signed with the provided Ed25519 identity key.
 *
 * @param identityKey - Ed25519 signing keypair used to sign the pre-key's public key
 * @param keyId - Optional key ID (defaults to 1)
 */
export async function generateSignedPreKey(
  identityKey: SigningKeyPair,
  keyId: number = 1,
): Promise<SignedPreKey> {
  await ensureSodium()
  const keyPair = generateX25519KeyPair()
  const signature = sign(keyPair.publicKey, identityKey.privateKey)

  return {
    keyId,
    keyPair,
    signature,
    timestamp: Date.now(),
  }
}

/**
 * Generate a batch of One-Time Pre-Keys (X25519 keypairs with sequential IDs).
 *
 * @param startId - First key ID in the batch (default 0)
 * @param count - Number of keys to generate (default 100)
 */
export async function generateOneTimePreKeys(
  startId: number = 0,
  count: number = 100,
): Promise<PreKey[]> {
  await ensureSodium()
  const prekeys: PreKey[] = []
  for (let i = 0; i < count; i++) {
    prekeys.push({
      keyId: startId + i,
      keyPair: generateX25519KeyPair(),
    })
  }
  return prekeys
}
