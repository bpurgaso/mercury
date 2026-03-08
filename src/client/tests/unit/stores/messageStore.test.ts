import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the api module
vi.mock('../../../src/renderer/services/api', () => ({
  messages: {
    getHistory: vi.fn(),
  },
  servers: {
    listMembers: vi.fn(),
  },
  deviceList: {
    fetch: vi.fn(),
  },
  keyBundles: {
    fetchAllForUser: vi.fn(),
    claimOtp: vi.fn(),
  },
  senderKeys: {
    getPending: vi.fn(),
    acknowledge: vi.fn(),
  },
  devices: {
    uploadKeyBundle: vi.fn(),
  },
  setTokenProvider: vi.fn(),
}))

// Mock the websocket module
vi.mock('../../../src/renderer/services/websocket', () => ({
  wsManager: {
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

// Mock the crypto service
vi.mock('../../../src/renderer/services/crypto', () => ({
  cryptoService: {
    encryptGroup: vi.fn(),
    decryptGroup: vi.fn(),
    encryptDm: vi.fn(),
    decryptDm: vi.fn(),
    storeMessage: vi.fn(),
    getMessages: vi.fn(),
    hasSessions: vi.fn(),
    verifyDeviceList: vi.fn(),
    receiveSenderKeyDistribution: vi.fn(),
    distributeSenderKeyToDevices: vi.fn(),
    establishAndDistributeSenderKey: vi.fn(),
    markSenderKeyStale: vi.fn(),
    getPublicKeys: vi.fn(),
    generateOneTimePreKeys: vi.fn(),
    establishAndEncryptDm: vi.fn(),
    acceptIdentityChange: vi.fn(),
  },
  initCryptoPort: vi.fn(),
}))

// Mock the dmChannelStore (no DM channels by default)
vi.mock('../../../src/renderer/stores/dmChannelStore', () => ({
  useDmChannelStore: {
    getState: vi.fn(() => ({
      dmChannels: new Map(),
    })),
  },
}))

// Mock the serverStore
vi.mock('../../../src/renderer/stores/serverStore', () => {
  const { create } = require('zustand')
  const store = create((set: Function, get: Function) => ({
    servers: new Map(),
    channels: new Map(),
    members: new Map(),
    activeServerId: null,
    activeChannelId: null,
    getServerChannels: () => [],
    updateChannel: (channel: Record<string, unknown>) => {
      set((state: Record<string, unknown>) => {
        const channels = new Map(state.channels as Map<string, unknown>)
        channels.set(channel.id, channel)
        return { channels }
      })
    },
  }))
  return { useServerStore: store }
})

// Mock the authStore
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({
      user: { id: 'user-self' },
    })),
  },
}))

// Mock crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => 'test-uuid-1234'),
})

import { useMessageStore } from '../../../src/renderer/stores/messageStore'
import { useServerStore } from '../../../src/renderer/stores/serverStore'
import { messages as messagesApi, servers as serversApi, deviceList as deviceListApi } from '../../../src/renderer/services/api'
import { wsManager } from '../../../src/renderer/services/websocket'
import { cryptoService } from '../../../src/renderer/services/crypto'
import type { Message } from '../../../src/renderer/types/models'

// Helper: base64 encode a Uint8Array
function toBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
}

const makeMessage = (id: string, channelId: string, content: string): Message => ({
  id,
  channel_id: channelId,
  sender_id: 'user-1',
  content,
  message_type: 'text',
  created_at: new Date().toISOString(),
  edited_at: null,
})

