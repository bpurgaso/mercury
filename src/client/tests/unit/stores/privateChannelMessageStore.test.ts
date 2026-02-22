import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the api module
vi.mock('../../../src/renderer/services/api', () => ({
  messages: {
    getHistory: vi.fn(),
  },
  dm: {
    create: vi.fn(),
    list: vi.fn(),
    getHistory: vi.fn(),
  },
  keyBundles: {
    fetchAllForUser: vi.fn(),
    claimOtp: vi.fn(),
  },
  deviceList: {
    fetch: vi.fn(),
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
    verifyDeviceList: vi.fn(),
    hasSessions: vi.fn(),
    encryptDm: vi.fn(),
    establishAndEncryptDm: vi.fn(),
    decryptDm: vi.fn(),
    acceptIdentityChange: vi.fn(),
    storeMessage: vi.fn(),
    getMessages: vi.fn(),
    encryptGroup: vi.fn(),
    decryptGroup: vi.fn(),
    receiveSenderKeyDistribution: vi.fn(),
    distributeSenderKeyToDevices: vi.fn(),
    markSenderKeyStale: vi.fn(),
    getPublicKeys: vi.fn(),
    generateOneTimePreKeys: vi.fn(),
  },
  initCryptoPort: vi.fn(),
}))

// Mock the dmChannelStore (no DM channels for private channel tests)
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
const MOCK_UUID = 'test-uuid-1234'
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => MOCK_UUID),
})

import { useMessageStore } from '../../../src/renderer/stores/messageStore'
import { useServerStore } from '../../../src/renderer/stores/serverStore'
import { wsManager } from '../../../src/renderer/services/websocket'
import { cryptoService } from '../../../src/renderer/services/crypto'
import {
  messages as messagesApi,
  keyBundles as keyBundlesApi,
  deviceList as deviceListApi,
  devices as devicesApi,
} from '../../../src/renderer/services/api'

// Helper: base64 encode a Uint8Array
function toBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
}

// Test fixtures
const MOCK_PRIVATE_CHANNEL = {
  id: 'ch-private-1',
  server_id: 'server-1',
  name: 'secret-chat',
  channel_type: 'text' as const,
  encryption_mode: 'private' as const,
  sender_key_epoch: 0,
  position: 0,
  topic: null,
  created_at: '2026-01-01T00:00:00Z',
}

const MOCK_SERVER_MEMBERS = [
  { user_id: 'user-alice', server_id: 'server-1', nickname: null, is_moderator: false, joined_at: '2026-01-01T00:00:00Z' },
  { user_id: 'user-bob', server_id: 'server-1', nickname: null, is_moderator: false, joined_at: '2026-01-01T00:00:00Z' },
]

const MOCK_DEVICE_LIST_RESPONSE = {
  signed_list: toBase64(new Uint8Array(64).fill(0x01)),
  master_verify_key: toBase64(new Uint8Array(32).fill(0x02)),
  signature: toBase64(new Uint8Array(64).fill(0x03)),
}

const MOCK_KEY_BUNDLES = {
  devices: [{
    device_id: 'device-bob-1',
    device_name: 'Bob Phone',
    identity_key: toBase64(new Uint8Array(32).fill(0x11)),
    signed_prekey: toBase64(new Uint8Array(32).fill(0x22)),
    signed_prekey_id: 1,
    prekey_signature: toBase64(new Uint8Array(64).fill(0x33)),
  }],
}

const MOCK_ENCRYPT_GROUP_RESULT = {
  encrypted: {
    ciphertext: [1, 2, 3, 4],
    nonce: [5, 6, 7],
    signature: [8, 9, 10],
    iteration: 1,
    epoch: 0,
    sender_device_id: 'device-self-1',
  },
  distributions: [
    { device_id: 'device-alice-1', ciphertext: [100, 101, 102] },
    { device_id: 'device-bob-1', ciphertext: [200, 201, 202] },
  ],
  needsX3dh: [],
}

