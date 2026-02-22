import { create } from 'zustand'
import type { Message } from '../types/models'
import type { MessageCreateEvent } from '../types/ws'
import { messages as messagesApi, dm as dmApi, keyBundles as keyBundlesApi, deviceList as deviceListApi } from '../services/api'
import { wsManager } from '../services/websocket'
import { useDmChannelStore } from './dmChannelStore'
import { cryptoService } from '../services/crypto'

// Callback for showing TOFU identity warning — set by UI layer
let identityWarningCallback:
  | ((userId: string, previousKey: number[], newKey: number[]) => Promise<boolean>)
  | null = null

export function setIdentityWarningCallback(
  cb: (userId: string, previousKey: number[], newKey: number[]) => Promise<boolean>,
): void {
  identityWarningCallback = cb
}

interface MessageState {
  messages: Map<string, Message[]>
  dmHistoryLoaded: Set<string>

  addMessage(channelId: string, message: Message): void
  handleMessageCreate(event: MessageCreateEvent): void
  fetchHistory(channelId: string, before?: string): Promise<void>
  sendMessage(channelId: string, content: string): Promise<void>
  getChannelMessages(channelId: string): Message[]
  fetchDmHistory(dmChannelId: string): Promise<void>
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64ToNumberArray(b64: string): number[] {
  return Array.from(base64ToUint8Array(b64))
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: new Map(),
  dmHistoryLoaded: new Set(),

  addMessage(channelId: string, message: Message) {
    set((state) => {
      const messages = new Map(state.messages)
      const existing = messages.get(channelId) || []
      // Avoid duplicates
      if (existing.some((m) => m.id === message.id)) return state
      messages.set(channelId, [...existing, message])
      return { messages }
    })
  },

  handleMessageCreate(event: MessageCreateEvent) {
    if (event.dm_channel_id && event.ciphertext) {
      // DM message — decrypt via worker
      handleDmMessageCreate(event, get().addMessage.bind(get()))
    } else if (event.channel_id && event.content != null) {
      // Standard channel message — plaintext
      const message: Message = {
        id: event.id,
        channel_id: event.channel_id!,
        sender_id: event.sender_id,
        content: event.content ?? null,
        message_type: 'text',
        created_at: event.created_at,
        edited_at: null,
      }
      get().addMessage(event.channel_id!, message)
    }
  },

  async fetchHistory(channelId: string, before?: string) {
    const history = await messagesApi.getHistory(channelId, {
      before,
      limit: 50,
    })

    set((state) => {
      const messages = new Map(state.messages)
      const existing = messages.get(channelId) || []

      // Prepend history, avoiding duplicates
      const existingIds = new Set(existing.map((m) => m.id))
      const newMessages = history.filter((m) => !existingIds.has(m.id))
      messages.set(channelId, [...newMessages, ...existing])
      return { messages }
    })
  },

  async sendMessage(channelId: string, content: string) {
    const dmChannel = useDmChannelStore.getState().dmChannels.get(channelId)

    if (dmChannel) {
      // DM path — encrypt via worker
      await sendDmMessage(channelId, dmChannel.recipient.id, content, get().addMessage.bind(get()))
    } else {
      // Standard channel path — plaintext
      wsManager.send('message_send', {
        channel_id: channelId,
        content,
      })
    }
  },

  getChannelMessages(channelId: string) {
    return get().messages.get(channelId) || []
  },

  async fetchDmHistory(dmChannelId: string) {
    const state = get()

    // Load local messages first (if not already loaded)
    if (!state.dmHistoryLoaded.has(dmChannelId)) {
      try {
        const localMessages = await cryptoService.getMessages(dmChannelId, 50, 0)
        for (const m of localMessages) {
          state.addMessage(dmChannelId, {
            id: m.id,
            channel_id: null,
            dm_channel_id: dmChannelId,
            sender_id: m.senderId,
            content: m.content,
            message_type: 'text',
            created_at: new Date(m.createdAt).toISOString(),
            edited_at: null,
          })
        }
        set((s) => {
          const dmHistoryLoaded = new Set(s.dmHistoryLoaded)
          dmHistoryLoaded.add(dmChannelId)
          return { dmHistoryLoaded }
        })
      } catch (err) {
        console.error('[MessageStore] Failed to load local DM history:', err)
      }
    }

    // Server catch-up: fetch messages after the last known one
    try {
      const existing = state.getChannelMessages(dmChannelId)
      const lastId = existing.length > 0 ? existing[existing.length - 1].id : undefined
      const serverMessages = await dmApi.getHistory(dmChannelId, {
        after: lastId,
        limit: 50,
      })

      for (const serverMsg of serverMessages) {
        // Check if we already have this message locally
        if (existing.some((m) => m.id === serverMsg.id)) continue

        // Decrypt the server message
        const ciphertext = base64ToUint8Array(serverMsg.ciphertext)
        let x3dhHeader: {
          senderIdentityKey: number[]
          ephemeralKey: number[]
          prekeyId: number
        } | undefined

        if (serverMsg.x3dh_header) {
          // The x3dh_header is a base64-encoded MessagePack blob
          const headerBytes = base64ToUint8Array(serverMsg.x3dh_header)
          // Decode using msgpack — import at top doesn't work in renderer for this
          // The server stores the x3dh_header as opaque bytes, we parse it here
          const { decode } = await import('@msgpack/msgpack')
          const parsed = decode(headerBytes) as {
            sender_identity_key: Uint8Array
            ephemeral_key: Uint8Array
            prekey_id: number
          }
          x3dhHeader = {
            senderIdentityKey: Array.from(parsed.sender_identity_key),
            ephemeralKey: Array.from(parsed.ephemeral_key),
            prekeyId: parsed.prekey_id,
          }
        }

        const result = await cryptoService.decryptDm({
          messageId: serverMsg.id,
          dmChannelId,
          senderId: serverMsg.sender_id,
          senderDeviceId: '', // Not available from REST history
          ciphertext: Array.from(ciphertext),
          x3dhHeader,
          createdAt: serverMsg.created_at ? new Date(serverMsg.created_at).getTime() : Date.now(),
        })

        if (result.plaintext) {
          get().addMessage(dmChannelId, {
            id: serverMsg.id,
            channel_id: null,
            dm_channel_id: dmChannelId,
            sender_id: serverMsg.sender_id,
            content: result.plaintext,
            message_type: 'text',
            created_at: serverMsg.created_at,
            edited_at: null,
          })
        } else {
          // Decryption failed — add placeholder
          get().addMessage(dmChannelId, {
            id: serverMsg.id,
            channel_id: null,
            dm_channel_id: dmChannelId,
            sender_id: serverMsg.sender_id,
            content: null,
            message_type: 'text',
            created_at: serverMsg.created_at,
            edited_at: null,
            decrypt_error: result.error === 'NO_SESSION' ? 'NO_SESSION' : 'DECRYPT_FAILED',
          })
        }
      }
    } catch (err) {
      console.error('[MessageStore] Failed to fetch DM history from server:', err)
    }
  },
}))

