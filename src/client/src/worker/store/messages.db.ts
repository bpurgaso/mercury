// Encrypted local message store backed by SQLCipher (better-sqlite3-multiple-ciphers).
// The entire database is encrypted with a 256-bit key via PRAGMA key.
// Stores decrypted E2E message plaintext locally — forward secrecy means
// messages cannot be re-decrypted from the server after ratchet advances.

import Database from 'better-sqlite3-multiple-ciphers'
import sodium from 'libsodium-wrappers'
import type { IMessageStore, StoredMessage } from '../crypto/types'

export class MessageStore implements IMessageStore {
  private db: Database.Database

  constructor(dbPath: string, encryptionKey: Uint8Array) {
    if (encryptionKey.length !== 32) {
      throw new Error(
        `Encryption key must be 32 bytes, got ${encryptionKey.length}`,
      )
    }
    const hexKey = Buffer.from(encryptionKey).toString('hex')
    this.db = new Database(dbPath)
    this.db.pragma(`key="x'${hexKey}'"`)
    sodium.memzero(encryptionKey)
    this.db.pragma('journal_mode = WAL')
    this.createTables()
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_created
        ON messages(channel_id, created_at);
    `)
  }

  insertMessage(message: StoredMessage): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, channel_id, sender_id, content, created_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.channelId,
        message.senderId,
        message.content,
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
      content: string
      created_at: number
      received_at: number
    }>

    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      content: row.content,
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
          content: string
          created_at: number
          received_at: number
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      content: row.content,
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
  }
}
