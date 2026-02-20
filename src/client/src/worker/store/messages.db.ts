// Encrypted local message store backed by better-sqlite3.
// Stores decrypted E2E message plaintext locally — forward secrecy means
// messages cannot be re-decrypted from the server after ratchet advances.
// Content is encrypted at the field level using XSalsa20-Poly1305.

import Database from 'better-sqlite3'
import sodium from 'libsodium-wrappers'
import { encryptString, decryptString } from './encryption'
import type { IMessageStore, StoredMessage } from '../crypto/types'

export class MessageStore implements IMessageStore {
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
    this.createTables()
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_created
        ON messages(channel_id, created_at);
    `)
  }

  insertMessage(message: StoredMessage): void {
    const encContent = encryptString(message.content, this.key)
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, channel_id, sender_id, content, created_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.channelId,
        message.senderId,
        Buffer.from(encContent),
        message.createdAt,
        message.receivedAt,
      )
  }

  getMessagesByChannel(
    channelId: string,
    limit: number = 50,
    offset: number = 0,
  ): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, channel_id, sender_id, content, created_at, received_at
         FROM messages
         WHERE channel_id = ?
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`,
      )
      .all(channelId, limit, offset) as Array<{
      id: string
      channel_id: string
      sender_id: string
      content: Buffer
      created_at: number
      received_at: number
    }>

    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      content: decryptString(new Uint8Array(row.content), this.key),
      createdAt: row.created_at,
      receivedAt: row.received_at,
    }))
  }

  getMessage(id: string): StoredMessage | null {
    const row = this.db
      .prepare(
        `SELECT id, channel_id, sender_id, content, created_at, received_at
         FROM messages WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string
          channel_id: string
          sender_id: string
          content: Buffer
          created_at: number
          received_at: number
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      content: decryptString(new Uint8Array(row.content), this.key),
      createdAt: row.created_at,
      receivedAt: row.received_at,
    }
  }

  getMessageCount(channelId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM messages WHERE channel_id = ?')
      .get(channelId) as { count: number }
    return row.count
  }

  close(): void {
    this.db.close()
    sodium.memzero(this.key)
  }
}
