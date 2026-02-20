import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
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
    const store = new MessageStore(join(tempDir, 'messages.db'), encryptionKey)

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
    const store = new MessageStore(join(tempDir, 'messages.db'), encryptionKey)

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
    const store = new MessageStore(join(tempDir, 'messages.db'), encryptionKey)
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
    const store = new MessageStore(join(tempDir, 'messages.db'), encryptionKey)
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
    const store = new MessageStore(join(tempDir, 'messages.db'), encryptionKey)
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
    const store = new MessageStore(join(tempDir, 'messages.db'), encryptionKey)
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
    const store = new MessageStore(join(tempDir, 'messages.db'), encryptionKey)
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
    const store = new MessageStore(join(tempDir, 'messages.db'), encryptionKey)
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

describe('MessageStore wrong encryption key', () => {
  it('fails to decrypt message content with wrong key', () => {
    const correctKey = randomBytes(32)
    const wrongKey = randomBytes(32)
    const dbPath = join(tempDir, 'messages.db')

    const store1 = new MessageStore(dbPath, correctKey)
    store1.insertMessage({
      id: 'msg-1',
      channelId: 'ch',
      senderId: 'u',
      content: 'secret message',
      createdAt: Date.now(),
      receivedAt: Date.now(),
    })
    store1.close()

    const store2 = new MessageStore(dbPath, wrongKey)
    expect(() => store2.getMessage('msg-1')).toThrow()
    store2.close()
  })

  it('fails to decrypt channel messages with wrong key', () => {
    const correctKey = randomBytes(32)
    const wrongKey = randomBytes(32)
    const dbPath = join(tempDir, 'messages.db')

    const store1 = new MessageStore(dbPath, correctKey)
    store1.insertMessage({
      id: 'msg-1',
      channelId: 'ch',
      senderId: 'u',
      content: 'secret',
      createdAt: Date.now(),
      receivedAt: Date.now(),
    })
    store1.close()

    const store2 = new MessageStore(dbPath, wrongKey)
    expect(() => store2.getMessagesByChannel('ch')).toThrow()
    store2.close()
  })
})
