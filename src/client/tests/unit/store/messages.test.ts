import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ensureSodium, randomBytes } from '../../../src/worker/crypto/utils'
import { MessageStore } from '../../../src/worker/store/messages.db'

let tempDir: string
let encryptionKey: Uint8Array

beforeAll(async () => {
  await ensureSodium()
})

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mercury-msgstore-test-'))
  encryptionKey = randomBytes(32)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('MessageStore insert and query', () => {
  it('inserts a message and retrieves it by channel', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))

    const message = {
      id: 'msg-1',
      channelId: 'channel-1',
      senderId: 'user-1',
      content: 'Hello, Mercury!',
      createdAt: Date.now() - 1000,
      receivedAt: Date.now(),
    }

    store.insertMessage(message)

    const messages = store.getMessagesByChannel('channel-1')
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe('msg-1')
    expect(messages[0].channelId).toBe('channel-1')
    expect(messages[0].senderId).toBe('user-1')
    expect(messages[0].content).toBe('Hello, Mercury!')
    expect(messages[0].createdAt).toBe(message.createdAt)
    expect(messages[0].receivedAt).toBe(message.receivedAt)

    store.close()
  })

  it('retrieves a message by ID', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))

    store.insertMessage({
      id: 'msg-42',
      channelId: 'channel-1',
      senderId: 'user-1',
      content: 'specific message',
      createdAt: Date.now(),
      receivedAt: Date.now(),
    })

    const msg = store.getMessage('msg-42')
    expect(msg).not.toBeNull()
    expect(msg!.content).toBe('specific message')

    expect(store.getMessage('nonexistent')).toBeNull()

    store.close()
  })

  it('returns messages only for the requested channel', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))
    const now = Date.now()

    store.insertMessage({
      id: 'msg-a',
      channelId: 'channel-1',
      senderId: 'user-1',
      content: 'channel 1 message',
      createdAt: now,
      receivedAt: now,
    })

    store.insertMessage({
      id: 'msg-b',
      channelId: 'channel-2',
      senderId: 'user-2',
      content: 'channel 2 message',
      createdAt: now,
      receivedAt: now,
    })

    const ch1 = store.getMessagesByChannel('channel-1')
    expect(ch1.length).toBe(1)
    expect(ch1[0].content).toBe('channel 1 message')

    const ch2 = store.getMessagesByChannel('channel-2')
    expect(ch2.length).toBe(1)
    expect(ch2[0].content).toBe('channel 2 message')

    store.close()
  })

  it('orders messages by created_at ascending', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))
    const now = Date.now()

    // Insert out of order
    store.insertMessage({
      id: 'msg-3',
      channelId: 'ch',
      senderId: 'u',
      content: 'third',
      createdAt: now + 2000,
      receivedAt: now,
    })
    store.insertMessage({
      id: 'msg-1',
      channelId: 'ch',
      senderId: 'u',
      content: 'first',
      createdAt: now,
      receivedAt: now,
    })
    store.insertMessage({
      id: 'msg-2',
      channelId: 'ch',
      senderId: 'u',
      content: 'second',
      createdAt: now + 1000,
      receivedAt: now,
    })

    const messages = store.getMessagesByChannel('ch')
    expect(messages.map((m) => m.content)).toEqual(['first', 'second', 'third'])

    store.close()
  })

  it('ignores duplicate message inserts', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))
    const now = Date.now()

    const message = {
      id: 'msg-dup',
      channelId: 'ch',
      senderId: 'u',
      content: 'original',
      createdAt: now,
      receivedAt: now,
    }

    store.insertMessage(message)
    // Insert again with different content — should be ignored (INSERT OR IGNORE)
    store.insertMessage({ ...message, content: 'duplicate' })

    const msg = store.getMessage('msg-dup')
    expect(msg!.content).toBe('original')

    store.close()
  })

  it('counts messages per channel', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))
    const now = Date.now()

    for (let i = 0; i < 25; i++) {
      store.insertMessage({
        id: `msg-${i}`,
        channelId: 'ch-1',
        senderId: 'u',
        content: `message ${i}`,
        createdAt: now + i,
        receivedAt: now,
      })
    }

    expect(store.getMessageCount('ch-1')).toBe(25)
    expect(store.getMessageCount('ch-nonexistent')).toBe(0)

    store.close()
  })
})

describe('MessageStore pagination', () => {
  it('paginates 1000 messages with limit and offset', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))
    const now = Date.now()

    // Insert 1000 messages
    for (let i = 0; i < 1000; i++) {
      store.insertMessage({
        id: `msg-${String(i).padStart(4, '0')}`,
        channelId: 'ch',
        senderId: 'user-1',
        content: `message number ${i}`,
        createdAt: now + i,
        receivedAt: now,
      })
    }

    expect(store.getMessageCount('ch')).toBe(1000)

    // First page
    const page1 = store.getMessagesByChannel('ch', 10, 0)
    expect(page1.length).toBe(10)
    expect(page1[0].content).toBe('message number 0')
    expect(page1[9].content).toBe('message number 9')

    // Middle page
    const page50 = store.getMessagesByChannel('ch', 10, 500)
    expect(page50.length).toBe(10)
    expect(page50[0].content).toBe('message number 500')
    expect(page50[9].content).toBe('message number 509')

    // Last page
    const lastPage = store.getMessagesByChannel('ch', 10, 990)
    expect(lastPage.length).toBe(10)
    expect(lastPage[0].content).toBe('message number 990')
    expect(lastPage[9].content).toBe('message number 999')

    // Beyond end
    const empty = store.getMessagesByChannel('ch', 10, 1000)
    expect(empty.length).toBe(0)

    store.close()
  })

  it('defaults to limit=50, offset=0', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))
    const now = Date.now()

    for (let i = 0; i < 100; i++) {
      store.insertMessage({
        id: `msg-${i}`,
        channelId: 'ch',
        senderId: 'u',
        content: `msg ${i}`,
        createdAt: now + i,
        receivedAt: now,
      })
    }

    const messages = store.getMessagesByChannel('ch')
    expect(messages.length).toBe(50)
    expect(messages[0].content).toBe('msg 0')

    store.close()
  })
})

