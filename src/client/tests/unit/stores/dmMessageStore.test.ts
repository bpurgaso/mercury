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
    getPublicKeys: vi.fn().mockResolvedValue({ unusedPreKeyCount: 50, deviceId: 'device-self-1' }),
    generateOneTimePreKeys: vi.fn(),
  },
  initCryptoPort: vi.fn(),
}))

// Mock the dmChannelStore
vi.mock('../../../src/renderer/stores/dmChannelStore', () => ({
  useDmChannelStore: {
    getState: vi.fn(() => ({
      dmChannels: new Map([
        ['dm-1', {
          id: 'dm-1',
          recipient: { id: 'user-bob', username: 'bob', display_name: 'Bob', avatar_url: null },
          created_at: '2026-01-01T00:00:00Z',
        }],
      ]),
    })),
  },
}))

import { useMessageStore, setIdentityWarningCallback } from '../../../src/renderer/stores/messageStore'
import { wsManager } from '../../../src/renderer/services/websocket'
import { cryptoService } from '../../../src/renderer/services/crypto'
import { keyBundles as keyBundlesApi, deviceList as deviceListApi } from '../../../src/renderer/services/api'
import type { Message } from '../../../src/renderer/types/models'

// Helper: base64 encode a Uint8Array
function toBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
}

// Shared test fixtures
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

function setupSuccessfulSendMocks(): void {
  vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)

  vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
    verified: true,
    firstSeen: true,
    devices: [{ device_id: 'device-bob-1', identity_key: toBase64(new Uint8Array(32).fill(0x11)) }],
  })

  vi.mocked(keyBundlesApi.fetchAllForUser).mockResolvedValue(MOCK_KEY_BUNDLES)

  vi.mocked(cryptoService.hasSessions).mockResolvedValue([
    { userId: 'user-bob', deviceId: 'device-bob-1', hasSession: false },
  ])

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

  vi.mocked(cryptoService.storeMessage).mockResolvedValue({ stored: true })
}

