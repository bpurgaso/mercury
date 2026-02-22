import { create } from 'zustand'
import type { Message, Channel } from '../types/models'
import type { MessageCreateEvent, SenderKeyDistributionEvent } from '../types/ws'
import { messages as messagesApi, dm as dmApi, keyBundles as keyBundlesApi, deviceList as deviceListApi, devices as devicesApi } from '../services/api'
import { wsManager } from '../services/websocket'
import { useDmChannelStore } from './dmChannelStore'
import { useServerStore } from './serverStore'
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

// Pending messages waiting for SenderKey distribution
// Key: `${channelId}:${senderId}:${senderDeviceId}`
const pendingSenderKeyMessages = new Map<string, Array<{
  event: MessageCreateEvent
  addMessage: (channelId: string, message: Message) => void
}>>()

function pendingKey(channelId: string, senderId: string, senderDeviceId: string): string {
  return `${channelId}:${senderId}:${senderDeviceId}`
}

// Track channels that have shown the E2E join notice
const joinNoticeShown = new Set<string>()

// Track whether a stale-key retry is in progress to prevent loops
let staleRetryInProgress = false

interface MessageState {
  messages: Map<string, Message[]>
  dmHistoryLoaded: Set<string>
  privateHistoryLoaded: Set<string>

  addMessage(channelId: string, message: Message): void
  addSystemMessage(channelId: string, text: string): void
  updateMessage(channelId: string, messageId: string, updates: Partial<Message>): void
  handleMessageCreate(event: MessageCreateEvent): void
  handleSenderKeyDistribution(event: SenderKeyDistributionEvent): void
  fetchHistory(channelId: string, before?: string): Promise<void>
  fetchPrivateChannelHistory(channelId: string): Promise<void>
  sendMessage(channelId: string, content: string): Promise<void>
  getChannelMessages(channelId: string): Message[]
  fetchDmHistory(dmChannelId: string): Promise<void>
  distributeSenderKeyToNewMember(channelId: string, userId: string): Promise<void>
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
  privateHistoryLoaded: new Set(),

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

