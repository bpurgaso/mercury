import { describe, it, expect, beforeAll, vi } from 'vitest'
import { ensureSodium } from '../../../src/worker/crypto/utils'
import {
  generateDeviceIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
} from '../../../src/worker/crypto/keygen'
import {
  KeyBundleService,
  formatKeyBundleForUpload,
  type KeyBundleHttpClient,
  type KeyBundleUploadPayload,
  type KeyBundleResponsePayload,
} from '../../../src/worker/crypto/key-bundle-service'
import type { IKeyStore, SigningKeyPair, SignedPreKey, PreKey } from '../../../src/worker/crypto/types'

beforeAll(async () => {
  await ensureSodium()
})

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64'))
}

/** Create a minimal mock KeyStore with pre-populated key material */
function createMockKeyStore(
  deviceId: string,
  identityKP: SigningKeyPair,
  spk: SignedPreKey,
  otps: PreKey[],
): IKeyStore {
  return {
    getDeviceId: () => deviceId,
    getDeviceIdentityKeyPair: () => ({
      publicKey: new Uint8Array(identityKP.publicKey),
      privateKey: new Uint8Array(identityKP.privateKey),
    }),
    getSignedPreKey: () => ({
      keyId: spk.keyId,
      keyPair: {
        publicKey: new Uint8Array(spk.keyPair.publicKey),
        privateKey: new Uint8Array(spk.keyPair.privateKey),
      },
      signature: new Uint8Array(spk.signature),
      timestamp: spk.timestamp,
    }),
    getOneTimePreKey: (keyId: number) => {
      const pk = otps.find((p) => p.keyId === keyId)
      return pk
        ? {
            keyId: pk.keyId,
            keyPair: {
              publicKey: new Uint8Array(pk.keyPair.publicKey),
              privateKey: new Uint8Array(pk.keyPair.privateKey),
            },
          }
        : null
    },
    getUnusedOneTimePreKeyCount: () => otps.length,
    getUnusedOneTimePreKeys: () =>
      otps.map((pk) => ({
        keyId: pk.keyId,
        keyPair: {
          publicKey: new Uint8Array(pk.keyPair.publicKey),
          privateKey: new Uint8Array(pk.keyPair.privateKey),
        },
      })),
    getNextPreKeyId: () => (otps.length > 0 ? otps[otps.length - 1].keyId + 1 : 0),
    // Stubs for unused methods
    getMasterVerifyKeyPair: () => { throw new Error('not needed') },
    storeMasterVerifyKeyPair: () => {},
    storeDeviceIdentityKeyPair: () => {},
    storeSignedPreKey: () => {},
    storeOneTimePreKeys: () => {},
    markOneTimePreKeyUsed: () => {},
    getSession: () => null,
    storeSession: () => {},
    getAllSessionsForUser: () => new Map(),
    getSenderKey: () => null,
    storeSenderKey: () => {},
    getMediaKey: () => null,
    storeMediaKey: () => {},
    exportBackupBlob: () => new Uint8Array(),
    importBackupBlob: () => {},
    close: () => {},
  }
}

describe('KeyBundleService.uploadKeyBundle', () => {
  it('calls PUT /devices/:id/keys with correctly formatted payload', async () => {
    const identity = await generateDeviceIdentityKeyPair()
    const spk = await generateSignedPreKey(identity, 1)
    const otps = await generateOneTimePreKeys(0, 5)
    const deviceId = 'test-device-uuid'

    const mockClient: KeyBundleHttpClient = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
    }

    const keyStore = createMockKeyStore(deviceId, identity, spk, otps)
    const service = new KeyBundleService(mockClient, keyStore)

    await service.uploadKeyBundle()

    // Verify PUT was called with the right endpoint
    expect(mockClient.put).toHaveBeenCalledTimes(1)
    const [path, body] = (mockClient.put as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe(`/devices/${deviceId}/keys`)

    // Verify payload structure
    const payload = body as KeyBundleUploadPayload
    expect(payload.identity_key).toBe(toBase64(identity.publicKey))
    expect(payload.signed_prekey).toBe(toBase64(spk.keyPair.publicKey))
    expect(payload.signed_prekey_id).toBe(1)
    expect(payload.prekey_signature).toBe(toBase64(spk.signature))
    expect(payload.one_time_prekeys).toHaveLength(5)

    // Verify OTP format
    for (let i = 0; i < 5; i++) {
      expect(payload.one_time_prekeys[i].key_id).toBe(i)
      expect(payload.one_time_prekeys[i].prekey).toBe(toBase64(otps[i].keyPair.publicKey))
    }
  })

  it('handles empty one-time pre-key list', async () => {
    const identity = await generateDeviceIdentityKeyPair()
    const spk = await generateSignedPreKey(identity, 1)

    const mockClient: KeyBundleHttpClient = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
    }

    const keyStore = createMockKeyStore('dev-1', identity, spk, [])
    const service = new KeyBundleService(mockClient, keyStore)

    await service.uploadKeyBundle()

    const [, body] = (mockClient.put as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((body as KeyBundleUploadPayload).one_time_prekeys).toHaveLength(0)
  })
})

