// Signed device list creation, verification, and TOFU identity management.
// See client-spec.md §4.2 and server-spec.md §6.2 for the identity model.

import { ensureSodium, sign, verify } from './utils'
import type {
  SigningKeyPair,
  DeviceListEntry,
  DeviceListPayload,
  SignedDeviceList,
  TofuResult,
  IKeyStore,
} from './types'

export class DeviceListSignatureError extends Error {
  constructor(message: string = 'Device list signature verification failed') {
    super(message)
    this.name = 'DeviceListSignatureError'
  }
}

/**
 * Create a signed device list. The list is serialized as canonical JSON
 * and signed with the user's Ed25519 master verify key.
 */
export async function createSignedDeviceList(
  masterKeyPair: SigningKeyPair,
  devices: DeviceListEntry[],
): Promise<SignedDeviceList> {
  await ensureSodium()

  const payload: DeviceListPayload = {
    devices,
    timestamp: Date.now(),
  }

  // Canonical JSON: keys sorted alphabetically at all levels.
  // IMPORTANT: The signed_list bytes produced here are stored and served by the
  // server verbatim. Verifying clients must use the raw signed bytes for
  // signature verification — never re-serialize the parsed JSON, as even minor
  // differences in serialization would invalidate the signature.
  const json = JSON.stringify(payload, (_, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(value).sort()) {
        sorted[key] = value[key]
      }
      return sorted
    }
    return value
  })
  const signed_list = new TextEncoder().encode(json)
  const signature = sign(signed_list, masterKeyPair.privateKey)

  return { signed_list, signature }
}

/**
 * Verify a signed device list against a master verify public key.
 * Returns the parsed device list payload or throws on invalid signature.
 */
export async function verifySignedDeviceList(
  masterVerifyPublicKey: Uint8Array,
  signedList: Uint8Array,
  signature: Uint8Array,
): Promise<DeviceListPayload> {
  await ensureSodium()

  if (!verify(signedList, signature, masterVerifyPublicKey)) {
    throw new DeviceListSignatureError()
  }

  const json = new TextDecoder().decode(signedList)
  const parsed = JSON.parse(json)

  // Validate structure
  if (!Array.isArray(parsed.devices)) {
    throw new DeviceListSignatureError('Invalid device list: missing devices array')
  }
  if (typeof parsed.timestamp !== 'number') {
    throw new DeviceListSignatureError('Invalid device list: missing timestamp')
  }
  for (const device of parsed.devices) {
    if (typeof device.device_id !== 'string' || typeof device.identity_key !== 'string') {
      throw new DeviceListSignatureError('Invalid device list: malformed device entry')
    }
  }

  return parsed as DeviceListPayload
}

/**
 * Verify a user's identity using Trust-On-First-Use (TOFU).
 *
 * - First encounter: store the master verify key, return trusted + firstSeen
 * - Same key: return trusted
 * - Different key: return untrusted with both keys for the caller to handle
 */
export function verifyTrustedIdentity(
  userId: string,
  masterVerifyKey: Uint8Array,
  keyStore: IKeyStore,
): TofuResult {
  const stored = keyStore.getTrustedIdentity(userId)

  if (stored === null) {
    // First time seeing this user — trust on first use
    keyStore.storeTrustedIdentity(userId, masterVerifyKey)
    return { trusted: true, firstSeen: true }
  }

  // Compare stored key with the new one
  if (stored.length === masterVerifyKey.length && constantTimeEqual(stored, masterVerifyKey)) {
    return { trusted: true, firstSeen: false }
  }

  // Key mismatch — identity has changed
  return {
    trusted: false,
    previousKey: stored,
    newKey: new Uint8Array(masterVerifyKey),
  }
}

/** Constant-time comparison of two byte arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}

// --- Server interaction ---

/**
 * Upload a signed device list to the server.
 * PUT /users/me/device-list
 */
export async function uploadDeviceList(
  baseUrl: string,
  token: string,
  signedDeviceList: SignedDeviceList,
  masterVerifyPublicKey: Uint8Array,
): Promise<void> {
  const body = {
    signed_list: Buffer.from(signedDeviceList.signed_list).toString('base64'),
    master_verify_key: Buffer.from(masterVerifyPublicKey).toString('base64'),
    signature: Buffer.from(signedDeviceList.signature).toString('base64'),
  }

  const res = await fetch(`${baseUrl}/users/me/device-list`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Failed to upload device list: ${res.status} ${res.statusText}`)
  }
}

/**
 * Fetch and verify a user's device list from the server.
 * GET /users/{userId}/device-list
 */
export async function fetchDeviceList(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<{ payload: DeviceListPayload; masterVerifyKey: Uint8Array } | null> {
  const res = await fetch(`${baseUrl}/users/${userId}/device-list`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch device list: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()
  const signedList = new Uint8Array(Buffer.from(data.signed_list, 'base64'))
  const masterVerifyKey = new Uint8Array(Buffer.from(data.master_verify_key, 'base64'))
  const signature = new Uint8Array(Buffer.from(data.signature, 'base64'))

  const payload = await verifySignedDeviceList(masterVerifyKey, signedList, signature)
  return { payload, masterVerifyKey }
}
