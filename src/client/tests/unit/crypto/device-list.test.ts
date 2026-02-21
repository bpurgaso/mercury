import { describe, it, expect, beforeAll } from 'vitest'
import { ensureSodium, generateEd25519KeyPair } from '../../../src/worker/crypto/utils'
import {
  createSignedDeviceList,
  verifySignedDeviceList,
  DeviceListSignatureError,
} from '../../../src/worker/crypto/device-list'
import type { DeviceListEntry } from '../../../src/worker/crypto/types'

beforeAll(async () => {
  await ensureSodium()
})

describe('createSignedDeviceList + verifySignedDeviceList', () => {
  it('creates a signed device list that verifies successfully', async () => {
    const masterKP = generateEd25519KeyPair()
    const devices: DeviceListEntry[] = [
      { device_id: 'device-1', identity_key: Buffer.from(new Uint8Array(32)).toString('base64') },
    ]

    const signed = await createSignedDeviceList(masterKP, devices)

    expect(signed.signed_list).toBeInstanceOf(Uint8Array)
    expect(signed.signature).toBeInstanceOf(Uint8Array)
    expect(signed.signature.length).toBe(64) // Ed25519 signature

    const payload = await verifySignedDeviceList(
      masterKP.publicKey,
      signed.signed_list,
      signed.signature,
    )
    expect(payload.devices).toHaveLength(1)
    expect(payload.devices[0].device_id).toBe('device-1')
    expect(payload.timestamp).toBeGreaterThan(0)
  })

  it('verifies a list with multiple devices', async () => {
    const masterKP = generateEd25519KeyPair()
    const devices: DeviceListEntry[] = [
      { device_id: 'dev-1', identity_key: 'key1base64' },
      { device_id: 'dev-2', identity_key: 'key2base64' },
      { device_id: 'dev-3', identity_key: 'key3base64' },
    ]

    const signed = await createSignedDeviceList(masterKP, devices)
    const payload = await verifySignedDeviceList(
      masterKP.publicKey,
      signed.signed_list,
      signed.signature,
    )
    expect(payload.devices).toHaveLength(3)
  })

  it('verifies an empty device list', async () => {
    const masterKP = generateEd25519KeyPair()
    const signed = await createSignedDeviceList(masterKP, [])
    const payload = await verifySignedDeviceList(
      masterKP.publicKey,
      signed.signed_list,
      signed.signature,
    )
    expect(payload.devices).toHaveLength(0)
  })

  it('fails verification when the list content is tampered', async () => {
    const masterKP = generateEd25519KeyPair()
    const devices: DeviceListEntry[] = [
      { device_id: 'device-1', identity_key: 'keybase64' },
    ]

    const signed = await createSignedDeviceList(masterKP, devices)

    // Tamper with the signed list content
    const tampered = new Uint8Array(signed.signed_list)
    tampered[10] = tampered[10] ^ 0xff

    await expect(
      verifySignedDeviceList(masterKP.publicKey, tampered, signed.signature),
    ).rejects.toThrow(DeviceListSignatureError)
  })

  it('fails verification when the signature is tampered', async () => {
    const masterKP = generateEd25519KeyPair()
    const devices: DeviceListEntry[] = [
      { device_id: 'device-1', identity_key: 'keybase64' },
    ]

    const signed = await createSignedDeviceList(masterKP, devices)

    // Tamper with the signature
    const tamperedSig = new Uint8Array(signed.signature)
    tamperedSig[0] = tamperedSig[0] ^ 0xff

    await expect(
      verifySignedDeviceList(masterKP.publicKey, signed.signed_list, tamperedSig),
    ).rejects.toThrow(DeviceListSignatureError)
  })

  it('fails verification with a different master key', async () => {
    const masterKP = generateEd25519KeyPair()
    const wrongKP = generateEd25519KeyPair()
    const devices: DeviceListEntry[] = [
      { device_id: 'device-1', identity_key: 'keybase64' },
    ]

    const signed = await createSignedDeviceList(masterKP, devices)

    await expect(
      verifySignedDeviceList(wrongKP.publicKey, signed.signed_list, signed.signature),
    ).rejects.toThrow(DeviceListSignatureError)
  })
})