describe('KeyBundleService.fetchKeyBundle', () => {
  it('calls GET /users/:userId/devices/:deviceId/keys and parses response', async () => {
    const identity = await generateDeviceIdentityKeyPair()
    const spk = await generateSignedPreKey(identity, 5)
    const otp = (await generateOneTimePreKeys(42, 1))[0]

    const serverResponse: KeyBundleResponsePayload = {
      identity_key: toBase64(identity.publicKey),
      signed_prekey: toBase64(spk.keyPair.publicKey),
      signed_prekey_id: 5,
      prekey_signature: toBase64(spk.signature),
      one_time_prekey: {
        key_id: 42,
        prekey: toBase64(otp.keyPair.publicKey),
      },
    }

    const mockClient: KeyBundleHttpClient = {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(serverResponse),
    }

    // KeyStore is not used by fetchKeyBundle, pass a minimal stub
    const keyStore = createMockKeyStore('unused', identity, spk, [])
    const service = new KeyBundleService(mockClient, keyStore)

    const bundle = await service.fetchKeyBundle('user-123', 'device-456')

    // Verify GET was called with correct endpoint
    expect(mockClient.get).toHaveBeenCalledWith('/users/user-123/devices/device-456/keys')

    // Verify parsed bundle
    expect(bundle.identityKey).toEqual(identity.publicKey)
    expect(bundle.signedPreKey.keyId).toBe(5)
    expect(bundle.signedPreKey.publicKey).toEqual(spk.keyPair.publicKey)
    expect(bundle.signedPreKey.signature).toEqual(spk.signature)
    expect(bundle.oneTimePreKey).toBeDefined()
    expect(bundle.oneTimePreKey!.keyId).toBe(42)
    expect(bundle.oneTimePreKey!.publicKey).toEqual(otp.keyPair.publicKey)
  })

  it('handles response without one-time pre-key', async () => {
    const identity = await generateDeviceIdentityKeyPair()
    const spk = await generateSignedPreKey(identity, 1)

    const serverResponse: KeyBundleResponsePayload = {
      identity_key: toBase64(identity.publicKey),
      signed_prekey: toBase64(spk.keyPair.publicKey),
      signed_prekey_id: 1,
      prekey_signature: toBase64(spk.signature),
      // no one_time_prekey
    }

    const mockClient: KeyBundleHttpClient = {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(serverResponse),
    }

    const keyStore = createMockKeyStore('unused', identity, spk, [])
    const service = new KeyBundleService(mockClient, keyStore)

    const bundle = await service.fetchKeyBundle('user-1', 'device-1')
    expect(bundle.oneTimePreKey).toBeUndefined()
  })
})

describe('formatKeyBundleForUpload', () => {
  it('formats generateAllKeys output for server upload', async () => {
    const identity = await generateDeviceIdentityKeyPair()
    const spk = await generateSignedPreKey(identity, 1)
    const otps = await generateOneTimePreKeys(0, 3)

    const generated = {
      deviceIdentityPublicKey: Array.from(identity.publicKey),
      signedPreKey: {
        keyId: spk.keyId,
        publicKey: Array.from(spk.keyPair.publicKey),
        signature: Array.from(spk.signature),
      },
      oneTimePreKeys: otps.map((pk) => ({
        keyId: pk.keyId,
        publicKey: Array.from(pk.keyPair.publicKey),
      })),
    }

    const payload = formatKeyBundleForUpload(generated)

    expect(payload.identity_key).toBe(toBase64(identity.publicKey))
    expect(payload.signed_prekey).toBe(toBase64(spk.keyPair.publicKey))
    expect(payload.signed_prekey_id).toBe(1)
    expect(payload.prekey_signature).toBe(toBase64(spk.signature))
    expect(payload.one_time_prekeys).toHaveLength(3)
    expect(payload.one_time_prekeys[0].key_id).toBe(0)
    expect(fromBase64(payload.one_time_prekeys[0].prekey)).toEqual(otps[0].keyPair.publicKey)
  })
})
