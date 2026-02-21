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

/** Key bundle fetched from server for X3DH key exchange */
export interface KeyBundle {
  identityKey: Uint8Array // Ed25519 public key (32 bytes) — used for SPK signature verification, converted to X25519 for DH
  signedPreKey: {
    keyId: number
    publicKey: Uint8Array // X25519 public key (32 bytes)
    signature: Uint8Array // Ed25519 detached signature over publicKey (64 bytes)
  }
  oneTimePreKey?: {
    keyId: number
    publicKey: Uint8Array // X25519 public key (32 bytes)
  }
}

/** Result of X3DH key exchange (initiator side) */
export interface X3DHResult {
  sharedSecret: Uint8Array // 32 bytes derived via HKDF
  ephemeralPublicKey: Uint8Array // X25519 ephemeral public key sent to responder
  usedPreKeyId?: number // ID of consumed one-time pre-key, if used
}

/** Serialized Double Ratchet session state (Phase 6c) */
export interface SessionState {
  data: Uint8Array
}

/** Serialized Sender Key for group channels (Phase 6d) */
export interface SenderKey {
  data: Uint8Array
}

// --- Phase 6e: Device Management, Identity & Recovery ---

/** Entry in a signed device list */
export interface DeviceListEntry {
  device_id: string
  identity_key: string // base64-encoded Ed25519 public key
}

/** Payload inside a signed device list */
export interface DeviceListPayload {
  devices: DeviceListEntry[]
  timestamp: number // Unix ms
}

/** Signed device list: JSON payload + Ed25519 signature */
export interface SignedDeviceList {
  signed_list: Uint8Array // UTF-8 encoded JSON of DeviceListPayload
  signature: Uint8Array // Ed25519 detached signature over signed_list
}

/** Result of TOFU identity verification */
export type TofuResult =
  | { trusted: true; firstSeen: true }
  | { trusted: true; firstSeen: false }
  | { trusted: false; previousKey: Uint8Array; newKey: Uint8Array }

/**
 * Contents of an encrypted key backup blob (Phase 6e).
 *
 * NOTE: Device identity keys, signed pre-keys, and one-time pre-keys are
 * intentionally excluded. The recovery spec requires a recovering device to
 * generate fresh device-level keys and register as a new device. Only the
 * master identity and conversation state are preserved.
 */
export interface BackupContents {
  version: 2
  master_verify_key: {
    public_key: Uint8Array
    private_key: Uint8Array
  }
  sessions: Array<{
    user_id: string
    device_id: string
    state: Uint8Array
  }>
  sender_keys: Array<{
    channel_id: string
    user_id: string
    device_id: string
    key_data: Uint8Array
  }>
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

  // Device identity (Ed25519, converted to X25519 for X3DH)
  getDeviceId(): string
  getDeviceIdentityKeyPair(): SigningKeyPair
  storeDeviceIdentityKeyPair(deviceId: string, keyPair: SigningKeyPair): void

  // Pre-keys
  getSignedPreKey(): SignedPreKey
  storeSignedPreKey(spk: SignedPreKey): void
  getOneTimePreKey(keyId: number): PreKey | null
  storeOneTimePreKeys(prekeys: PreKey[]): void
  markOneTimePreKeyUsed(keyId: number): void
  getUnusedOneTimePreKeyCount(): number
  getUnusedOneTimePreKeys(): PreKey[]
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

  // All sessions/sender keys (for backup export)
  getAllSessions(): Array<{ userId: string; deviceId: string; state: SessionState }>
  getAllSenderKeys(): Array<{
    channelId: string
    userId: string
    deviceId: string
    key: SenderKey
  }>

  // Trusted identities (TOFU — Phase 6e)
  storeTrustedIdentity(userId: string, masterVerifyKey: Uint8Array): void
  getTrustedIdentity(userId: string): Uint8Array | null

  // Backup (Phase 6e)
  exportBackupBlob(): Uint8Array
  importBackupBlob(blob: Uint8Array): void

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
