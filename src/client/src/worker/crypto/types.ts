// Type definitions for Mercury's E2E encryption key hierarchy.
// See client-spec.md §4.1 for the full key hierarchy.

/** X25519 key agreement keypair (Curve25519 Montgomery form) */
export interface KeyPair {
  publicKey: Uint8Array // 32 bytes (crypto_box_PUBLICKEYBYTES)
  privateKey: Uint8Array // 32 bytes (crypto_box_SECRETKEYBYTES)
}

/** Ed25519 signing keypair (Curve25519 twisted Edwards form) */
export interface SigningKeyPair {
  publicKey: Uint8Array // 32 bytes (crypto_sign_PUBLICKEYBYTES)
  privateKey: Uint8Array // 64 bytes (crypto_sign_SECRETKEYBYTES)
}

/** Signed pre-key: X25519 keypair signed by an Ed25519 key */
export interface SignedPreKey {
  keyId: number
  keyPair: KeyPair
  signature: Uint8Array // Ed25519 detached signature over keyPair.publicKey
  timestamp: number // Unix ms when created
}

/** One-time pre-key: X25519 keypair with sequential ID */
export interface PreKey {
  keyId: number
  keyPair: KeyPair
}

/** Serialized Double Ratchet session state (Phase 6c) */
export interface SessionState {
  data: Uint8Array
}

/** Serialized Sender Key for group channels (Phase 6d) */
export interface SenderKey {
  data: Uint8Array
}

/** Decrypted message stored in the local encrypted database */
export interface StoredMessage {
  id: string
  channelId: string
  senderId: string
  content: string
  createdAt: number // Unix ms (server timestamp)
  receivedAt: number // Unix ms (local receipt time)
}

/** KeyStore interface — client-spec.md §4.3 */
export interface IKeyStore {
  // Master identity (Ed25519)
  getMasterVerifyKeyPair(): SigningKeyPair
  storeMasterVerifyKeyPair(keyPair: SigningKeyPair): void

  // Device identity (X25519)
  getDeviceId(): string
  getDeviceIdentityKeyPair(): KeyPair
  storeDeviceIdentityKeyPair(deviceId: string, keyPair: KeyPair): void

  // Pre-keys
  getSignedPreKey(): SignedPreKey
  storeSignedPreKey(spk: SignedPreKey): void
  getOneTimePreKey(keyId: number): PreKey | null
  storeOneTimePreKeys(prekeys: PreKey[]): void
  markOneTimePreKeyUsed(keyId: number): void
  getUnusedOneTimePreKeyCount(): number
  getNextPreKeyId(): number

  // Sessions — keyed by (userId, deviceId) pair
  getSession(userId: string, deviceId: string): SessionState | null
  storeSession(userId: string, deviceId: string, state: SessionState): void
  getAllSessionsForUser(userId: string): Map<string, SessionState>

  // Sender keys (group channels <= 100 members)
  getSenderKey(channelId: string, userId: string, deviceId: string): SenderKey | null
  storeSenderKey(channelId: string, userId: string, deviceId: string, key: SenderKey): void

  // Media keys
  getMediaKey(roomId: string): Uint8Array | null
  storeMediaKey(roomId: string, key: Uint8Array): void

  close(): void
}

/** MessageStore interface for local E2E message persistence */
export interface IMessageStore {
  insertMessage(message: StoredMessage): void
  getMessagesByChannel(channelId: string, limit?: number, offset?: number): StoredMessage[]
  getMessage(id: string): StoredMessage | null
  getMessageCount(channelId: string): number
  close(): void
}
