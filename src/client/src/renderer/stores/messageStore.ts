import { create } from 'zustand'
import type { Message } from '../types/models'
import type { MessageCreateEvent } from '../types/ws'
import { messages as messagesApi } from '../services/api'
import { wsManager } from '../services/websocket'

interface MessageState {
  messages: Map<string, Message[]>

  addMessage(channelId: string, message: Message): void
  handleMessageCreate(event: MessageCreateEvent): void
  fetchHistory(channelId: string, before?: string): Promise<void>
  sendMessage(channelId: string, content: string): void
  getChannelMessages(channelId: string): Message[]
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: new Map(),

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
    const message: Message = {
      id: event.id,
      channel_id: event.channel_id,
      sender_id: event.sender_id,
      content: event.content,
      message_type: 'text',
      created_at: event.created_at,
      edited_at: null,
    }
    get().addMessage(event.channel_id, message)
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

  sendMessage(channelId: string, content: string) {
    // Send via WebSocket (plaintext for standard channels in Phase 5b)
    wsManager.send('message_send', {
      channel_id: channelId,
      content,
    })
  },

  getChannelMessages(channelId: string) {
    return get().messages.get(channelId) || []
  },
}))