  addSystemMessage(channelId: string, text: string) {
    const message: Message = {
      id: `system-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      channel_id: channelId,
      sender_id: 'system',
      content: text,
      message_type: 'system',
      created_at: new Date().toISOString(),
      edited_at: null,
    }
    get().addMessage(channelId, message)
  },

  updateMessage(channelId: string, messageId: string, updates: Partial<Message>) {
    set((state) => {
      const messages = new Map(state.messages)
      const existing = messages.get(channelId)
      if (!existing) return state
      const updated = existing.map((m) =>
        m.id === messageId ? { ...m, ...updates } : m,
      )
      messages.set(channelId, updated)
      return { messages }
    })
  },

  handleMessageCreate(event: MessageCreateEvent) {
    if (event.dm_channel_id && event.ciphertext) {
      // DM message — decrypt via worker
      handleDmMessageCreate(event, get().addMessage.bind(get()))
    } else if (event.channel_id && event.encrypted) {
      // Private channel message — decrypt via worker
      handlePrivateChannelMessageCreate(event, get().addMessage.bind(get()))
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

  async handleSenderKeyDistribution(event: SenderKeyDistributionEvent) {
    try {
      const result = await cryptoService.receiveSenderKeyDistribution({
        channelId: event.channel_id,
        senderId: event.sender_id,
        senderDeviceId: event.sender_device_id,
        ciphertext: Array.from(event.ciphertext),
      })

      if (result.error) {
        console.error('[MessageStore] Failed to receive SenderKey distribution:', result.error)
        return
      }

      // Check for queued messages waiting for this key
      const key = pendingKey(event.channel_id, event.sender_id, event.sender_device_id)
      const queued = pendingSenderKeyMessages.get(key)
      if (queued && queued.length > 0) {
        pendingSenderKeyMessages.delete(key)
        for (const pending of queued) {
          // Retry decryption — use updateMessage to replace the placeholder
          retryPrivateChannelDecrypt(
            pending.event,
            get().updateMessage.bind(get()),
            pending.addMessage,
          )
        }
      }
    } catch (err) {
      console.error('[MessageStore] Error handling SenderKey distribution:', err)
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

  async fetchPrivateChannelHistory(channelId: string) {
    const state = get()

    // Show E2E join notice on first load
    if (!joinNoticeShown.has(channelId)) {
      joinNoticeShown.add(channelId)
    }

    // Load local messages first (if not already loaded)
    if (!state.privateHistoryLoaded.has(channelId)) {
      try {
        const localMessages = await cryptoService.getMessages(channelId, 50, 0)

        // If no local messages, show the join notice
        if (localMessages.length === 0) {
          state.addSystemMessage(
            channelId,
            'Messages in this channel are end-to-end encrypted. You can only see messages sent after you joined.',
          )
        }

        for (const m of localMessages) {
          state.addMessage(channelId, {
            id: m.id,
            channel_id: channelId,
            sender_id: m.senderId,
            content: m.content,
            message_type: 'text',
            created_at: new Date(m.createdAt).toISOString(),
            edited_at: null,
          })
        }
        set((s) => {
          const privateHistoryLoaded = new Set(s.privateHistoryLoaded)
          privateHistoryLoaded.add(channelId)
          return { privateHistoryLoaded }
        })
      } catch (err) {
        console.error('[MessageStore] Failed to load local private channel history:', err)
      }
    }

    // Server catch-up
    try {
      const existing = state.getChannelMessages(channelId)
      // Filter out system messages for the "after" cursor
      const realMessages = existing.filter((m) => m.message_type !== 'system')
      const lastId = realMessages.length > 0 ? realMessages[realMessages.length - 1].id : undefined
      const serverMessages = await messagesApi.getHistory(channelId, {
        after: lastId,
        limit: 50,
      })

      for (const serverMsg of serverMessages) {
        if (existing.some((m) => m.id === serverMsg.id)) continue

        // Private channel messages from server have encrypted payload
        // The server returns them with content=null and encrypted fields
        if (serverMsg.content != null) {
          // This is a plaintext message (shouldn't happen for private channels, but handle gracefully)
          get().addMessage(channelId, serverMsg)
          continue
        }

        // For encrypted messages from REST history, the server returns the
        // encrypted payload. We need to parse and decrypt it.
        // Note: REST history for private channels may require different handling
        // depending on how the server serializes the encrypted payload.
        // For now, skip server catch-up for encrypted messages that we haven't
        // received via WebSocket (they'll come via the live stream).
      }
    } catch (err) {
      console.error('[MessageStore] Failed to fetch private channel history from server:', err)
    }
  },

  async sendMessage(channelId: string, content: string) {
    const dmChannel = useDmChannelStore.getState().dmChannels.get(channelId)

    if (dmChannel) {
      // DM path — encrypt via worker
      await sendDmMessage(channelId, dmChannel.recipient.id, content, get().addMessage.bind(get()))
      return
    }

    const channel = useServerStore.getState().channels.get(channelId)
    if (channel?.encryption_mode === 'private') {
      // Private channel path — encrypt via Sender Keys
      await sendPrivateChannelMessage(channelId, channel, content, get().addMessage.bind(get()))
      return
    }

    // Standard channel path — plaintext
    wsManager.send('message_send', {
      channel_id: channelId,
      content,
    })
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
          const headerBytes = base64ToUint8Array(serverMsg.x3dh_header)
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

  async distributeSenderKeyToNewMember(channelId: string, userId: string) {
    try {
      // Fetch the new member's device list
      const deviceListResponse = await deviceListApi.fetch(userId)
      const verifyResult = await cryptoService.verifyDeviceList(
        userId,
        base64ToNumberArray(deviceListResponse.signed_list),
        base64ToNumberArray(deviceListResponse.master_verify_key),
        base64ToNumberArray(deviceListResponse.signature),
      )

      if (!verifyResult.verified || !verifyResult.devices) return

      const devices = verifyResult.devices.map((d) => ({
        userId,
        deviceId: d.device_id,
      }))

      // Establish sessions for devices without DR sessions
      await ensureSessionsForDevices(userId, devices, deviceListResponse)

      // Distribute our SenderKey
      const distResult = await cryptoService.distributeSenderKeyToDevices({
        channelId,
        devices,
      })

      if (distResult.distributions.length > 0) {
        wsManager.send('sender_key_distribute', {
          channel_id: channelId,
          distributions: distResult.distributions,
        })
      }
    } catch (err) {
      console.error('[MessageStore] Failed to distribute SenderKey to new member:', err)
    }
  },
}))

// --- Private channel helpers ---

async function sendPrivateChannelMessage(
  channelId: string,
  channel: Channel,
  content: string,
  addMessage: (channelId: string, message: Message) => void,
): Promise<void> {
  const channelEpoch = channel.sender_key_epoch ?? 0

  // Collect member devices for this channel's server
  const memberDevices = await getChannelMemberDevices(channel.server_id)

  // Encrypt via worker (handles SenderKey generation/rotation + distribution)
  const encryptResult = await cryptoService.encryptGroup({
    channelId,
    plaintext: content,
    channelEpoch,
    memberDevices,
  })

  // If some devices need X3DH session establishment first
  if (encryptResult.needsX3dh && encryptResult.needsX3dh.length > 0) {
    // Group by userId for batch session establishment
    const byUser = new Map<string, Array<{ userId: string; deviceId: string }>>()
    for (const dev of encryptResult.needsX3dh) {
      const list = byUser.get(dev.userId) || []
      list.push(dev)
      byUser.set(dev.userId, list)
    }

    for (const [userId, devices] of byUser) {
      const deviceListResponse = await deviceListApi.fetch(userId)
      await ensureSessionsForDevices(userId, devices, deviceListResponse)
    }

    // Now distribute SenderKey to the newly established sessions
    const distResult = await cryptoService.distributeSenderKeyToDevices({
      channelId,
      devices: encryptResult.needsX3dh,
    })

    // Send these distributions too
    if (distResult.distributions.length > 0) {
      if (encryptResult.distributions) {
        encryptResult.distributions.push(...distResult.distributions)
      } else {
        encryptResult.distributions = distResult.distributions
      }
    }
  }

  // Send SenderKey distributions (if any)
  if (encryptResult.distributions && encryptResult.distributions.length > 0) {
    wsManager.send('sender_key_distribute', {
      channel_id: channelId,
      distributions: encryptResult.distributions,
    })
  }

  // Store sender's plaintext copy locally BEFORE sending
  const messageId = crypto.randomUUID()
  const now = Date.now()
  await cryptoService.storeMessage({
    id: messageId,
    channelId,
    senderId: 'self',
    content,
    createdAt: now,
  })

  // Send encrypted message via WebSocket (MessagePack binary frame)
  wsManager.send('message_send', {
    channel_id: channelId,
    encrypted: encryptResult.encrypted,
  })

  // Add optimistic message to in-memory store
  addMessage(channelId, {
    id: messageId,
    channel_id: channelId,
    sender_id: 'self',
    content,
    message_type: 'text',
    created_at: new Date(now).toISOString(),
    edited_at: null,
  })

  // Background pre-key replenishment
  maybeReplenishPreKeys()
}

async function handlePrivateChannelMessageCreate(
  event: MessageCreateEvent,
  addMessage: (channelId: string, message: Message) => void,
): Promise<void> {
  const channelId = event.channel_id!
  const encrypted = event.encrypted!

  // Self-echo skip: if we sent this message, we already have the plaintext
  if (event.sender_id === 'self') return

  try {
    const result = await cryptoService.decryptGroup({
      channelId,
      senderId: event.sender_id,
      senderDeviceId: encrypted.sender_device_id,
      ciphertext: Array.from(encrypted.ciphertext),
      nonce: Array.from(encrypted.nonce),
      signature: Array.from(encrypted.signature),
      iteration: encrypted.iteration,
      epoch: encrypted.epoch,
      messageId: event.id,
      createdAt: event.created_at ? new Date(event.created_at).getTime() : Date.now(),
    })

    if (result.plaintext) {
      addMessage(channelId, {
        id: event.id,
        channel_id: channelId,
        sender_id: event.sender_id,
        content: result.plaintext,
        message_type: 'text',
        created_at: event.created_at,
        edited_at: null,
      })
    } else if (result.error === 'MISSING_SENDER_KEY') {
      // Queue for retry when distribution arrives
      const key = pendingKey(channelId, event.sender_id, encrypted.sender_device_id)
      const queue = pendingSenderKeyMessages.get(key) || []
      queue.push({ event, addMessage })
      pendingSenderKeyMessages.set(key, queue)

      // Show placeholder
      addMessage(channelId, {
        id: event.id,
        channel_id: channelId,
        sender_id: event.sender_id,
        content: null,
        message_type: 'text',
        created_at: event.created_at,
        edited_at: null,
        decrypt_error: 'MISSING_SENDER_KEY',
      })
    } else {
      // DECRYPT_FAILED
      addMessage(channelId, {
        id: event.id,
        channel_id: channelId,
        sender_id: event.sender_id,
        content: null,
        message_type: 'text',
        created_at: event.created_at,
        edited_at: null,
        decrypt_error: 'DECRYPT_FAILED',
      })
    }
  } catch (err) {
    console.error('[MessageStore] Failed to decrypt private channel message:', err)
    addMessage(channelId, {
      id: event.id,
      channel_id: channelId,
      sender_id: event.sender_id,
      content: null,
      message_type: 'text',
      created_at: event.created_at,
      edited_at: null,
      decrypt_error: 'DECRYPT_FAILED',
    })
  }
}

/** Retry decryption for a queued message, updating the existing placeholder on success. */
async function retryPrivateChannelDecrypt(
  event: MessageCreateEvent,
  updateMessage: (channelId: string, messageId: string, updates: Partial<Message>) => void,
  addMessage: (channelId: string, message: Message) => void,
): Promise<void> {
  const channelId = event.channel_id!
  const encrypted = event.encrypted!

  try {
    const result = await cryptoService.decryptGroup({
      channelId,
      senderId: event.sender_id,
      senderDeviceId: encrypted.sender_device_id,
      ciphertext: Array.from(encrypted.ciphertext),
      nonce: Array.from(encrypted.nonce),
      signature: Array.from(encrypted.signature),
      iteration: encrypted.iteration,
      epoch: encrypted.epoch,
      messageId: event.id,
      createdAt: event.created_at ? new Date(event.created_at).getTime() : Date.now(),
    })

    if (result.plaintext) {
      // Update the existing placeholder with decrypted content
      updateMessage(channelId, event.id, {
        content: result.plaintext,
        decrypt_error: undefined,
      })
    }
    // If still fails, leave the placeholder as-is
  } catch {
    // Leave the placeholder as-is
  }
}

// --- DM helpers ---

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

    // Background pre-key replenishment after X3DH
    maybeReplenishPreKeys()
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

// --- Shared helpers ---

/** Collect device IDs for all members of a server (excluding self). */
async function getChannelMemberDevices(
  serverId: string,
): Promise<Array<{ userId: string; deviceId: string }>> {
  const members = useServerStore.getState().members.get(serverId) || []
  const devices: Array<{ userId: string; deviceId: string }> = []

  for (const member of members) {
    // Skip self (sender_id = 'self' convention doesn't apply here — we use userId)
    try {
      const deviceListResponse = await deviceListApi.fetch(member.user_id)
      const verifyResult = await cryptoService.verifyDeviceList(
        member.user_id,
        base64ToNumberArray(deviceListResponse.signed_list),
        base64ToNumberArray(deviceListResponse.master_verify_key),
        base64ToNumberArray(deviceListResponse.signature),
      )

      if (verifyResult.verified && verifyResult.devices) {
        for (const d of verifyResult.devices) {
          devices.push({ userId: member.user_id, deviceId: d.device_id })
        }
      }
    } catch {
      // Skip members whose device lists can't be fetched
    }
  }

  return devices
}

/** Ensure Double Ratchet sessions exist for the given devices via X3DH. */
async function ensureSessionsForDevices(
  userId: string,
  devices: Array<{ userId: string; deviceId: string }>,
  deviceListResponse: { signed_list: string; master_verify_key: string; signature: string },
): Promise<void> {
  // Check which devices already have sessions
  const sessionChecks = await cryptoService.hasSessions(devices)
  const withoutSession = sessionChecks.filter((s) => !s.hasSession)

  if (withoutSession.length === 0) return

  // Fetch key bundles for the user
  const bundles = await keyBundlesApi.fetchAllForUser(userId)

  const keyBundleData = []
  for (const device of withoutSession) {
    const bundle = bundles.devices.find((d) => d.device_id === device.deviceId)
    if (!bundle) continue

    let otp: { keyId: number; publicKey: number[] } | undefined
    try {
      const otpResponse = await keyBundlesApi.claimOtp(userId, device.deviceId)
      otp = {
        keyId: otpResponse.key_id,
        publicKey: Array.from(base64ToUint8Array(otpResponse.prekey)),
      }
    } catch {
      // No OTPs available
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
    const masterVerifyKey = base64ToNumberArray(deviceListResponse.master_verify_key)
    // Use establishAndEncryptDm with a dummy plaintext to establish sessions
    // The "encrypt" result is discarded — we only need the sessions
    await cryptoService.establishAndEncryptDm(
      userId,
      masterVerifyKey,
      keyBundleData,
      '', // empty plaintext — we only need the session establishment side effect
    )
  }
}

/** Background pre-key replenishment after X3DH usage. */
function maybeReplenishPreKeys(): void {
  // Fire and forget — do not block the message flow
  cryptoService.getPublicKeys().then(async (keys) => {
    if (keys.unusedPreKeyCount < 30) {
      try {
        const result = await cryptoService.generateOneTimePreKeys(100)
        await devicesApi.uploadKeyBundle(keys.deviceId, {
          one_time_prekeys: result.keys,
        })
      } catch (err) {
        console.warn('[PreKeys] Replenishment failed (will retry later):', err)
      }
    }
  }).catch(() => {
    // Ignore — non-critical
  })
}
