// Key bundle upload/fetch service for X3DH key exchange.
// Handles formatting between internal crypto types and server wire format,
// and provides HTTP operations via an injectable client interface.

import type { KeyBundle, IKeyStore } from './types'
import { identityKeyToX25519, memzero } from './utils'

// --- Wire format types (server JSON API) ---

/** Format sent to PUT /devices/:deviceId/keys */
export interface KeyBundleUploadPayload {
  identity_key: string // base64 Ed25519 public key
  signed_prekey: string // base64 X25519 public key
  signed_prekey_id: number
  prekey_signature: string // base64 Ed25519 signature
  one_time_prekeys: Array<{
    key_id: number
    prekey: string // base64 X25519 public key
  }>
}

/** Format returned by GET /users/:userId/devices/:deviceId/keys */
export interface KeyBundleResponsePayload {
  identity_key: string // base64 Ed25519 public key
  signed_prekey: string // base64 X25519 public key
  signed_prekey_id: number
  prekey_signature: string // base64 Ed25519 signature
  one_time_prekey?: {
    key_id: number
    prekey: string // base64 X25519 public key
  }
}

/** Injectable HTTP client interface for testability */
export interface KeyBundleHttpClient {
  put(path: string, body: unknown): Promise<void>
  get<T>(path: string): Promise<T>
}

// --- Encoding helpers ---

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64'))
}

// --- Service ---

export class KeyBundleService {
  constructor(
    private httpClient: KeyBundleHttpClient,
    private keyStore: IKeyStore,
  ) {}

  /**
   * Upload the local device's key bundle to the server.
   * Reads keys from KeyStore, formats them for the server, and calls
   * PUT /devices/:deviceId/keys.
   */
  async uploadKeyBundle(): Promise<void> {
    const deviceId = this.keyStore.getDeviceId()
    const deviceIdentity = this.keyStore.getDeviceIdentityKeyPair()
    const spk = this.keyStore.getSignedPreKey()

    // Fetch all unused one-time pre-keys in a single query
    const unusedPreKeys = this.keyStore.getUnusedOneTimePreKeys()
    const oneTimePreKeys = unusedPreKeys.map((pk) => {
      const entry = { key_id: pk.keyId, prekey: toBase64(pk.keyPair.publicKey) }
      memzero(pk.keyPair.privateKey)
      return entry
    })

    const payload: KeyBundleUploadPayload = {
      identity_key: toBase64(deviceIdentity.publicKey),
      signed_prekey: toBase64(spk.keyPair.publicKey),
      signed_prekey_id: spk.keyId,
      prekey_signature: toBase64(spk.signature),
      one_time_prekeys: oneTimePreKeys,
    }

    // Zero private key copies retrieved from store
    memzero(deviceIdentity.privateKey)
    memzero(spk.keyPair.privateKey)

    await this.httpClient.put(`/devices/${deviceId}/keys`, payload)
  }

  /**
   * Fetch a recipient's key bundle for X3DH session establishment.
   * Calls GET /users/:userId/devices/:deviceId/keys and parses the
   * response into the internal KeyBundle type.
   */
  async fetchKeyBundle(userId: string, deviceId: string): Promise<KeyBundle> {
    const response = await this.httpClient.get<KeyBundleResponsePayload>(
      `/users/${userId}/devices/${deviceId}/keys`,
    )

    const bundle: KeyBundle = {
      identityKey: fromBase64(response.identity_key),
      signedPreKey: {
        keyId: response.signed_prekey_id,
        publicKey: fromBase64(response.signed_prekey),
        signature: fromBase64(response.prekey_signature),
      },
    }

    if (response.one_time_prekey) {
      bundle.oneTimePreKey = {
        keyId: response.one_time_prekey.key_id,
        publicKey: fromBase64(response.one_time_prekey.prekey),
      }
    }

    return bundle
  }
}

/**
 * Format the output of crypto:generateAllKeys for key bundle upload.
 * Converts the worker's public key material into the server wire format.
 *
 * This is a standalone function (no KeyStore dependency) for use in the
 * registration flow where keys are generated and immediately uploaded.
 */
export function formatKeyBundleForUpload(generatedKeys: {
  deviceIdentityPublicKey: number[] // Ed25519 public key as array
  signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
  oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
}): KeyBundleUploadPayload {
  return {
    identity_key: toBase64(new Uint8Array(generatedKeys.deviceIdentityPublicKey)),
    signed_prekey: toBase64(new Uint8Array(generatedKeys.signedPreKey.publicKey)),
    signed_prekey_id: generatedKeys.signedPreKey.keyId,
    prekey_signature: toBase64(new Uint8Array(generatedKeys.signedPreKey.signature)),
    one_time_prekeys: generatedKeys.oneTimePreKeys.map((pk) => ({
      key_id: pk.keyId,
      prekey: toBase64(new Uint8Array(pk.publicKey)),
    })),
  }
}
