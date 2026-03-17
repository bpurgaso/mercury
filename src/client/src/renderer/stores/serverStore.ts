import { create } from 'zustand'
import type { Server, Channel, ServerMember } from '../types/models'
import { servers as serversApi, channels as channelsApi } from '../services/api'

interface ServerState {
  servers: Map<string, Server>
  channels: Map<string, Channel>
  members: Map<string, ServerMember[]>
  activeServerId: string | null
  activeChannelId: string | null

  // Server actions
  setServers(servers: Server[]): void
  addServer(server: Server): void
  removeServer(serverId: string): void
  updateServer(server: Server): void
  createServer(name: string): Promise<Server>
  joinServer(inviteCode: string): Promise<Server>
  leaveServer(serverId: string): Promise<void>
  setActiveServer(serverId: string | null): void

  // Channel actions
  setChannels(channels: Channel[]): void
  addChannel(channel: Channel): void
  removeChannel(channelId: string): void
  updateChannel(channel: Channel): void
  createChannel(serverId: string, name: string, channelType: 'text' | 'voice', encryptionMode: 'standard' | 'private'): Promise<Channel>
  fetchChannels(serverId: string): Promise<void>
  setActiveChannel(channelId: string | null): void

  // Member actions
  addMember(serverId: string, userId: string): void
  removeMember(serverId: string, userId: string): void

  // Helpers
  getServerChannels(serverId: string): Channel[]
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: new Map(),
  channels: new Map(),
  members: new Map(),
  activeServerId: null,
  activeChannelId: null,

  setServers(servers: Server[]) {
    const map = new Map<string, Server>()
    for (const s of servers) {
      map.set(s.id, s)
    }
    set({ servers: map })
  },

  addServer(server: Server) {
    set((state) => {
      const servers = new Map(state.servers)
      servers.set(server.id, server)
      return { servers }
    })
  },

  removeServer(serverId: string) {
    set((state) => {
      const servers = new Map(state.servers)
      servers.delete(serverId)
      // Also remove channels belonging to this server
      const channels = new Map(state.channels)
      for (const [id, ch] of channels) {
        if (ch.server_id === serverId) channels.delete(id)
      }
      const members = new Map(state.members)
      members.delete(serverId)
      // Clear active if it was this server
      const activeServerId = state.activeServerId === serverId ? null : state.activeServerId
      const activeChannelId =
        state.activeChannelId && !channels.has(state.activeChannelId) ? null : state.activeChannelId
      return { servers, channels, members, activeServerId, activeChannelId }
    })
  },

  updateServer(server: Server) {
    set((state) => {
      const servers = new Map(state.servers)
      servers.set(server.id, server)
      return { servers }
    })
  },

  async createServer(name: string) {
    const server = await serversApi.create({ name })
    get().addServer(server)
    return server
  },

  async joinServer(inviteCode: string) {
    const server = await serversApi.join({ invite_code: inviteCode })
    get().addServer(server)
    await get().fetchChannels(server.id)
    return server
  },

  async leaveServer(serverId: string) {
    await serversApi.leave(serverId)
    get().removeServer(serverId)
  },

  setActiveServer(serverId: string | null) {
    set({ activeServerId: serverId })
    if (serverId) {
      // Auto-select first text channel
      const channels = get().getServerChannels(serverId)
      const textChannel = channels.find((c) => c.channel_type === 'text')
      if (textChannel) {
        set({ activeChannelId: textChannel.id })
      } else {
        set({ activeChannelId: null })
      }
    }
  },

  setChannels(channels: Channel[]) {
    set((state) => {
      const map = new Map(state.channels)
      for (const ch of channels) {
        map.set(ch.id, ch)
      }
      return { channels: map }
    })
  },

  addChannel(channel: Channel) {
    set((state) => {
      const channels = new Map(state.channels)
      channels.set(channel.id, channel)
      return { channels }
    })
  },

  removeChannel(channelId: string) {
    set((state) => {
      const channels = new Map(state.channels)
      channels.delete(channelId)
      const activeChannelId = state.activeChannelId === channelId ? null : state.activeChannelId
      return { channels, activeChannelId }
    })
  },

  updateChannel(channel: Channel) {
    set((state) => {
      const channels = new Map(state.channels)
      channels.set(channel.id, channel)
      return { channels }
    })
  },

  async createChannel(serverId: string, name: string, channelType: 'text' | 'voice', encryptionMode: 'standard' | 'private') {
    const channel = await channelsApi.create(serverId, {
      name,
      channel_type: channelType,
      encryption_mode: encryptionMode,
    })
    get().addChannel(channel)
    return channel
  },

  async fetchChannels(serverId: string) {
    const channelList = await channelsApi.list(serverId)
    get().setChannels(channelList)
  },

  setActiveChannel(channelId: string | null) {
    set({ activeChannelId: channelId })
  },

  addMember(serverId: string, userId: string) {
    set((state) => {
      const members = new Map(state.members)
      const existing = members.get(serverId) || []
      if (!existing.some((m) => m.user_id === userId)) {
        members.set(serverId, [
          ...existing,
          { user_id: userId, server_id: serverId, nickname: null, is_moderator: false, joined_at: new Date().toISOString() },
        ])
      }
      return { members }
    })
  },

  removeMember(serverId: string, userId: string) {
    set((state) => {
      const members = new Map(state.members)
      const existing = members.get(serverId) || []
      members.set(
        serverId,
        existing.filter((m) => m.user_id !== userId)
      )
      return { members }
    })
  },

  getServerChannels(serverId: string) {
    const channels: Channel[] = []
    for (const ch of get().channels.values()) {
      if (ch.server_id === serverId) {
        channels.push(ch)
      }
    }
    return channels.sort((a, b) => a.position - b.position)
  },
}))
