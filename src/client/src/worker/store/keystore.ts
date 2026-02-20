// Encrypted local key store backed by better-sqlite3.
// Private key material is encrypted at the field level using XSalsa20-Poly1305
// before being written to SQLite. Public keys are stored in plaintext.
// See client-spec.md §4.3 for the interface contract.

import Database from 'better-sqlite3'
import sodium from 'libsodium-wrappers'
import { encryptBlob, decryptBlob } from './encryption'
import type {
  IKeyStore,
  KeyPair,
  SigningKeyPair,
  SignedPreKey,
  PreKey,
  SessionState,
  SenderKey,
} from '../crypto/types'

export class KeyStore implements IKeyStore {
  private db: Database.Database
  private key: Uint8Array

  constructor(dbPath: string, encryptionKey: Uint8Array) {
    if (encryptionKey.length !== sodium.crypto_secretbox_KEYBYTES) {
      throw new Error(
        `Encryption key must be ${sodium.crypto_secretbox_KEYBYTES} bytes, got ${encryptionKey.length}`,
      )
    }
    this.key = encryptionKey
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.createTables()
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS master_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_key BLOB NOT NULL,
        private_key BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS device_keys (
        device_id TEXT PRIMARY KEY,
        public_key BLOB NOT NULL,
        private_key BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signed_prekeys (
        key_id INTEGER PRIMARY KEY,
        public_key BLOB NOT NULL,
        private_key BLOB NOT NULL,
        signature BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS one_time_prekeys (
        key_id INTEGER PRIMARY KEY,
        public_key BLOB NOT NULL,
        private_key BLOB NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS sender_keys (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        key_data BLOB NOT NULL,
        PRIMARY KEY (channel_id, user_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS media_keys (
        room_id TEXT PRIMARY KEY,
        key_data BLOB NOT NULL
      );
    `)
  }

  // --- Master identity (Ed25519) ---

  getMasterVerifyKeyPair(): SigningKeyPair {
    const row = this.db
      .prepare('SELECT public_key, private_key FROM master_keys WHERE id = 1')
      .get() as { public_key: Buffer; private_key: Buffer } | undefined
    if (!row) throw new Error('Master verify key not found')
    return {
      publicKey: new Uint8Array(row.public_key),
      privateKey: decryptBlob(new Uint8Array(row.private_key), this.key),
    }
  }

  storeMasterVerifyKeyPair(keyPair: SigningKeyPair): void {
    const encPrivate = encryptBlob(keyPair.privateKey, this.key)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO master_keys (id, public_key, private_key, created_at)
         VALUES (1, ?, ?, ?)`,
      )
      .run(Buffer.from(keyPair.publicKey), Buffer.from(encPrivate), Date.now())
  }

  // --- Device identity (X25519) ---

  getDeviceId(): string {
    const row = this.db
      .prepare('SELECT device_id FROM device_keys LIMIT 1')
      .get() as { device_id: string } | undefined
    if (!row) throw new Error('Device identity key not found')
    return row.device_id
  }

  getDeviceIdentityKeyPair(): KeyPair {
    const row = this.db
      .prepare('SELECT public_key, private_key FROM device_keys LIMIT 1')
      .get() as { public_key: Buffer; private_key: Buffer } | undefined
    if (!row) throw new Error('Device identity key not found')
    return {
      publicKey: new Uint8Array(row.public_key),
      privateKey: decryptBlob(new Uint8Array(row.private_key), this.key),
    }
  }

  storeDeviceIdentityKeyPair(deviceId: string, keyPair: KeyPair): void {
    const encPrivate = encryptBlob(keyPair.privateKey, this.key)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO device_keys (device_id, public_key, private_key, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(deviceId, Buffer.from(keyPair.publicKey), Buffer.from(encPrivate), Date.now())
  }

  // --- Signed pre-keys ---

  getSignedPreKey(): SignedPreKey {
    const row = this.db
      .prepare(
        'SELECT key_id, public_key, private_key, signature, created_at FROM signed_prekeys ORDER BY key_id DESC LIMIT 1',
      )
      .get() as
      | {
          key_id: number
          public_key: Buffer
          private_key: Buffer
          signature: Buffer
          created_at: number
        }
      | undefined
    if (!row) throw new Error('Signed pre-key not found')
    return {
      keyId: row.key_id,
      keyPair: {
        publicKey: new Uint8Array(row.public_key),
        privateKey: decryptBlob(new Uint8Array(row.private_key), this.key),
      },
      signature: new Uint8Array(row.signature),
      timestamp: row.created_at,
    }
  }

  storeSignedPreKey(spk: SignedPreKey): void {
    const encPrivate = encryptBlob(spk.keyPair.privateKey, this.key)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO signed_prekeys (key_id, public_key, private_key, signature, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        spk.keyId,
        Buffer.from(spk.keyPair.publicKey),
        Buffer.from(encPrivate),
        Buffer.from(spk.signature),
        spk.timestamp,
      )
  }

  // --- One-time pre-keys ---

  getOneTimePreKey(keyId: number): PreKey | null {
    const row = this.db
      .prepare('SELECT key_id, public_key, private_key FROM one_time_prekeys WHERE key_id = ? AND used = 0')
      .get(keyId) as { key_id: number; public_key: Buffer; private_key: Buffer } | undefined
    if (!row) return null
    return {
      keyId: row.key_id,
      keyPair: {
        publicKey: new Uint8Array(row.public_key),
        privateKey: decryptBlob(new Uint8Array(row.private_key), this.key),
      },
    }
  }

  storeOneTimePreKeys(prekeys: PreKey[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO one_time_prekeys (key_id, public_key, private_key, used)
       VALUES (?, ?, ?, 0)`,
    )
    const tx = this.db.transaction(() => {
      for (const pk of prekeys) {
        const encPrivate = encryptBlob(pk.keyPair.privateKey, this.key)
        insert.run(pk.keyId, Buffer.from(pk.keyPair.publicKey), Buffer.from(encPrivate))
      }
    })
    tx()
  }

  markOneTimePreKeyUsed(keyId: number): void {
    this.db.prepare('UPDATE one_time_prekeys SET used = 1 WHERE key_id = ?').run(keyId)
  }

  getUnusedOneTimePreKeyCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM one_time_prekeys WHERE used = 0')
      .get() as { count: number }
    return row.count
  }

  getNextPreKeyId(): number {
    const row = this.db
      .prepare('SELECT MAX(key_id) as max_id FROM one_time_prekeys')
      .get() as { max_id: number | null }
    return row.max_id !== null ? row.max_id + 1 : 0
  }

  // --- Sessions ---

  getSession(userId: string, deviceId: string): SessionState | null {
    const row = this.db
      .prepare('SELECT state FROM sessions WHERE user_id = ? AND device_id = ?')
      .get(userId, deviceId) as { state: Buffer } | undefined
    if (!row) return null
    return { data: decryptBlob(new Uint8Array(row.state), this.key) }
  }

  storeSession(userId: string, deviceId: string, state: SessionState): void {
    const encState = encryptBlob(state.data, this.key)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (user_id, device_id, state, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, deviceId, Buffer.from(encState), Date.now())
  }

  getAllSessionsForUser(userId: string): Map<string, SessionState> {
    const rows = this.db
      .prepare('SELECT device_id, state FROM sessions WHERE user_id = ?')
      .all(userId) as Array<{ device_id: string; state: Buffer }>
    const result = new Map<string, SessionState>()
    for (const row of rows) {
      result.set(row.device_id, {
        data: decryptBlob(new Uint8Array(row.state), this.key),
      })
    }
    return result
  }

  // --- Sender keys ---

  getSenderKey(channelId: string, userId: string, deviceId: string): SenderKey | null {
    const row = this.db
      .prepare(
        'SELECT key_data FROM sender_keys WHERE channel_id = ? AND user_id = ? AND device_id = ?',
      )
      .get(channelId, userId, deviceId) as { key_data: Buffer } | undefined
    if (!row) return null
    return { data: decryptBlob(new Uint8Array(row.key_data), this.key) }
  }

  storeSenderKey(
    channelId: string,
    userId: string,
    deviceId: string,
    key: SenderKey,
  ): void {
    const encKey = encryptBlob(key.data, this.key)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sender_keys (channel_id, user_id, device_id, key_data)
         VALUES (?, ?, ?, ?)`,
      )
      .run(channelId, userId, deviceId, Buffer.from(encKey))
  }

  // --- Media keys ---

  getMediaKey(roomId: string): Uint8Array | null {
    const row = this.db
      .prepare('SELECT key_data FROM media_keys WHERE room_id = ?')
      .get(roomId) as { key_data: Buffer } | undefined
    if (!row) return null
    return decryptBlob(new Uint8Array(row.key_data), this.key)
  }

  storeMediaKey(roomId: string, key: Uint8Array): void {
    const encKey = encryptBlob(key, this.key)
    this.db
      .prepare('INSERT OR REPLACE INTO media_keys (room_id, key_data) VALUES (?, ?)')
      .run(roomId, Buffer.from(encKey))
  }

  close(): void {
    this.db.close()
    sodium.memzero(this.key)
  }
}