describe('messageStore', () => {
  beforeEach(() => {
    useMessageStore.setState({
      messages: new Map(),
      dmHistoryLoaded: new Set(),
      privateHistoryLoaded: new Set(),
    })
    // Reset serverStore channels to empty
    useServerStore.setState({ channels: new Map() })
    vi.clearAllMocks()
  })

  // TESTSPEC: ST-010
  it('addMessage appends a message to channel list', () => {
    const msg = makeMessage('m1', 'c1', 'Hello')

    useMessageStore.getState().addMessage('c1', msg)

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(1)
    expect(messages[0].content).toBe('Hello')
  })

  it('addMessage does not duplicate messages', () => {
    const msg = makeMessage('m1', 'c1', 'Hello')

    useMessageStore.getState().addMessage('c1', msg)
    useMessageStore.getState().addMessage('c1', msg) // same id

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(1)
  })

  it('addMessage appends to existing messages', () => {
    useMessageStore.getState().addMessage('c1', makeMessage('m1', 'c1', 'First'))
    useMessageStore.getState().addMessage('c1', makeMessage('m2', 'c1', 'Second'))

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(2)
    expect(messages[0].content).toBe('First')
    expect(messages[1].content).toBe('Second')
  })

  it('handleMessageCreate converts event to message and adds it', () => {
    useMessageStore.getState().handleMessageCreate({
      id: 'm1',
      channel_id: 'c1',
      sender_id: 'user-1',
      content: 'From WS',
      created_at: '2025-01-01T00:00:00Z',
    })

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(1)
    expect(messages[0].content).toBe('From WS')
  })

  // TESTSPEC: ST-012
  it('fetchHistory prepends messages to the channel', async () => {
    // Existing messages
    useMessageStore.getState().addMessage('c1', makeMessage('m3', 'c1', 'Third'))

    // History from API
    const history = [
      makeMessage('m1', 'c1', 'First'),
      makeMessage('m2', 'c1', 'Second'),
    ]
    vi.mocked(messagesApi.getHistory).mockResolvedValue(history)

    await useMessageStore.getState().fetchHistory('c1')

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(3)
    // History is prepended
    expect(messages[0].content).toBe('First')
    expect(messages[1].content).toBe('Second')
    expect(messages[2].content).toBe('Third')
  })

  it('fetchHistory does not duplicate existing messages', async () => {
    useMessageStore.getState().addMessage('c1', makeMessage('m1', 'c1', 'First'))

    // API returns same message
    vi.mocked(messagesApi.getHistory).mockResolvedValue([makeMessage('m1', 'c1', 'First')])

    await useMessageStore.getState().fetchHistory('c1')

    const messages = useMessageStore.getState().getChannelMessages('c1')
    expect(messages.length).toBe(1)
  })

  // TESTSPEC: ST-008
  it('sendMessage sends via WebSocket', () => {
    useMessageStore.getState().sendMessage('c1', 'Hello world')

    expect(wsManager.send).toHaveBeenCalledWith('message_send', {
      channel_id: 'c1',
      content: 'Hello world',
    })
  })

  it('getChannelMessages returns empty array for unknown channel', () => {
    const messages = useMessageStore.getState().getChannelMessages('unknown')
    expect(messages).toEqual([])
  })

  // TESTSPEC: ST-009
  it('sendMessage encrypts via cryptoService.encryptGroup for private channels', async () => {
    const channelId = 'ch-private-1'
    const privateChannel = {
      id: channelId,
      server_id: 'server-1',
      name: 'secret-chat',
      channel_type: 'text' as const,
      encryption_mode: 'private' as const,
      sender_key_epoch: 0,
      position: 0,
      topic: null,
      created_at: '2026-01-01T00:00:00Z',
    }

    // Put the private channel in the serverStore
    useServerStore.setState({
      channels: new Map([[channelId, privateChannel]]),
    })

    // Mock server members and device list for getChannelMemberDevices
    vi.mocked(serversApi.listMembers).mockResolvedValue([
      { user_id: 'user-alice', server_id: 'server-1', nickname: null, is_moderator: false, joined_at: '2026-01-01T00:00:00Z' },
    ])
    vi.mocked(deviceListApi.fetch).mockResolvedValue({
      signed_list: toBase64(new Uint8Array(64).fill(0x01)),
      master_verify_key: toBase64(new Uint8Array(32).fill(0x02)),
      signature: toBase64(new Uint8Array(64).fill(0x03)),
    })
    vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
      devices: [{ deviceId: 'device-1' }],
    })

    const mockEncrypted = { ciphertext: [1, 2, 3], nonce: [4, 5, 6], signature: [7, 8, 9], iteration: 1, epoch: 0, sender_device_id: 'device-self' }

    // Mock encryptGroup to return ciphertext (no needsX3dh)
    vi.mocked(cryptoService.encryptGroup).mockResolvedValue({
      encrypted: mockEncrypted,
      needsX3dh: [],
      distributions: [],
    })

    // Mock storeMessage (called to persist the plaintext locally)
    vi.mocked(cryptoService.storeMessage).mockResolvedValue(undefined)

    // Mock getPublicKeys (called by maybeReplenishPreKeys at the end)
    vi.mocked(cryptoService.getPublicKeys).mockResolvedValue({ unusedPreKeyCount: 50 })

    await useMessageStore.getState().sendMessage(channelId, 'Secret message')

    // Verify encryptGroup was called with the correct plaintext
    expect(cryptoService.encryptGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId,
        plaintext: 'Secret message',
        channelEpoch: 0,
      }),
    )

    // Verify WS send was called with the encrypted payload (not plaintext)
    expect(wsManager.send).toHaveBeenCalledWith(
      'message_send',
      expect.objectContaining({
        channel_id: channelId,
        encrypted: mockEncrypted,
      }),
    )
  })

  // TESTSPEC: ST-011
  it('handleMessageCreate decrypts private channel messages via cryptoService.decryptGroup', async () => {
    const channelId = 'ch-private-1'

    // Mock decryptGroup to return plaintext
    vi.mocked(cryptoService.decryptGroup).mockResolvedValue({
      plaintext: 'Decrypted secret message',
    })

    // Dispatch an encrypted MESSAGE_CREATE event
    useMessageStore.getState().handleMessageCreate({
      id: 'msg-enc-1',
      channel_id: channelId,
      sender_id: 'user-alice', // different from 'user-self' so self-echo skip does not trigger
      created_at: '2026-01-01T00:00:00Z',
      encrypted: {
        ciphertext: new Uint8Array([1, 2, 3]),
        nonce: new Uint8Array([4, 5, 6]),
        signature: new Uint8Array([7, 8, 9]),
        sender_device_id: 'device-alice-1',
        iteration: 1,
        epoch: 0,
      },
    })

    // decryptGroup is called asynchronously inside handlePrivateChannelMessageCreate,
    // so we need to wait for it to resolve
    await vi.waitFor(() => {
      expect(cryptoService.decryptGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId,
          senderId: 'user-alice',
          senderDeviceId: 'device-alice-1',
          iteration: 1,
          epoch: 0,
        }),
      )
    })

    // Verify the decrypted message was added to the store
    await vi.waitFor(() => {
      const messages = useMessageStore.getState().getChannelMessages(channelId)
      expect(messages.length).toBe(1)
      expect(messages[0].content).toBe('Decrypted secret message')
      expect(messages[0].sender_id).toBe('user-alice')
    })
  })

  // TESTSPEC: ST-013
  it('fetchPrivateChannelHistory loads local messages first then fetches server messages', async () => {
    const channelId = 'ch-private-2'

    // Mock local messages from cryptoService.getMessages
    vi.mocked(cryptoService.getMessages).mockResolvedValue([
      {
        id: 'local-msg-1',
        senderId: 'user-alice',
        content: 'Local message one',
        createdAt: new Date('2026-01-01T00:00:00Z').getTime(),
      },
      {
        id: 'local-msg-2',
        senderId: 'user-bob',
        content: 'Local message two',
        createdAt: new Date('2026-01-01T00:01:00Z').getTime(),
      },
    ])

    // Mock server returning no new messages (simple case)
    vi.mocked(messagesApi.getHistory).mockResolvedValue([])

    await useMessageStore.getState().fetchPrivateChannelHistory(channelId)

    // Verify local messages were loaded via cryptoService.getMessages
    expect(cryptoService.getMessages).toHaveBeenCalledWith(channelId, 50, 0)

    // Verify local messages are in the store
    const messages = useMessageStore.getState().getChannelMessages(channelId)
    const realMessages = messages.filter((m) => m.message_type !== 'system')
    expect(realMessages.length).toBe(2)
    expect(realMessages[0].content).toBe('Local message one')
    expect(realMessages[1].content).toBe('Local message two')

    // Verify server catch-up was attempted
    expect(messagesApi.getHistory).toHaveBeenCalledWith(channelId, expect.objectContaining({
      limit: 50,
    }))
  })
})
