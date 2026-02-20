// Blob-level encryption for SQLite field values.
// Uses XSalsa20-Poly1305 (crypto_secretbox) to encrypt/decrypt individual
// values before storing them in better-sqlite3 databases.
// This provides at-rest encryption without requiring SQLCipher.

import sodium from 'libsodium-wrappers'

/**
 * Encrypt a plaintext blob using XSalsa20-Poly1305.
 * Returns nonce (24 bytes) || ciphertext (plaintext.length + 16 bytes MAC).
 */
export function encryptBlob(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key)
  const result = new Uint8Array(nonce.length + ciphertext.length)
  result.set(nonce, 0)
  result.set(ciphertext, nonce.length)
  return result
}

/**
 * Decrypt a blob produced by encryptBlob().
 * Throws if the key is wrong or data is tampered (authentication failure).
 */
export function decryptBlob(encrypted: Uint8Array, key: Uint8Array): Uint8Array {
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES
  if (encrypted.length < nonceLen + sodium.crypto_secretbox_MACBYTES) {
    throw new Error('Encrypted blob too short')
  }
  const nonce = encrypted.slice(0, nonceLen)
  const ciphertext = encrypted.slice(nonceLen)
  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key)
}

/** Encrypt a UTF-8 string, returning the encrypted blob. */
export function encryptString(plaintext: string, key: Uint8Array): Uint8Array {
  return encryptBlob(sodium.from_string(plaintext), key)
}

/** Decrypt a blob back to a UTF-8 string. */
export function decryptString(encrypted: Uint8Array, key: Uint8Array): string {
  return sodium.to_string(decryptBlob(encrypted, key))
}
