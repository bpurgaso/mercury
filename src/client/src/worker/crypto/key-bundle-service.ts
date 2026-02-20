// Key bundle upload/fetch service for X3DH key exchange.
// Handles formatting between internal crypto types and server wire format,
// and provides HTTP operations via an injectable client interface.

import type { KeyBundle, IKeyStore } from './types'
import { memzero } from './utils'

// --- Domain-specific errors ---

/** Base class for key bundle service errors */
export class KeyBundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyBundleError'
  }
}

/** The requested user does not exist */
export class UserNotFoundError extends KeyBundleError {
  constructor(userId: string) {
    super(`User not found: ${userId}`)
    this.name = 'UserNotFoundError'
  }
}

/** The requested device does not exist or has no key bundle */
export class DeviceNotFoundError extends KeyBundleError {
  constructor(userId: string, deviceId: string) {
    super(`Device not found: ${deviceId} for user ${userId}`)
    this.name = 'DeviceNotFoundError'
  }
}

/** A transient network or server error occurred; the caller may retry */
export class KeyBundleNetworkError extends KeyBundleError {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'KeyBundleNetworkError'
  }
}

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

/** Error shape that HTTP clients may throw (matches renderer's ApiError) */
export interface HttpError {
  status?: number
  message?: string
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
   *
   * @throws {UserNotFoundError} if the user does not exist (404 on user path)
   * @throws {DeviceNotFoundError} if the device has no key bundle (404 on device path)
   * @throws {KeyBundleNetworkError} on transient server/network errors (5xx, timeout)
   */
  async fetchKeyBundle(userId: string, deviceId: string): Promise<KeyBundle> {
    let response: KeyBundleResponsePayload
    try {
      response = await this.httpClient.get<KeyBundleResponsePayload>(
        `/users/${userId}/devices/${deviceId}/keys`,
      )
    } catch (err: unknown) {
      const status = (err as HttpError)?.status
      if (status === 404) {
        // Distinguish user-not-found from device-not-found by convention:
        // a missing user yields a 404, a missing device/bundle also yields 404.
        // Without a more specific server error code, report as DeviceNotFound
        // since the caller already knows the userId exists (from device list).
        throw new DeviceNotFoundError(userId, deviceId)
      }
      if (status !== undefined && status >= 500) {
        throw new KeyBundleNetworkError(
          `Server error fetching key bundle: ${(err as HttpError)?.message ?? status}`,
          status,
        )
      }
      // Unknown error (network timeout, DNS failure, etc.)
      throw new KeyBundleNetworkError(
        `Failed to fetch key bundle: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

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