describe('messageStore DM operations', () => {
  beforeEach(() => {
    useMessageStore.setState({ messages: new Map(), dmHistoryLoaded: new Set() })
    vi.clearAllMocks()
  })

  describe('handleMessageCreate for DMs', () => {
    it('decrypts DM message via worker and adds to store', async () => {
      vi.mocked(cryptoService.decryptDm).mockResolvedValue({
        plaintext: 'Hello from Alice!',
        messageId: 'msg-1',
      })

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-1',
        dm_channel_id: 'dm-1',
        sender_id: 'user-alice',
        sender_device_id: 'device-alice-1',
        ciphertext: new Uint8Array([1, 2, 3]),
        created_at: '2026-02-22T00:00:00Z',
      })

      // Wait for async decrypt
      await vi.waitFor(() => {
        expect(cryptoService.decryptDm).toHaveBeenCalledWith({
          messageId: 'msg-1',
          dmChannelId: 'dm-1',
          senderId: 'user-alice',
          senderDeviceId: 'device-alice-1',
          ciphertext: [1, 2, 3],
          x3dhHeader: undefined,
          createdAt: expect.any(Number),
        })
      })

      await vi.waitFor(() => {
        const messages = useMessageStore.getState().getChannelMessages('dm-1')
        expect(messages.length).toBe(1)
        expect(messages[0].content).toBe('Hello from Alice!')
        expect(messages[0].dm_channel_id).toBe('dm-1')
      })
    })

    it('shows placeholder on decrypt failure', async () => {
      vi.mocked(cryptoService.decryptDm).mockResolvedValue({
        error: 'DECRYPT_FAILED',
      })

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-2',
        dm_channel_id: 'dm-1',
        sender_id: 'user-alice',
        sender_device_id: 'device-alice-1',
        ciphertext: new Uint8Array([1, 2, 3]),
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        const messages = useMessageStore.getState().getChannelMessages('dm-1')
        expect(messages.length).toBe(1)
        expect(messages[0].content).toBeNull()
        expect(messages[0].decrypt_error).toBe('DECRYPT_FAILED')
      })
    })

    it('shows placeholder when no session exists', async () => {
      vi.mocked(cryptoService.decryptDm).mockResolvedValue({
        error: 'NO_SESSION',
      })

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-3',
        dm_channel_id: 'dm-1',
        sender_id: 'user-alice',
        sender_device_id: 'device-alice-1',
        ciphertext: new Uint8Array([1, 2, 3]),
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        const messages = useMessageStore.getState().getChannelMessages('dm-1')
        expect(messages.length).toBe(1)
        expect(messages[0].decrypt_error).toBe('NO_SESSION')
      })
    })

    it('passes x3dh_header to worker when present', async () => {
      vi.mocked(cryptoService.decryptDm).mockResolvedValue({
        plaintext: 'First message!',
        messageId: 'msg-4',
      })

      useMessageStore.getState().handleMessageCreate({
        id: 'msg-4',
        dm_channel_id: 'dm-1',
        sender_id: 'user-alice',
        sender_device_id: 'device-alice-1',
        ciphertext: new Uint8Array([1, 2, 3]),
        x3dh_header: {
          sender_identity_key: new Uint8Array(32).fill(0xaa),
          ephemeral_key: new Uint8Array(32).fill(0xbb),
          prekey_id: 42,
        },
        created_at: '2026-02-22T00:00:00Z',
      })

      await vi.waitFor(() => {
        expect(cryptoService.decryptDm).toHaveBeenCalledWith(
          expect.objectContaining({
            x3dhHeader: {
              senderIdentityKey: expect.any(Array),
              ephemeralKey: expect.any(Array),
              prekeyId: 42,
            },
          }),
        )
      })
    })
  })

  describe('handleMessageCreate for standard channels', () => {
    it('handles standard channel messages as plaintext', () => {
      useMessageStore.getState().handleMessageCreate({
        id: 'msg-std-1',
        channel_id: 'channel-1',
        sender_id: 'user-1',
        content: 'Plain text message',
        created_at: '2026-02-22T00:00:00Z',
      })

      const messages = useMessageStore.getState().getChannelMessages('channel-1')
      expect(messages.length).toBe(1)
      expect(messages[0].content).toBe('Plain text message')
      expect(messages[0].channel_id).toBe('channel-1')
    })
  })

  describe('sendMessage for DMs', () => {
    it('encrypts via worker and sends binary frame for DM channels', async () => {
      setupSuccessfulSendMocks()

      await useMessageStore.getState().sendMessage('dm-1', 'Hello Bob!')

      // Should have fetched the device list first
      expect(deviceListApi.fetch).toHaveBeenCalledWith('user-bob')

      // Should have verified the device list
      expect(cryptoService.verifyDeviceList).toHaveBeenCalledWith(
        'user-bob',
        expect.any(Array),
        expect.any(Array),
        expect.any(Array),
      )

      // Should have called establishAndEncryptDm (no existing session)
      expect(cryptoService.establishAndEncryptDm).toHaveBeenCalledWith(
        'user-bob',
        expect.any(Array), // masterVerifyKey
        expect.arrayContaining([
          expect.objectContaining({ deviceId: 'device-bob-1' }),
        ]),
        'Hello Bob!',
      )

      // Should have sent via WebSocket
      expect(wsManager.send).toHaveBeenCalledWith('message_send', {
        dm_channel_id: 'dm-1',
        recipients: expect.arrayContaining([
          expect.objectContaining({ device_id: 'device-bob-1' }),
        ]),
      })

      // Should have stored sender's copy
      expect(cryptoService.storeMessage).toHaveBeenCalled()
    })

    it('rejects send on invalid device list signature', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: false,
        error: 'SIGNATURE_INVALID',
      })

      await expect(
        useMessageStore.getState().sendMessage('dm-1', 'Hello Bob!'),
      ).rejects.toThrow('Device list signature verification failed')

      // Should NOT have fetched key bundles or sent via WS
      expect(keyBundlesApi.fetchAllForUser).not.toHaveBeenCalled()
      expect(wsManager.send).not.toHaveBeenCalled()
    })

    it('aborts send on TOFU rejection (identity changed, user cancels)', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: false,
        error: 'IDENTITY_CHANGED',
        previousKey: [1, 2, 3],
        newKey: [4, 5, 6],
        devices: [{ device_id: 'device-bob-1', identity_key: 'a' }],
      })

      // User rejects identity change
      setIdentityWarningCallback(async () => false)

      await expect(
        useMessageStore.getState().sendMessage('dm-1', 'Hello Bob!'),
      ).rejects.toThrow('identity verification failed')

      expect(wsManager.send).not.toHaveBeenCalled()

      // Clean up callback
      setIdentityWarningCallback(null as unknown as () => Promise<boolean>)
    })

    it('proceeds on TOFU approval (identity changed, user approves)', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: false,
        error: 'IDENTITY_CHANGED',
        previousKey: [1, 2, 3],
        newKey: [4, 5, 6],
        devices: [{ device_id: 'device-bob-1', identity_key: toBase64(new Uint8Array(32).fill(0x11)) }],
      })

      // User approves identity change
      setIdentityWarningCallback(async () => true)
      vi.mocked(cryptoService.acceptIdentityChange).mockResolvedValue({ accepted: true })

      vi.mocked(keyBundlesApi.fetchAllForUser).mockResolvedValue(MOCK_KEY_BUNDLES)
      vi.mocked(cryptoService.hasSessions).mockResolvedValue([
        { userId: 'user-bob', deviceId: 'device-bob-1', hasSession: false },
      ])
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
      vi.mocked(cryptoService.storeMessage).mockResolvedValue({ stored: true })

      await useMessageStore.getState().sendMessage('dm-1', 'Hello Bob!')

      // Should have accepted the identity change
      expect(cryptoService.acceptIdentityChange).toHaveBeenCalledWith('user-bob', [4, 5, 6])

      // Should have proceeded to send
      expect(wsManager.send).toHaveBeenCalled()

      // Clean up callback
      setIdentityWarningCallback(null as unknown as () => Promise<boolean>)
    })

    it('filters key bundles to only verified device IDs', async () => {
      vi.mocked(deviceListApi.fetch).mockResolvedValue(MOCK_DEVICE_LIST_RESPONSE)

      // Verified list only includes device-bob-1
      vi.mocked(cryptoService.verifyDeviceList).mockResolvedValue({
        verified: true,
        firstSeen: true,
        devices: [{ device_id: 'device-bob-1', identity_key: 'a' }],
      })

      // Server returns two devices (one is not in the verified list)
      vi.mocked(keyBundlesApi.fetchAllForUser).mockResolvedValue({
        devices: [
          ...MOCK_KEY_BUNDLES.devices,
          {
            device_id: 'device-bob-UNVERIFIED',
            device_name: 'Evil Device',
            identity_key: toBase64(new Uint8Array(32).fill(0xff)),
            signed_prekey: toBase64(new Uint8Array(32).fill(0xee)),
            signed_prekey_id: 2,
            prekey_signature: toBase64(new Uint8Array(64).fill(0xdd)),
          },
        ],
      })

      vi.mocked(cryptoService.hasSessions).mockResolvedValue([
        { userId: 'user-bob', deviceId: 'device-bob-1', hasSession: false },
      ])

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

      vi.mocked(cryptoService.storeMessage).mockResolvedValue({ stored: true })

      await useMessageStore.getState().sendMessage('dm-1', 'Hello Bob!')

      // hasSessions should only be called with the verified device
      expect(cryptoService.hasSessions).toHaveBeenCalledWith([
        { userId: 'user-bob', deviceId: 'device-bob-1' },
      ])

      // The unverified device should NOT appear in encrypt calls
      expect(cryptoService.establishAndEncryptDm).toHaveBeenCalledWith(
        'user-bob',
        expect.any(Array),
        expect.not.arrayContaining([
          expect.objectContaining({ deviceId: 'device-bob-UNVERIFIED' }),
        ]),
        'Hello Bob!',
      )
    })

    it('stores plaintext before sending via WebSocket (store-before-send)', async () => {
      setupSuccessfulSendMocks()

      const callOrder: string[] = []
      vi.mocked(cryptoService.storeMessage).mockImplementation(async () => {
        callOrder.push('store')
        return { stored: true }
      })
      vi.mocked(wsManager.send).mockImplementation((..._args: unknown[]) => {
        callOrder.push('send')
      })

      await useMessageStore.getState().sendMessage('dm-1', 'Hello Bob!')

      expect(callOrder.indexOf('store')).toBeLessThan(callOrder.indexOf('send'))
    })

    it('sends standard channel message as plaintext', async () => {
      await useMessageStore.getState().sendMessage('channel-1', 'Hello world')

      expect(wsManager.send).toHaveBeenCalledWith('message_send', {
        channel_id: 'channel-1',
        content: 'Hello world',
      })
    })
  })

  describe('fetchDmHistory', () => {
    it('loads local messages first, then catches up from server', async () => {
      // Mock local messages
      vi.mocked(cryptoService.getMessages).mockResolvedValue([
        { id: 'local-1', channelId: 'dm-1', senderId: 'user-bob', content: 'Local msg 1', createdAt: 1000, receivedAt: 1001 },
        { id: 'local-2', channelId: 'dm-1', senderId: 'self', content: 'Local msg 2', createdAt: 2000, receivedAt: 2001 },
      ])

      // Mock no new server messages
      const { dm: dmApi } = await import('../../../src/renderer/services/api')
      vi.mocked(dmApi.getHistory).mockResolvedValue([])

      await useMessageStore.getState().fetchDmHistory('dm-1')

      // Local messages should be loaded
      const messages = useMessageStore.getState().getChannelMessages('dm-1')
      expect(messages.length).toBe(2)
      expect(messages[0].content).toBe('Local msg 1')
      expect(messages[1].content).toBe('Local msg 2')

      // dmHistoryLoaded should be set
      expect(useMessageStore.getState().dmHistoryLoaded.has('dm-1')).toBe(true)
    })
  })
})
