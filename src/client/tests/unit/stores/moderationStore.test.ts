import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the api module
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
    getModerationKey: vi.fn(),
  },
  setTokenProvider: vi.fn(),
}))

import { useModerationStore } from '../../../src/renderer/stores/moderationStore'
import { moderation as moderationApi } from '../../../src/renderer/services/api'

describe('moderationStore', () => {
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
    vi.clearAllMocks()
  })

  describe('blockUser', () => {
    it('adds userId to blockedUserIds and calls API', async () => {
      vi.mocked(moderationApi.blockUser).mockResolvedValue(undefined)

      await useModerationStore.getState().blockUser('user-123')

      expect(moderationApi.blockUser).toHaveBeenCalledWith('user-123')
      expect(useModerationStore.getState().blockedUserIds.has('user-123')).toBe(true)
    })

    it('throws and does not update state on API error', async () => {
      vi.mocked(moderationApi.blockUser).mockRejectedValue(new Error('Network error'))

      await expect(useModerationStore.getState().blockUser('user-123')).rejects.toThrow('Network error')
      expect(useModerationStore.getState().blockedUserIds.has('user-123')).toBe(false)
    })
  })

  describe('unblockUser', () => {
    it('removes userId from blockedUserIds and calls API', async () => {
      useModerationStore.setState({ blockedUserIds: new Set(['user-123']) })
      vi.mocked(moderationApi.unblockUser).mockResolvedValue(undefined)

      await useModerationStore.getState().unblockUser('user-123')

      expect(moderationApi.unblockUser).toHaveBeenCalledWith('user-123')
      expect(useModerationStore.getState().blockedUserIds.has('user-123')).toBe(false)
    })
  })

  describe('loadBlockedUsers', () => {
    it('loads blocked user IDs from API', async () => {
      vi.mocked(moderationApi.getBlocks).mockResolvedValue({
        blocked_user_ids: ['user-1', 'user-2'],
      })

      await useModerationStore.getState().loadBlockedUsers()

      const blocked = useModerationStore.getState().blockedUserIds
      expect(blocked.has('user-1')).toBe(true)
      expect(blocked.has('user-2')).toBe(true)
      expect(blocked.size).toBe(2)
    })

    it('handles API error gracefully (starts with empty set)', async () => {
      vi.mocked(moderationApi.getBlocks).mockRejectedValue(new Error('fail'))

      await useModerationStore.getState().loadBlockedUsers()

      expect(useModerationStore.getState().blockedUserIds.size).toBe(0)
    })
  })

  describe('setDmPolicy', () => {
    it('updates dmPolicy and calls API', async () => {
      vi.mocked(moderationApi.setDmPolicy).mockResolvedValue(undefined)

      await useModerationStore.getState().setDmPolicy('nobody')

      expect(moderationApi.setDmPolicy).toHaveBeenCalledWith('nobody')
      expect(useModerationStore.getState().dmPolicy).toBe('nobody')
    })

    it('updates to mutual_servers', async () => {
      vi.mocked(moderationApi.setDmPolicy).mockResolvedValue(undefined)

      await useModerationStore.getState().setDmPolicy('mutual_servers')

      expect(useModerationStore.getState().dmPolicy).toBe('mutual_servers')
    })
  })

  describe('submitReport', () => {
    it('calls API with correct payload', async () => {
      vi.mocked(moderationApi.submitReport).mockResolvedValue({
        id: 'report-1',
        server_id: 'srv-1',
        reporter_id: 'me',
        reported_user_id: 'bad-user',
        category: 'spam',
        description: 'Spamming links',
        status: 'pending',
        created_at: '2026-01-01T00:00:00Z',
      })

      await useModerationStore.getState().submitReport({
        reportedUserId: 'bad-user',
        messageId: 'msg-1',
        channelId: 'ch-1',
        serverId: 'srv-1',
        category: 'spam',
        description: 'Spamming links',
        includeEvidence: false,
      })

      expect(moderationApi.submitReport).toHaveBeenCalledWith({
        reported_user_id: 'bad-user',
        message_id: 'msg-1',
        channel_id: 'ch-1',
        category: 'spam',
        description: 'Spamming links',
        evidence_blob: undefined,
      })
    })

    it('includes evidence blob when provided', async () => {
      vi.mocked(moderationApi.submitReport).mockResolvedValue({
        id: 'report-2',
        server_id: 'srv-1',
        reporter_id: 'me',
        reported_user_id: 'bad-user',
        category: 'harassment',
        description: 'Threatening messages',
        status: 'pending',
        created_at: '2026-01-01T00:00:00Z',
      })

      await useModerationStore.getState().submitReport({
        reportedUserId: 'bad-user',
        messageId: 'msg-2',
        channelId: 'ch-1',
        category: 'harassment',
        description: 'Threatening messages',
        includeEvidence: true,
        evidenceBlob: 'base64-encrypted-evidence',
      })

      expect(moderationApi.submitReport).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence_blob: 'base64-encrypted-evidence',
        })
      )
    })
  })

  describe('fetchReports', () => {
    it('loads reports into store', async () => {
      vi.mocked(moderationApi.getReports).mockResolvedValue([
        {
          id: 'r1',
          server_id: 's1',
          reporter_id: 'u1',
          reported_user_id: 'u2',
          category: 'spam',
          description: 'spam',
          status: 'pending',
          created_at: '2026-01-01T00:00:00Z',
        },
      ])

      await useModerationStore.getState().fetchReports('s1')

      expect(useModerationStore.getState().reports.size).toBe(1)
      expect(useModerationStore.getState().reports.get('r1')?.category).toBe('spam')
    })
  })

  describe('reviewReport', () => {
    it('updates report status to reviewed', async () => {
      useModerationStore.setState({
        reports: new Map([['r1', {
          id: 'r1',
          server_id: 's1',
          reporter_id: 'u1',
          reported_user_id: 'u2',
          category: 'spam' as const,
          description: 'spam',
          status: 'pending' as const,
          created_at: '2026-01-01T00:00:00Z',
        }]]),
      })
      vi.mocked(moderationApi.reviewReport).mockResolvedValue(undefined)

      await useModerationStore.getState().reviewReport('r1', 'ban')

      expect(moderationApi.reviewReport).toHaveBeenCalledWith('r1', 'ban')
      const report = useModerationStore.getState().reports.get('r1')
      expect(report?.status).toBe('reviewed')
      expect(report?.action_taken).toBe('ban')
    })
  })

  describe('banUser', () => {
    it('calls API and adds ban to store', async () => {
      vi.mocked(moderationApi.banUser).mockResolvedValue(undefined)

      await useModerationStore.getState().banUser('s1', 'u1', 'Bad behavior')

      expect(moderationApi.banUser).toHaveBeenCalledWith('s1', 'u1', 'Bad behavior', undefined)
      expect(useModerationStore.getState().bans.has('s1:u1')).toBe(true)
    })
  })

  describe('unbanUser', () => {
    it('calls API and removes ban from store', async () => {
      useModerationStore.setState({
        bans: new Map([['s1:u1', {
          server_id: 's1',
          user_id: 'u1',
          reason: 'test',
          banned_by: 'admin',
          created_at: '2026-01-01T00:00:00Z',
        }]]),
      })
      vi.mocked(moderationApi.unbanUser).mockResolvedValue(undefined)

      await useModerationStore.getState().unbanUser('s1', 'u1')

      expect(moderationApi.unbanUser).toHaveBeenCalledWith('s1', 'u1')
      expect(useModerationStore.getState().bans.has('s1:u1')).toBe(false)
    })
  })

  describe('notification badges', () => {
    it('incrementReportCount increments pendingReportCount', () => {
      useModerationStore.getState().incrementReportCount()
      expect(useModerationStore.getState().pendingReportCount).toBe(1)
      useModerationStore.getState().incrementReportCount()
      expect(useModerationStore.getState().pendingReportCount).toBe(2)
    })

    it('clearReportCount resets to 0', () => {
      useModerationStore.setState({ pendingReportCount: 5 })
      useModerationStore.getState().clearReportCount()
      expect(useModerationStore.getState().pendingReportCount).toBe(0)
    })
  })
})