// --- DM helpers (outside the store for async flexibility) ---

async function sendDmMessage(
  dmChannelId: string,
  recipientId: string,
  content: string,
  addMessage: (channelId: string, message: Message) => void,
): Promise<void> {
  // 1. Fetch and verify the recipient's signed device list
  const deviceListResponse = await deviceListApi.fetch(recipientId)

  const verifyResult = await cryptoService.verifyDeviceList(
    recipientId,
    base64ToNumberArray(deviceListResponse.signed_list),
    base64ToNumberArray(deviceListResponse.master_verify_key),
    base64ToNumberArray(deviceListResponse.signature),
  )

  // 2. Handle verification result
  if (verifyResult.error === 'SIGNATURE_INVALID') {
    throw new Error('Device list signature verification failed')
  }

  if (verifyResult.error === 'IDENTITY_CHANGED') {
    if (identityWarningCallback) {
      const approved = await identityWarningCallback(
        recipientId,
        verifyResult.previousKey!,
        verifyResult.newKey!,
      )
      if (!approved) {
        throw new Error('Message not sent: identity verification failed')
      }
      // User approved — update trusted identity
      await cryptoService.acceptIdentityChange(recipientId, verifyResult.newKey!)
    } else {
      throw new Error('Identity verification failed for recipient')
    }
  }

  // 3. Extract verified device IDs
  const verifiedDeviceIds = new Set(
    (verifyResult.devices || []).map((d) => d.device_id),
  )

  if (verifiedDeviceIds.size === 0) {
    throw new Error('Recipient has no registered devices')
  }

  // 4. Fetch key bundles and filter to only verified devices
  const bundles = await keyBundlesApi.fetchAllForUser(recipientId)
  const verifiedBundles = bundles.devices.filter((d) => verifiedDeviceIds.has(d.device_id))

  if (verifiedBundles.length === 0) {
    throw new Error('No key bundles available for verified devices')
  }

  // 5. Check which devices have existing sessions
  const sessionChecks = await cryptoService.hasSessions(
    verifiedBundles.map((d) => ({ userId: recipientId, deviceId: d.device_id })),
  )

  const devicesWithSession = sessionChecks.filter((s) => s.hasSession)
  const devicesWithoutSession = sessionChecks.filter((s) => !s.hasSession)

  const allRecipients: Array<{
    device_id: string
    ciphertext: Uint8Array
    ratchet_header?: Uint8Array
    x3dh_header?: {
      sender_identity_key: Uint8Array
      ephemeral_key: Uint8Array
      prekey_id: number
    }
  }> = []

  // 6. Encrypt for devices with existing sessions
  if (devicesWithSession.length > 0) {
    const result = await cryptoService.encryptDm(
      recipientId,
      devicesWithSession.map((d) => ({ deviceId: d.deviceId })),
      content,
    )
    allRecipients.push(...result.recipients)
  }

  // 7. Establish sessions and encrypt for devices without sessions
  if (devicesWithoutSession.length > 0) {
    const keyBundleData = []
    for (const device of devicesWithoutSession) {
      const bundle = verifiedBundles.find((d) => d.device_id === device.deviceId)
      if (!bundle) continue

      // Claim a one-time prekey for this device
      let otp: { keyId: number; publicKey: number[] } | undefined
      try {
        const otpResponse = await keyBundlesApi.claimOtp(recipientId, device.deviceId)
        otp = {
          keyId: otpResponse.key_id,
          publicKey: Array.from(base64ToUint8Array(otpResponse.prekey)),
        }
      } catch {
        // No OTPs available — proceed without (X3DH works with 3 DH ops instead of 4)
      }

      keyBundleData.push({
        deviceId: device.deviceId,
        identityKey: Array.from(base64ToUint8Array(bundle.identity_key)),
        signedPreKey: {
          keyId: bundle.signed_prekey_id,
          publicKey: Array.from(base64ToUint8Array(bundle.signed_prekey)),
          signature: Array.from(base64ToUint8Array(bundle.prekey_signature)),
        },
        oneTimePreKey: otp,
      })
    }

    if (keyBundleData.length > 0) {
      // Master verify key comes from the verified device list (not from key bundles)
      const masterVerifyKey = base64ToNumberArray(deviceListResponse.master_verify_key)

      const result = await cryptoService.establishAndEncryptDm(
        recipientId,
        masterVerifyKey,
        keyBundleData,
        content,
      )

      if (result.recipients) {
        allRecipients.push(...result.recipients)
      }
    }
  }

  if (allRecipients.length === 0) {
    throw new Error('Failed to encrypt for any recipient device')
  }

  // 8. Store sender's copy of plaintext locally BEFORE sending
  const messageId = crypto.randomUUID()
  const now = Date.now()
  await cryptoService.storeMessage({
    id: messageId,
    channelId: dmChannelId,
    senderId: 'self',
    content,
    createdAt: now,
  })

  // 9. Send via WebSocket (MessagePack binary frame)
  wsManager.send('message_send', {
    dm_channel_id: dmChannelId,
    recipients: allRecipients,
  })

  // 10. Add optimistic message to in-memory store
  addMessage(dmChannelId, {
    id: messageId,
    channel_id: null,
    dm_channel_id: dmChannelId,
    sender_id: 'self',
    content,
    message_type: 'text',
    created_at: new Date(now).toISOString(),
    edited_at: null,
  })
}