describe('MessageStore wrong encryption key (SQLCipher)', () => {
  it('throws when opening a database with the wrong key', () => {
    const correctKey = randomBytes(32)
    const wrongKey = randomBytes(32)
    const dbPath = join(tempDir, 'messages.db')

    const store1 = new MessageStore(dbPath, new Uint8Array(correctKey))
    store1.insertMessage({
      id: 'msg-1',
      channelId: 'ch',
      senderId: 'u',
      content: 'secret message',
      createdAt: Date.now(),
      receivedAt: Date.now(),
    })
    store1.close()

    // Opening with wrong key should throw (SQLCipher fails on first query)
    expect(() => new MessageStore(dbPath, new Uint8Array(wrongKey))).toThrow()
  })
})

describe('MessageStore persistence', () => {
  it('data survives close and reopen with same key', () => {
    const dbPath = join(tempDir, 'messages.db')
    const now = Date.now()

    // Write data
    const store1 = new MessageStore(dbPath, new Uint8Array(encryptionKey))
    store1.insertMessage({
      id: 'msg-persist',
      channelId: 'ch-1',
      senderId: 'user-1',
      content: 'persisted message',
      createdAt: now,
      receivedAt: now,
    })
    store1.close()

    // Reopen with same key (must pass copy since constructor zeros the key)
    const store2 = new MessageStore(dbPath, new Uint8Array(encryptionKey))

    const msg = store2.getMessage('msg-persist')
    expect(msg).not.toBeNull()
    expect(msg!.content).toBe('persisted message')
    expect(msg!.channelId).toBe('ch-1')
    expect(msg!.senderId).toBe('user-1')

    store2.close()
  })
})

// TESTSPEC: KS-009
describe('MessageStore E2E message store and retrieve', () => {
  it('stores an E2E message and retrieves it by channel_id with matching content', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))
    const now = Date.now()

    store.insertMessage({
      id: 'e2e-msg-1',
      channelId: 'encrypted-channel-1',
      senderId: 'user-sender',
      content: 'This is an end-to-end encrypted message',
      createdAt: now,
      receivedAt: now,
    })

    const messages = store.getMessagesByChannel('encrypted-channel-1')
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe('e2e-msg-1')
    expect(messages[0].content).toBe('This is an end-to-end encrypted message')
    expect(messages[0].senderId).toBe('user-sender')
    expect(messages[0].channelId).toBe('encrypted-channel-1')

    store.close()
  })
})

// TESTSPEC: KS-010
describe('MessageStore messages_db_pagination', () => {
  it('50 messages retrieved with limit=20 returns correct count', () => {
    const store = new MessageStore(join(tempDir, 'messages.db'), new Uint8Array(encryptionKey))
    const now = Date.now()

    // Insert 50 messages
    for (let i = 0; i < 50; i++) {
      store.insertMessage({
        id: `pagination-msg-${i}`,
        channelId: 'paginated-channel',
        senderId: 'user-1',
        content: `message ${i}`,
        createdAt: now + i,
        receivedAt: now,
      })
    }

    // Retrieve with limit=20
    const page1 = store.getMessagesByChannel('paginated-channel', 20, 0)
    expect(page1.length).toBe(20)
    expect(page1[0].content).toBe('message 0')
    expect(page1[19].content).toBe('message 19')

    // Retrieve next page (cursor = offset 20)
    const page2 = store.getMessagesByChannel('paginated-channel', 20, 20)
    expect(page2.length).toBe(20)
    expect(page2[0].content).toBe('message 20')
    expect(page2[19].content).toBe('message 39')

    // Retrieve last page (only 10 remaining)
    const page3 = store.getMessagesByChannel('paginated-channel', 20, 40)
    expect(page3.length).toBe(10)
    expect(page3[0].content).toBe('message 40')

    store.close()
  })
})

// ── KS-011: messages_db_encrypted_at_rest ─────────────────

// TESTSPEC: KS-011
describe('MessageStore encrypted at rest', () => {
  it('raw database file does NOT contain plaintext message content', () => {
    const dbPath = join(tempDir, 'encrypted-messages.db')
    const now = Date.now()

    // A recognizable plaintext string that we'll search for in raw bytes
    const secretContent = 'THIS_IS_A_SUPER_SECRET_PLAINTEXT_MESSAGE_XYZ123'

    const store = new MessageStore(dbPath, new Uint8Array(encryptionKey))
    store.insertMessage({
      id: 'msg-secret',
      channelId: 'ch-secret',
      senderId: 'user-secret',
      content: secretContent,
      createdAt: now,
      receivedAt: now,
    })
    store.close()

    // Read raw file bytes and search for the plaintext
    const rawBytes = readFileSync(dbPath)
    const rawString = rawBytes.toString('utf8')

    expect(rawString).not.toContain(secretContent)
    // Also check as latin1 in case of encoding differences
    expect(rawBytes.toString('latin1')).not.toContain(secretContent)
  })
})
