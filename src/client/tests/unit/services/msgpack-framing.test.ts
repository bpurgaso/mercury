import { describe, it, expect } from 'vitest'
import { encode, decode } from '@msgpack/msgpack'

describe('MessagePack framing', () => {
  describe('encode/decode round-trip', () => {
    it('round-trips a message_send DM payload with binary ciphertext', () => {
      const ciphertext = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd])
      const payload = {
        op: 'message_send',
        d: {
          dm_channel_id: 'abc-123',
          recipients: [
            {
              device_id: 'device-001',
              ciphertext,
              x3dh_header: {
                sender_identity_key: new Uint8Array(32).fill(0xaa),
                ephemeral_key: new Uint8Array(32).fill(0xbb),
                prekey_id: 42,
              },
            },
          ],
        },
      }

      const encoded = encode(payload)
      expect(encoded).toBeInstanceOf(Uint8Array)

      const decoded = decode(encoded) as typeof payload
      expect(decoded.op).toBe('message_send')
      expect(decoded.d.dm_channel_id).toBe('abc-123')
      expect(decoded.d.recipients).toHaveLength(1)

      const recipient = decoded.d.recipients[0]
      expect(recipient.device_id).toBe('device-001')
      // Ciphertext should be decoded as Uint8Array (MessagePack bin type)
      expect(recipient.ciphertext).toBeInstanceOf(Uint8Array)
      expect(Array.from(recipient.ciphertext)).toEqual([0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd])

      // x3dh_header binary fields
      expect(recipient.x3dh_header.sender_identity_key).toBeInstanceOf(Uint8Array)
      expect(recipient.x3dh_header.sender_identity_key.length).toBe(32)
      expect(recipient.x3dh_header.prekey_id).toBe(42)
    })

    it('round-trips a MESSAGE_CREATE server event with binary fields', () => {
      const serverEvent = {
        t: 'MESSAGE_CREATE',
        d: {
          id: 'msg-001',
          dm_channel_id: 'dm-abc',
          sender_id: 'user-sender',
          sender_device_id: 'device-sender',
          ciphertext: new Uint8Array(100).fill(0xcc),
          x3dh_header: {
            sender_identity_key: new Uint8Array(32).fill(0x11),
            ephemeral_key: new Uint8Array(32).fill(0x22),
            prekey_id: 7,
          },
          created_at: '2026-02-22T00:00:00Z',
        },
        seq: 5,
      }

      const encoded = encode(serverEvent)
      const decoded = decode(encoded) as typeof serverEvent

      expect(decoded.t).toBe('MESSAGE_CREATE')
      expect(decoded.seq).toBe(5)

      const d = decoded.d
      expect(d.id).toBe('msg-001')
      expect(d.dm_channel_id).toBe('dm-abc')
      expect(d.ciphertext).toBeInstanceOf(Uint8Array)
      expect(d.ciphertext.length).toBe(100)
      expect(d.x3dh_header.prekey_id).toBe(7)
    })

    it('round-trips a message_send payload without x3dh_header (subsequent messages)', () => {
      const payload = {
        op: 'message_send',
        d: {
          dm_channel_id: 'dm-456',
          recipients: [
            {
              device_id: 'device-002',
              ciphertext: new Uint8Array(80).fill(0xdd),
            },
            {
              device_id: 'device-003',
              ciphertext: new Uint8Array(80).fill(0xee),
            },
          ],
        },
      }

      const encoded = encode(payload)
      const decoded = decode(encoded) as typeof payload

      expect(decoded.d.recipients).toHaveLength(2)
      expect(decoded.d.recipients[0].ciphertext).toBeInstanceOf(Uint8Array)
      expect(decoded.d.recipients[1].ciphertext).toBeInstanceOf(Uint8Array)
      // No x3dh_header on subsequent messages
      expect((decoded.d.recipients[0] as Record<string, unknown>).x3dh_header).toBeUndefined()
    })

    it('encodes standard channel message as JSON-compatible (for comparison)', () => {
      const payload = {
        op: 'message_send',
        d: {
          channel_id: 'channel-001',
          content: 'Hello, world!',
        },
      }

      const encoded = encode(payload)
      const decoded = decode(encoded) as typeof payload

      expect(decoded.op).toBe('message_send')
      expect(decoded.d.channel_id).toBe('channel-001')
      expect(decoded.d.content).toBe('Hello, world!')
    })

    it('preserves Uint8Array identity through encode/decode', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5])
      const encoded = encode({ data: original })
      const decoded = decode(encoded) as { data: Uint8Array }

      expect(decoded.data).toBeInstanceOf(Uint8Array)
      expect(decoded.data).not.toBe(original) // Different reference
      expect(Array.from(decoded.data)).toEqual(Array.from(original)) // Same content
    })
  })
})