async function handleDmMessageCreate(
  event: MessageCreateEvent,
  addMessage: (channelId: string, message: Message) => void,
): Promise<void> {
  const dmChannelId = event.dm_channel_id!
  const ciphertext = event.ciphertext!

  let x3dhHeader: {
    senderIdentityKey: number[]
    ephemeralKey: number[]
    prekeyId: number
  } | undefined

  if (event.x3dh_header) {
    x3dhHeader = {
      senderIdentityKey: Array.from(event.x3dh_header.sender_identity_key),
      ephemeralKey: Array.from(event.x3dh_header.ephemeral_key),
      prekeyId: event.x3dh_header.prekey_id,
    }
  }

  try {
    const result = await cryptoService.decryptDm({
      messageId: event.id,
      dmChannelId,
      senderId: event.sender_id,
      senderDeviceId: event.sender_device_id || '',
      ciphertext: Array.from(ciphertext),
      x3dhHeader,
      createdAt: event.created_at ? new Date(event.created_at).getTime() : Date.now(),
    })

    if (result.plaintext) {
      addMessage(dmChannelId, {
        id: event.id,
        channel_id: null,
        dm_channel_id: dmChannelId,
        sender_id: event.sender_id,
        content: result.plaintext,
        message_type: 'text',
        created_at: event.created_at,
        edited_at: null,
      })
    } else {
      // Decryption failed — show placeholder
      addMessage(dmChannelId, {
        id: event.id,
        channel_id: null,
        dm_channel_id: dmChannelId,
        sender_id: event.sender_id,
        content: null,
        message_type: 'text',
        created_at: event.created_at,
        edited_at: null,
        decrypt_error: result.error === 'NO_SESSION' ? 'NO_SESSION' : 'DECRYPT_FAILED',
      })
    }
  } catch (err) {
    console.error('[MessageStore] Failed to decrypt DM:', err)
    // Show error placeholder
    addMessage(dmChannelId, {
      id: event.id,
      channel_id: null,
      dm_channel_id: dmChannelId,
      sender_id: event.sender_id,
      content: null,
      message_type: 'text',
      created_at: event.created_at,
      edited_at: null,
      decrypt_error: 'DECRYPT_FAILED',
    })
  }
}
