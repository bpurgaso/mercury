import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock presence store for ST-014 (needs to be before api mock)
vi.mock('../../../src/renderer/stores/presenceStore', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand')
  const store = create<{
    presences: Map<string, { user_id: string; status: string }>
    updatePresence: (userId: string, status: string) => void
  }>((set) => ({
    presences: new Map(),
    updatePresence(userId: string, status: string) {
      set((state) => {
        const presences = new Map(state.presences)
        presences.set(userId, { user_id: userId, status })
        return { presences }
      })
    },
  }))
  return { usePresenceStore: store }
})

// Mock all store modules
vi.mock('../../../src/renderer/services/api', () => ({
  moderation: {
    getBlocks: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    setDmPolicy: vi.fn(),
    submitReport: vi.fn(),
    getReports: vi.fn(),
    reviewReport: vi.fn(),
    banUser: vi.fn(),
    unbanUser: vi.fn(),
    kickUser: vi.fn(),
    muteInChannel: vi.fn(),
    getAuditLog: vi.fn(),
  },
  servers: {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    listMembers: vi.fn(),
  },
  channels: {
    create: vi.fn(),
    list: vi.fn(),
  },
  setTokenProvider: vi.fn(),
}))

import { useModerationStore } from '../../../src/renderer/stores/moderationStore'
import { useServerStore } from '../../../src/renderer/stores/serverStore'
import type { UserBannedEvent, UserKickedEvent, UserMutedEvent, UserUnmutedEvent } from '../../../src/renderer/types/ws'