function setupServerStoreForPrivateChannel(): void {
  useServerStore.setState({
    channels: new Map([[MOCK_PRIVATE_CHANNEL.id, MOCK_PRIVATE_CHANNEL]]),
    members: new Map([['server-1', MOCK_SERVER_MEMBERS]]),
    servers: new Map([['server-1', {
      id: 'server-1',
      name: 'Test Server',
      description: null,
      icon_url: null,
      owner_id: 'user-alice',
      invite_code: 'abc123',
      max_members: null,
      created_at: '2026-01-01T00:00:00Z',
    }]]),
    activeServerId: 'server-1',
    activeChannelId: MOCK_PRIVATE_CHANNEL.id,
  })
}

function setupSuccessfulGroupSendMocks(): void {
  vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)

  vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
    verified: true,
    firstSeen: true,
    devices: [{ device_id: 'device-alice-1', identity_key: 'a' }],
  })

  vi.mocked(cryptoService.encryptGroup).mockResolvedValue(MOCK_ENCRYPT_GROUP_RESULT)
  vi.mocked(cryptoService.storeMessage).mockResolvedValue({ stored: true })
  vi.mocked(cryptoService.getPublicKeys).mockResolvedValue({
    masterVerifyPublicKey: [1, 2, 3],
    deviceId: 'device-self-1',
    deviceIdentityPublicKey: [4, 5, 6],
    signedPreKey: { keyId: 1, publicKey: [7, 8, 9], signature: [10, 11, 12] },
    unusedPreKeyCount: 50,
  })
}

