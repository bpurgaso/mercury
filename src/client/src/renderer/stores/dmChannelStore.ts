import { create } from 'zustand'
import type { DmChannel } from '../types/models'
import { dm as dmApi } from '../services/api'

export type ViewMode = 'server' | 'dm'

interface DmChannelState {
  dmChannels: Map<string, DmChannel>
  activeDmChannelId: string | null
  viewMode: ViewMode

  setDmChannels(channels: DmChannel[]): void
  addDmChannel(channel: DmChannel): void
  setActiveDmChannel(id: string | null): void
  setViewMode(mode: ViewMode): void
  getDmChannelByRecipient(recipientId: string): DmChannel | undefined
  createDmChannel(recipientId: string): Promise<DmChannel>
}

export const useDmChannelStore = create<DmChannelState>((set, get) => ({
  dmChannels: new Map(),
  activeDmChannelId: null,
  viewMode: 'server',

  setDmChannels(channels: DmChannel[]) {
    const map = new Map<string, DmChannel>()
    for (const ch of channels) {
      map.set(ch.id, ch)
    }
    set({ dmChannels: map })
  },

  addDmChannel(channel: DmChannel) {
    set((state) => {
      const dmChannels = new Map(state.dmChannels)
      dmChannels.set(channel.id, channel)
      return { dmChannels }
    })
  },

  setActiveDmChannel(id: string | null) {
    set({ activeDmChannelId: id, viewMode: id ? 'dm' : 'server' })
  },

  setViewMode(mode: ViewMode) {
    set({ viewMode: mode })
    if (mode === 'server') {
      set({ activeDmChannelId: null })
    }
  },

  getDmChannelByRecipient(recipientId: string): DmChannel | undefined {
    for (const ch of get().dmChannels.values()) {
      if (ch.recipient.id === recipientId) return ch
    }
    return undefined
  },

  async createDmChannel(recipientId: string): Promise<DmChannel> {
    // Check if DM channel already exists locally
    const existing = get().getDmChannelByRecipient(recipientId)
    if (existing) return existing

    const channel = await dmApi.create(recipientId)
    get().addDmChannel(channel)
    return channel
  },
}))