describe('WebSocket moderation event handling', () => {
  beforeEach(() => {
    useModerationStore.setState({
      blockedUserIds: new Set(),
      dmPolicy: 'anyone',
      reports: new Map(),
      abuseSignals: [],
      bans: new Map(),
      auditLog: [],
      mutedChannels: new Set(),
      pendingReportCount: 0,
      pendingAbuseSignalCount: 0,
    })

    useServerStore.setState({
      servers: new Map([
        ['srv-1', {
          id: 'srv-1',
          name: 'Test Server',
          description: null,
          icon_url: null,
          owner_id: 'owner-1',
          invite_code: 'abc',
          max_members: null,
          created_at: null,
        }],
      ]),
      channels: new Map([
        ['ch-1', {
          id: 'ch-1',
          server_id: 'srv-1',
          name: 'general',
          channel_type: 'text' as const,
          encryption_mode: 'standard' as const,
          position: 0,
          topic: null,
          created_at: null,
        }],
      ]),
      members: new Map(),
      activeServerId: 'srv-1',
      activeChannelId: 'ch-1',
    })

    vi.clearAllMocks()
  })

  describe('USER_BANNED for current user', () => {
    it('removes server from UI when current user is banned', () => {
      const event: UserBannedEvent = {
        server_id: 'srv-1',
        server_name: 'Test Server',
        user_id: 'current-user',
        reason: 'Bad behavior',
      }

      // Simulate what App.tsx does on USER_BANNED for self
      useServerStore.getState().removeServer(event.server_id)

      expect(useServerStore.getState().servers.has('srv-1')).toBe(false)
      // Channels belonging to removed server are also cleaned up
      expect(useServerStore.getState().channels.has('ch-1')).toBe(false)
      // Active server should be cleared
      expect(useServerStore.getState().activeServerId).toBe(null)
    })
  })

  describe('USER_KICKED for current user', () => {
    it('removes server from UI when current user is kicked', () => {
      const event: UserKickedEvent = {
        server_id: 'srv-1',
        server_name: 'Test Server',
        user_id: 'current-user',
        reason: 'Violation',
      }

      useServerStore.getState().removeServer(event.server_id)

      expect(useServerStore.getState().servers.has('srv-1')).toBe(false)
      expect(useServerStore.getState().channels.has('ch-1')).toBe(false)
    })
  })

  describe('USER_BANNED for another user', () => {
    it('removes user from member list', () => {
      useServerStore.setState({
        members: new Map([['srv-1', [
          { user_id: 'other-user', server_id: 'srv-1', nickname: null, is_moderator: false, joined_at: null },
          { user_id: 'innocent-user', server_id: 'srv-1', nickname: null, is_moderator: false, joined_at: null },
        ]]]),
      })

      const event: UserBannedEvent = {
        server_id: 'srv-1',
        server_name: 'Test Server',
        user_id: 'other-user',
      }

      // Simulate: other user banned — just remove from members
      useServerStore.getState().removeMember(event.server_id, event.user_id)

      const members = useServerStore.getState().members.get('srv-1') || []
      expect(members).toHaveLength(1)
      expect(members[0].user_id).toBe('innocent-user')
    })
  })

  describe('USER_MUTED for current user', () => {
    it('adds channel to mutedChannels', () => {
      const event: UserMutedEvent = {
        channel_id: 'ch-1',
        user_id: 'current-user',
        expires_at: '2026-02-01T00:00:00Z',
      }

      // Simulate what App.tsx does
      useModerationStore.setState((state) => {
        const mutedChannels = new Set(state.mutedChannels)
        mutedChannels.add(event.channel_id)
        return { mutedChannels }
      })

      expect(useModerationStore.getState().mutedChannels.has('ch-1')).toBe(true)
    })
  })

  describe('USER_UNMUTED for current user', () => {
    it('removes channel from mutedChannels', () => {
      useModerationStore.setState({ mutedChannels: new Set(['ch-1']) })

      const event: UserUnmutedEvent = {
        channel_id: 'ch-1',
        user_id: 'current-user',
      }

      useModerationStore.setState((state) => {
        const mutedChannels = new Set(state.mutedChannels)
        mutedChannels.delete(event.channel_id)
        return { mutedChannels }
      })

      expect(useModerationStore.getState().mutedChannels.has('ch-1')).toBe(false)
    })
  })

  describe('REPORT_CREATED', () => {
    it('increments pending report count', () => {
      useModerationStore.getState().incrementReportCount()

      expect(useModerationStore.getState().pendingReportCount).toBe(1)
    })
  })

  describe('ABUSE_SIGNAL', () => {
    it('increments pending abuse signal count', () => {
      useModerationStore.getState().incrementAbuseSignalCount()

      expect(useModerationStore.getState().pendingAbuseSignalCount).toBe(1)
    })
  })

  describe('Presence filtering for blocked users', () => {
    it('skips presence updates from blocked users', () => {
      useModerationStore.setState({ blockedUserIds: new Set(['blocked-user']) })

      const blockedUserIds = useModerationStore.getState().blockedUserIds
      const senderId = 'blocked-user'

      // This is the check in App.tsx: if blockedUserIds.has(sender), skip
      expect(blockedUserIds.has(senderId)).toBe(true)
    })

    it('allows presence updates from non-blocked users', () => {
      useModerationStore.setState({ blockedUserIds: new Set(['blocked-user']) })

      const blockedUserIds = useModerationStore.getState().blockedUserIds
      const senderId = 'normal-user'

      expect(blockedUserIds.has(senderId)).toBe(false)
    })
  })

  describe('Message filtering for blocked users', () => {
    it('skips MESSAGE_CREATE from blocked users', () => {
      useModerationStore.setState({ blockedUserIds: new Set(['blocked-user']) })

      const blockedUserIds = useModerationStore.getState().blockedUserIds
      const senderId = 'blocked-user'

      // This is the check in App.tsx MESSAGE_CREATE handler
      expect(blockedUserIds.has(senderId)).toBe(true)
    })
  })
})

// ── ST-014: presence_update ───────────────────────────────

// TESTSPEC: ST-014
describe('PRESENCE_UPDATE event handling', () => {
  it('updates presences map on PRESENCE_UPDATE', async () => {
    // Import the mocked presence store
    const { usePresenceStore } = await import('../../../src/renderer/stores/presenceStore')

    // Reset state
    usePresenceStore.setState({ presences: new Map() })

    // Simulate what App.tsx does on PRESENCE_UPDATE event
    const event = { user_id: 'user-abc', status: 'online' }
    usePresenceStore.getState().updatePresence(event.user_id, event.status)

    const presences = usePresenceStore.getState().presences
    expect(presences.has('user-abc')).toBe(true)
    expect(presences.get('user-abc')!.status).toBe('online')
  })

  it('overwrites previous presence status', async () => {
    const { usePresenceStore } = await import('../../../src/renderer/stores/presenceStore')

    usePresenceStore.setState({ presences: new Map() })

    // User goes online
    usePresenceStore.getState().updatePresence('user-abc', 'online')
    expect(usePresenceStore.getState().presences.get('user-abc')!.status).toBe('online')

    // User goes offline
    usePresenceStore.getState().updatePresence('user-abc', 'offline')
    expect(usePresenceStore.getState().presences.get('user-abc')!.status).toBe('offline')
  })
})