describe('messageStore private channel operations', () => {
  beforeEach(() => {
    useMessageStore.setState({ messages: new Map(), dmHistoryLoaded: new Set(), privateHistoryLoaded: new Set() })
    vi.clearAllMocks()
    setupServerStoreForPrivateChannel()
  })

  describe('sendMessage for private channels', () => {
    it('encrypts via encryptGroup and sends encrypted payload', async () => {
      setupSuccessfulGroupSendMocks()

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Secret hello!')

      // Should have called encryptGroup with the channel info
      expect(cryptoService.encryptGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: MOCK_PRIVATE_CHANNEL.id,
          plaintext: 'Secret hello!',
          channelEpoch: 0,
          memberDevices: expect.any(Array),
        }),
      )

      // Should have sent encrypted payload via WebSocket
      expect(wsManager.send).toHaveBeenCalledWith('message_send', {
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        encrypted: MOCK_ENCRYPT_GROUP_RESULT.encrypted,
      })
    })

    it('sends SenderKey distributions before the message', async () => {
      setupSuccessfulGroupSendMocks()

      const callOrder: string[] = []
      vi.mocked(wsManager.send).mockImplementation((...args: unknown[]) => {
        const op = args[0] as string
        callOrder.push(op)
      })

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')

      // SenderKey distributions should be sent before the message
      expect(callOrder).toEqual(['sender_key_distribute', 'message_send'])
    })

    it('stores plaintext locally before sending via WebSocket (store-before-send)', async () => {
      setupSuccessfulGroupSendMocks()

      const callOrder: string[] = []
      vi.mocked(cryptoService.storeMessage).mockImplementation(async () => {
        callOrder.push('store')
        return { stored: true }
      })
      vi.mocked(wsManager.send).mockImplementation((..._args: unknown[]) => {
        callOrder.push('send')
      })

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')

      const storeIdx = callOrder.indexOf('store')
      const sendIdx = callOrder.lastIndexOf('send') // last send is message_send
      expect(storeIdx).toBeLessThan(sendIdx)
    })

    it('adds optimistic message to in-memory store', async () => {
      setupSuccessfulGroupSendMocks()

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')

      const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
      expect(messages.length).toBe(1)
      expect(messages[0].content).toBe('Hello!')
      expect(messages[0].sender_id).toBe('self')
      expect(messages[0].channel_id).toBe(MOCK_PRIVATE_CHANNEL.id)
    })

    it('handles X3DH establishment when needsX3dh is populated', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: true,
        firstSeen: true,
        devices: [{ device_id: 'device-alice-1', identity_key: 'a' }],
      })

      // encryptGroup returns needsX3dh for one device
      vi.mocked(cryptoService.encryptGroup).mockResolvedValue({
        encrypted: MOCK_ENCRYPT_GROUP_RESULT.encrypted,
        distributions: [{ device_id: 'device-alice-1', ciphertext: [100] }],
        needsX3dh: [{ userId: 'user-bob', deviceId: 'device-bob-1' }],
      })

      // Session check shows no session
      vi.mocked(cryptoService.hasSessions).mockResolvedValue([
        { userId: 'user-bob', deviceId: 'device-bob-1', hasSession: false },
      ])

      vi.mocked(keyBundlesApi.fetchAllForUser).mockResolvedValue(MOCK_KEY_BUNDLES)
      vi.mocked(keyBundlesApi.claimOtp).mockResolvedValue({
        key_id: 1,
        prekey: toBase64(new Uint8Array(32).fill(0x44)),
      })
      vi.mocked(cryptoService.establishAndEncryptDm).mockResolvedValue({
        recipients: [{
          device_id: 'device-bob-1',
          ciphertext: new Uint8Array([10, 20, 30]),
          ratchet_header: new Uint8Array(0),
          x3dh_header: {
            sender_identity_key: new Uint8Array(32).fill(0xaa),
            ephemeral_key: new Uint8Array(32).fill(0xbb),
            prekey_id: 1,
          },
        }],
      })

      // After X3DH, distribute SenderKey to new session
      vi.mocked(cryptoService.distributeSenderKeyToDevices).mockResolvedValue({
        distributions: [{ device_id: 'device-bob-1', ciphertext: [200] }],
      })

      vi.mocked(cryptoService.storeMessage).mockResolvedValue({ stored: true })
      vi.mocked(cryptoService.getPublicKeys).mockResolvedValue({
        masterVerifyPublicKey: [1], deviceId: 'device-self-1',
        deviceIdentityPublicKey: [4], signedPreKey: { keyId: 1, publicKey: [7], signature: [10] },
        unusedPreKeyCount: 50,
      })

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')

      // Should have established X3DH session
      expect(cryptoService.establishAndEncryptDm).toHaveBeenCalled()

      // Should have distributed SenderKey to the new session
      expect(cryptoService.distributeSenderKeyToDevices).toHaveBeenCalledWith({
        channelId: MOCK_PRIVATE_CHANNEL.id,
        devices: [{ userId: 'user-bob', deviceId: 'device-bob-1' }],
      })
    })

    it('skips SenderKey distribution send when distributions list is empty', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: true,
        firstSeen: true,
        devices: [{ device_id: 'device-alice-1', identity_key: 'a' }],
      })
      vi.mocked(cryptoService.encryptGroup).mockResolvedValue({
        encrypted: MOCK_ENCRYPT_GROUP_RESULT.encrypted,
        distributions: [],  // empty — all recipients already have our key
        needsX3dh: [],
      })
      vi.mocked(cryptoService.storeMessage).mockResolvedValue({ stored: true })
      vi.mocked(cryptoService.getPublicKeys).mockResolvedValue({
        masterVerifyPublicKey: [1], deviceId: 'device-self-1',
        deviceIdentityPublicKey: [4], signedPreKey: { keyId: 1, publicKey: [7], signature: [10] },
        unusedPreKeyCount: 50,
      })

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')

      // Only message_send should be sent (no sender_key_distribute)
      expect(wsManager.send).toHaveBeenCalledTimes(1)
      expect(wsManager.send).toHaveBeenCalledWith('message_send', expect.objectContaining({
        channel_id: MOCK_PRIVATE_CHANNEL.id,
      }))
    })

    it('does NOT send via DM path for private channel', async () => {
      setupSuccessfulGroupSendMocks()

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')

      // Should NOT have called DM-specific encrypt methods
      expect(cryptoService.encryptDm).not.toHaveBeenCalled()
      expect(cryptoService.decryptDm).not.toHaveBeenCalled()
    })
  })

  describe('handleMessageCreate for private channels', () => {
    it('decrypts private channel message via decryptGroup', async () => {
      vi.mocked(cryptoService.decryptGroup).mockResolvedValue({
        plaintext: 'Decrypted secret!',
        messageId: 'msg-priv-1',
      })

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-priv-1',
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-alice',
        encrypted: {
          ciphertext: new Uint8Array([1, 2, 3]),
          nonce: new Uint8Array([4, 5, 6]),
          signature: new Uint8Array([7, 8, 9]),
          sender_device_id: 'device-alice-1',
          iteration: 1,
          epoch: 0,
        },
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        expect(cryptoService.decryptGroup).toHaveBeenCalledWith(
          expect.objectContaining({
            channelId: MOCK_PRIVATE_CHANNEL.id,
            senderId: 'user-alice',
            senderDeviceId: 'device-alice-1',
            ciphertext: [1, 2, 3],
            nonce: [4, 5, 6],
            signature: [7, 8, 9],
            iteration: 1,
            epoch: 0,
            messageId: 'msg-priv-1',
          }),
        )
      })

      await vi.waitFor(() => {
        const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
        expect(messages.length).toBe(1)
        expect(messages[0].content).toBe('Decrypted secret!')
        expect(messages[0].channel_id).toBe(MOCK_PRIVATE_CHANNEL.id)
      })
    })

    it('shows DECRYPT_FAILED placeholder on decrypt failure', async () => {
      vi.mocked(cryptoService.decryptGroup).mockResolvedValue({
        error: 'DECRYPT_FAILED',
      })

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-priv-fail',
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-alice',
        encrypted: {
          ciphertext: new Uint8Array([1]),
          nonce: new Uint8Array([2]),
          signature: new Uint8Array([3]),
          sender_device_id: 'device-alice-1',
          iteration: 1,
          epoch: 0,
        },
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
        expect(messages.length).toBe(1)
        expect(messages[0].content).toBeNull()
        expect(messages[0].decrypt_error).toBe('DECRYPT_FAILED')
      })
    })

    it('shows MISSING_SENDER_KEY placeholder and queues for retry', async () => {
      vi.mocked(cryptoService.decryptGroup).mockResolvedValue({
        error: 'MISSING_SENDER_KEY',
      })

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-priv-pending',
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-bob',
        encrypted: {
          ciphertext: new Uint8Array([1]),
          nonce: new Uint8Array([2]),
          signature: new Uint8Array([3]),
          sender_device_id: 'device-bob-1',
          iteration: 1,
          epoch: 0,
        },
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
        expect(messages.length).toBe(1)
        expect(messages[0].content).toBeNull()
        expect(messages[0].decrypt_error).toBe('MISSING_SENDER_KEY')
      })
    })

    it('shows DECRYPT_FAILED placeholder when decryptGroup throws', async () => {
      vi.mocked(cryptoService.decryptGroup).mockRejectedValue(new Error('crypto error'))

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-priv-throw',
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-alice',
        encrypted: {
          ciphertext: new Uint8Array([1]),
          nonce: new Uint8Array([2]),
          signature: new Uint8Array([3]),
          sender_device_id: 'device-alice-1',
          iteration: 1,
          epoch: 0,
        },
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
        expect(messages.length).toBe(1)
        expect(messages[0].decrypt_error).toBe('DECRYPT_FAILED')
      })
    })

    it('self-echo skip: does not decrypt own messages', async () => {
      useMessageStore.getState().handleMessageCreate({
        id: 'msg-self-echo',
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'self',
        encrypted: {
          ciphertext: new Uint8Array([1]),
          nonce: new Uint8Array([2]),
          signature: new Uint8Array([3]),
          sender_device_id: 'device-self-1',
          iteration: 1,
          epoch: 0,
        },
        created_at: '2026-02-22T00:00:00Z',
      })

      // Give async a tick
      await new Promise((r) => setTimeout(r, 50))

      // decryptGroup should NOT have been called
      expect(cryptoService.decryptGroup).not.toHaveBeenCalled()

      // No message should be added (sender already stored optimistically)
      const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
      expect(messages.length).toBe(0)
    })
  })

  describe('handleSenderKeyDistribution', () => {
    it('passes distribution event to crypto service', async () => {
      vi.mocked(cryptoService.receiveSenderKeyDistribution).mockResolvedValue({ stored: true })

      await useMessageStore.getState().handleSenderKeyDistribution({
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-bob',
        sender_device_id: 'device-bob-1',
        ciphertext: new Uint8Array([10, 20, 30]),
      })

      expect(cryptoService.receiveSenderKeyDistribution).toHaveBeenCalledWith({
        channelId: MOCK_PRIVATE_CHANNEL.id,
        senderId: 'user-bob',
        senderDeviceId: 'device-bob-1',
        ciphertext: [10, 20, 30],
      })
    })

    it('retries queued messages after receiving SenderKey distribution', async () => {
      // First: receive a message that fails with MISSING_SENDER_KEY
      vi.mocked(cryptoService.decryptGroup)
        .mockResolvedValueOnce({ error: 'MISSING_SENDER_KEY' })
        // Second call after distribution: succeed
        .mockResolvedValueOnce({ plaintext: 'Now decrypted!', messageId: 'msg-queued' })

      // Receive message → queued
      useMessageStore.getState().handleMessageCreate({
        id: 'msg-queued',
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-bob',
        encrypted: {
          ciphertext: new Uint8Array([1]),
          nonce: new Uint8Array([2]),
          signature: new Uint8Array([3]),
          sender_device_id: 'device-bob-1',
          iteration: 1,
          epoch: 0,
        },
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        const msgs = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
        expect(msgs.length).toBe(1)
        expect(msgs[0].decrypt_error).toBe('MISSING_SENDER_KEY')
      })

      // Now receive the SenderKey distribution → should retry queued message
      vi.mocked(cryptoService.receiveSenderKeyDistribution).mockResolvedValue({ stored: true })

      await useMessageStore.getState().handleSenderKeyDistribution({
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-bob',
        sender_device_id: 'device-bob-1',
        ciphertext: new Uint8Array([10, 20]),
      })

      // decryptGroup should have been called twice total
      await vi.waitFor(() => {
        expect(cryptoService.decryptGroup).toHaveBeenCalledTimes(2)
      })

      // The placeholder should be updated in-place with decrypted content
      await vi.waitFor(() => {
        const msgs = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
        expect(msgs.length).toBe(1)
        expect(msgs[0].id).toBe('msg-queued')
        expect(msgs[0].content).toBe('Now decrypted!')
        expect(msgs[0].decrypt_error).toBeUndefined()
      })
    })

    it('does not retry if distribution fails', async () => {
      // Queue a message first
      vi.mocked(cryptoService.decryptGroup).mockResolvedValueOnce({ error: 'MISSING_SENDER_KEY' })

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-queued-2',
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-bob',
        encrypted: {
          ciphertext: new Uint8Array([1]),
          nonce: new Uint8Array([2]),
          signature: new Uint8Array([3]),
          sender_device_id: 'device-bob-1',
          iteration: 1,
          epoch: 0,
        },
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        expect(cryptoService.decryptGroup).toHaveBeenCalledTimes(1)
      })

      // Distribution fails
      vi.mocked(cryptoService.receiveSenderKeyDistribution).mockResolvedValue({
        stored: false,
        error: 'DR_SESSION_NOT_FOUND',
      })

      await useMessageStore.getState().handleSenderKeyDistribution({
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-bob',
        sender_device_id: 'device-bob-1',
        ciphertext: new Uint8Array([10]),
      })

      // decryptGroup should NOT have been called again
      expect(cryptoService.decryptGroup).toHaveBeenCalledTimes(1)
    })
  })

  describe('fetchPrivateChannelHistory', () => {
    it('loads local messages from cryptoService.getMessages', async () => {
      vi.mocked(cryptoService.getMessages).mockResolvedValue([
        { id: 'local-1', channelId: MOCK_PRIVATE_CHANNEL.id, senderId: 'user-alice', content: 'Local msg 1', createdAt: 1000, receivedAt: 1001 },
        { id: 'local-2', channelId: MOCK_PRIVATE_CHANNEL.id, senderId: 'self', content: 'Local msg 2', createdAt: 2000, receivedAt: 2001 },
      ])
      vi.mocked(messagesApi.getHistory).mockResolvedValue([])

      await useMessageStore.getState().fetchPrivateChannelHistory(MOCK_PRIVATE_CHANNEL.id)

      const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
      // Should have the 2 local messages
      const realMessages = messages.filter((m) => m.message_type !== 'system')
      expect(realMessages.length).toBe(2)
      expect(realMessages[0].content).toBe('Local msg 1')
      expect(realMessages[1].content).toBe('Local msg 2')
    })

    it('shows E2E join notice when no local messages exist', async () => {
      vi.mocked(cryptoService.getMessages).mockResolvedValue([])
      vi.mocked(messagesApi.getHistory).mockResolvedValue([])

      await useMessageStore.getState().fetchPrivateChannelHistory(MOCK_PRIVATE_CHANNEL.id)

      const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
      const systemMessages = messages.filter((m) => m.message_type === 'system')
      expect(systemMessages.length).toBe(1)
      expect(systemMessages[0].content).toContain('end-to-end encrypted')
    })

    it('sets privateHistoryLoaded to prevent re-fetching', async () => {
      vi.mocked(cryptoService.getMessages).mockResolvedValue([])
      vi.mocked(messagesApi.getHistory).mockResolvedValue([])

      await useMessageStore.getState().fetchPrivateChannelHistory(MOCK_PRIVATE_CHANNEL.id)
      expect(useMessageStore.getState().privateHistoryLoaded.has(MOCK_PRIVATE_CHANNEL.id)).toBe(true)

      // Call again
      vi.mocked(cryptoService.getMessages).mockClear()
      await useMessageStore.getState().fetchPrivateChannelHistory(MOCK_PRIVATE_CHANNEL.id)

      // getMessages should NOT have been called again (history already loaded)
      expect(cryptoService.getMessages).not.toHaveBeenCalled()
    })
  })

  describe('addSystemMessage', () => {
    it('adds a system message to the channel', () => {
      useMessageStore.getState().addSystemMessage(MOCK_PRIVATE_CHANNEL.id, 'User joined the channel.')

      const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
      expect(messages.length).toBe(1)
      expect(messages[0].message_type).toBe('system')
      expect(messages[0].content).toBe('User joined the channel.')
      expect(messages[0].sender_id).toBe('system')
      expect(messages[0].id).toMatch(/^system-/)
    })
  })

  describe('updateMessage', () => {
    it('updates specific fields of a message', () => {
      // Add a placeholder message
      useMessageStore.getState().addMessage(MOCK_PRIVATE_CHANNEL.id, {
        id: 'msg-to-update',
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        sender_id: 'user-bob',
        content: null,
        message_type: 'text',
        created_at: '2026-02-22T00:00:00Z',
        edited_at: null,
        decrypt_error: 'MISSING_SENDER_KEY',
      })

      // Update it after decryption
      useMessageStore.getState().updateMessage(MOCK_PRIVATE_CHANNEL.id, 'msg-to-update', {
        content: 'Decrypted content',
        decrypt_error: undefined,
      })

      const messages = useMessageStore.getState().getChannelMessages(MOCK_PRIVATE_CHANNEL.id)
      expect(messages[0].content).toBe('Decrypted content')
      expect(messages[0].decrypt_error).toBeUndefined()
    })

    it('no-ops for non-existent channel', () => {
      useMessageStore.getState().updateMessage('non-existent', 'msg-1', { content: 'test' })
      // Should not throw
      expect(useMessageStore.getState().getChannelMessages('non-existent')).toEqual([])
    })
  })

  describe('distributeSenderKeyToNewMember', () => {
    it('fetches device list, establishes sessions, and distributes key', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: true,
        firstSeen: true,
        devices: [{ device_id: 'device-new-1', identity_key: 'x' }],
      })
      vi.mocked(cryptoService.hasSessions).mockResolvedValue([
        { userId: 'user-new', deviceId: 'device-new-1', hasSession: false },
      ])
      vi.mocked(keyBundlesApi.fetchAllForUser).mockResolvedValue({
        devices: [{
          device_id: 'device-new-1',
          device_name: 'New Phone',
          identity_key: toBase64(new Uint8Array(32).fill(0x11)),
          signed_prekey: toBase64(new Uint8Array(32).fill(0x22)),
          signed_prekey_id: 1,
          prekey_signature: toBase64(new Uint8Array(64).fill(0x33)),
        }],
      })
      vi.mocked(keyBundlesApi.claimOtp).mockResolvedValue({
        key_id: 1,
        prekey: toBase64(new Uint8Array(32).fill(0x44)),
      })
      vi.mocked(cryptoService.establishAndEncryptDm).mockResolvedValue({
        recipients: [{
          device_id: 'device-new-1',
          ciphertext: new Uint8Array([10]),
          ratchet_header: new Uint8Array(0),
          x3dh_header: {
            sender_identity_key: new Uint8Array(32),
            ephemeral_key: new Uint8Array(32),
            prekey_id: 1,
          },
        }],
      })
      vi.mocked(cryptoService.distributeSenderKeyToDevices).mockResolvedValue({
        distributions: [{ device_id: 'device-new-1', ciphertext: [50, 51] }],
      })

      await useMessageStore.getState().distributeSenderKeyToNewMember(MOCK_PRIVATE_CHANNEL.id, 'user-new')

      // Should have fetched device list
      expect(deviceListApi.fetch).toHaveBeenCalledWith('user-new')

      // Should have verified device list
      expect(cryptoService.verifyDeviceList).toHaveBeenCalled()

      // Should have established session via X3DH
      expect(cryptoService.establishAndEncryptDm).toHaveBeenCalled()

      // Should have distributed SenderKey
      expect(cryptoService.distributeSenderKeyToDevices).toHaveBeenCalledWith({
        channelId: MOCK_PRIVATE_CHANNEL.id,
        devices: [{ userId: 'user-new', deviceId: 'device-new-1' }],
      })

      // Should have sent distribution via WebSocket
      expect(wsManager.send).toHaveBeenCalledWith('sender_key_distribute', {
        channel_id: MOCK_PRIVATE_CHANNEL.id,
        distributions: [{ device_id: 'device-new-1', ciphertext: [50, 51] }],
      })
    })

    it('does nothing if device list verification fails', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: false,
        error: 'SIGNATURE_INVALID',
      })

      await useMessageStore.getState().distributeSenderKeyToNewMember(MOCK_PRIVATE_CHANNEL.id, 'user-new')

      expect(cryptoService.distributeSenderKeyToDevices).not.toHaveBeenCalled()
      expect(wsManager.send).not.toHaveBeenCalled()
    })

    it('does not send distribution when no distributions are generated', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: true,
        firstSeen: true,
        devices: [{ device_id: 'device-new-1', identity_key: 'x' }],
      })
      vi.mocked(cryptoService.hasSessions).mockResolvedValue([
        { userId: 'user-new', deviceId: 'device-new-1', hasSession: true },
      ])
      vi.mocked(cryptoService.distributeSenderKeyToDevices).mockResolvedValue({
        distributions: [], // empty
      })

      await useMessageStore.getState().distributeSenderKeyToNewMember(MOCK_PRIVATE_CHANNEL.id, 'user-new')

      expect(wsManager.send).not.toHaveBeenCalled()
    })
  })

  describe('pre-key replenishment', () => {
    it('replenishes pre-keys when unusedPreKeyCount < 30', async () => {
      setupSuccessfulGroupSendMocks()

      // Override to return low count
      vi.mocked(cryptoService.getPublicKeys).mockResolvedValue({
        masterVerifyPublicKey: [1],
        deviceId: 'device-self-1',
        deviceIdentityPublicKey: [4],
        signedPreKey: { keyId: 1, publicKey: [7], signature: [10] },
        unusedPreKeyCount: 10, // below threshold
      })

      vi.mocked(cryptoService.generateOneTimePreKeys).mockResolvedValue({
        startId: 1,
        keys: [{ keyId: 1, publicKey: [1, 2, 3] }],
      })

      vi.mocked(devicesApi.uploadKeyBundle).mockResolvedValue(undefined)

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')

      // Give the fire-and-forget replenishment time to run
      await vi.waitFor(() => {
        expect(cryptoService.generateOneTimePreKeys).toHaveBeenCalledWith(100)
      })

      await vi.waitFor(() => {
        expect(devicesApi.uploadKeyBundle).toHaveBeenCalledWith('device-self-1', {
          one_time_prekeys: [{ keyId: 1, publicKey: [1, 2, 3] }],
        })
      })
    })

    it('does NOT replenish when unusedPreKeyCount >= 30', async () => {
      setupSuccessfulGroupSendMocks()

      // Count is above threshold (50)
      vi.mocked(cryptoService.getPublicKeys).mockResolvedValue({
        masterVerifyPublicKey: [1],
        deviceId: 'device-self-1',
        deviceIdentityPublicKey: [4],
        signedPreKey: { keyId: 1, publicKey: [7], signature: [10] },
        unusedPreKeyCount: 50,
      })

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')

      // Wait a bit for the background task
      await new Promise((r) => setTimeout(r, 100))

      expect(cryptoService.generateOneTimePreKeys).not.toHaveBeenCalled()
    })
  })

  describe('handleServerError — STALE_SENDER_KEY retry', () => {
    it('marks key stale, increments epoch, and retries send on STALE_SENDER_KEY', async () => {
      setupSuccessfulGroupSendMocks()
      vi.mocked(cryptoService.markSenderKeyStale).mockResolvedValue({ marked: true })

      // First send to populate lastPrivateChannelSend
      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')
      vi.clearAllMocks()

      // Re-setup mocks for the retry send
      setupSuccessfulGroupSendMocks()
      vi.mocked(cryptoService.markSenderKeyStale).mockResolvedValue({ marked: true })

      // Simulate STALE_SENDER_KEY error from server
      await useMessageStore.getState().handleServerError('STALE_SENDER_KEY', 'sender key epoch is stale')

      // Should have marked key stale
      expect(cryptoService.markSenderKeyStale).toHaveBeenCalledWith(MOCK_PRIVATE_CHANNEL.id)

      // Should have retried the send
      expect(cryptoService.encryptGroup).toHaveBeenCalled()
    })

    it('does not retry on non-STALE_SENDER_KEY errors', async () => {
      setupSuccessfulGroupSendMocks()

      await useMessageStore.getState().sendMessage(MOCK_PRIVATE_CHANNEL.id, 'Hello!')
      vi.clearAllMocks()

      await useMessageStore.getState().handleServerError('UNKNOWN_ERROR', 'something else')

      expect(cryptoService.markSenderKeyStale).not.toHaveBeenCalled()
      expect(cryptoService.encryptGroup).not.toHaveBeenCalled()
    })
  })

  describe('message routing dispatch', () => {
    it('routes standard channel messages as plaintext', async () => {
      // Set up a standard channel
      useServerStore.setState({
        channels: new Map([
          [MOCK_PRIVATE_CHANNEL.id, MOCK_PRIVATE_CHANNEL],
          ['ch-standard', {
            id: 'ch-standard',
            server_id: 'server-1',
            name: 'general',
            channel_type: 'text' as const,
            encryption_mode: 'standard' as const,
            position: 1,
            topic: null,
            created_at: '2026-01-01T00:00:00Z',
          }],
        ]),
      })

      await useMessageStore.getState().sendMessage('ch-standard', 'Hello world')

      expect(wsManager.send).toHaveBeenCalledWith('message_send', {
        channel_id: 'ch-standard',
        content: 'Hello world',
      })

      // Should NOT have called group encryption
      expect(cryptoService.encryptGroup).not.toHaveBeenCalled()
    })

    it('routes standard channel MESSAGE_CREATE as plaintext without decrypt', () => {
      useMessageStore.getState().handleMessageCreate({
        id: 'msg-std-1',
        channel_id: 'ch-standard',
        sender_id: 'user-1',
        content: 'Plain text message',
        created_at: '2026-02-22T00:00:00Z',
      })

      const messages = useMessageStore.getState().getChannelMessages('ch-standard')
      expect(messages.length).toBe(1)
      expect(messages[0].content).toBe('Plain text message')

      // No crypto operations
      expect(cryptoService.decryptGroup).not.toHaveBeenCalled()
      expect(cryptoService.decryptDm).not.toHaveBeenCalled()
    })
  })
})
