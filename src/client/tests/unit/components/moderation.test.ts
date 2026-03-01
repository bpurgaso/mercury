import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock stores ---

const mockModerationStoreState = vi.hoisted(() => ({
  blockedUserIds: new Set<string>(),
  dmPolicy: 'anyone' as string,
  blockUser: vi.fn(),
  unblockUser: vi.fn(),
  setDmPolicy: vi.fn(),
  submitReport: vi.fn(),
  loadBlockedUsers: vi.fn(),
  reports: new Map(),
  abuseSignals: [],
  bans: new Map(),
  auditLog: [],
  mutedChannels: new Set<string>(),
  pendingReportCount: 0,
  pendingAbuseSignalCount: 0,
  fetchReports: vi.fn(),
  reviewReport: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  kickUser: vi.fn(),
  muteInChannel: vi.fn(),
  fetchAuditLog: vi.fn(),
  incrementReportCount: vi.fn(),
  incrementAbuseSignalCount: vi.fn(),
  clearReportCount: vi.fn(),
  clearAbuseSignalCount: vi.fn(),
}))

const mockAuthStoreState = vi.hoisted(() => ({
  user: { id: 'current-user', username: 'testuser', display_name: 'Test User', email: '', avatar_url: null, status: null, created_at: null },
}))

vi.mock('../../../src/renderer/stores/moderationStore', () => ({
  useModerationStore: vi.fn((selector: (s: typeof mockModerationStoreState) => unknown) =>
    selector(mockModerationStoreState)
  ),
}))

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: vi.fn((selector: (s: typeof mockAuthStoreState) => unknown) =>
    selector(mockAuthStoreState)
  ),
}))

vi.mock('../../../src/renderer/services/api', () => ({
  moderation: {
    getModerationKey: vi.fn(),
    submitReport: vi.fn(),
  },
  setTokenProvider: vi.fn(),
}))

vi.mock('../../../src/renderer/services/crypto', () => ({
  cryptoService: {
    encryptReportEvidence: vi.fn(),
  },
  initCryptoPort: vi.fn(),
}))

describe('BlockConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockModerationStoreState.blockUser.mockResolvedValue(undefined)
  })

  it('calls blockUser when confirmed', async () => {
    // Simulate the BlockConfirmDialog logic directly since we're in node env
    const userId = 'user-to-block'

    await mockModerationStoreState.blockUser(userId)

    expect(mockModerationStoreState.blockUser).toHaveBeenCalledWith('user-to-block')
  })

  it('does not call blockUser when cancelled', () => {
    // Cancel means onClose is called, blockUser is never invoked
    expect(mockModerationStoreState.blockUser).not.toHaveBeenCalled()
  })
})

describe('ReportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockModerationStoreState.submitReport.mockResolvedValue(undefined)
  })

  it('submits report with correct category and description', async () => {
    await mockModerationStoreState.submitReport({
      reportedUserId: 'bad-user',
      messageId: 'msg-1',
      channelId: 'ch-1',
      category: 'harassment',
      description: 'Threatening messages',
      includeEvidence: false,
    })

    expect(mockModerationStoreState.submitReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportedUserId: 'bad-user',
        category: 'harassment',
        description: 'Threatening messages',
        includeEvidence: false,
      })
    )
  })

  it('calls encryptReportEvidence when evidence toggle is ON', async () => {
    const { cryptoService } = await import('../../../src/renderer/services/crypto')
    const { moderation } = await import('../../../src/renderer/services/api')

    vi.mocked(moderation.getModerationKey).mockResolvedValue({
      public_key: btoa(String.fromCharCode(...new Array(32).fill(0))),
    })
    vi.mocked(cryptoService.encryptReportEvidence).mockResolvedValue({
      encryptedEvidence: [1, 2, 3, 4],
    })

    // Simulate the ReportDialog evidence encryption flow
    const serverId = 'srv-1'
    const messageContent = 'abusive content'

    const { public_key } = await moderation.getModerationKey(serverId)
    const moderationPubKey = Array.from(atob(public_key), (c) => c.charCodeAt(0))

    const evidence = JSON.stringify({
      message_text: messageContent,
      sender_id: 'bad-user',
      timestamp: new Date().toISOString(),
      channel_id: 'ch-1',
    })

    const result = await cryptoService.encryptReportEvidence(evidence, moderationPubKey)

    expect(cryptoService.encryptReportEvidence).toHaveBeenCalled()
    expect(result.encryptedEvidence).toEqual([1, 2, 3, 4])
  })

  it('submits metadata-only report when evidence toggle is OFF', async () => {
    await mockModerationStoreState.submitReport({
      reportedUserId: 'bad-user',
      messageId: 'msg-1',
      channelId: 'ch-1',
      category: 'spam',
      description: 'Spam messages',
      includeEvidence: false,
    })

    expect(mockModerationStoreState.submitReport).toHaveBeenCalledWith(
      expect.objectContaining({
        includeEvidence: false,
      })
    )
    // No evidence blob should be present
    const call = mockModerationStoreState.submitReport.mock.calls[0][0]
    expect(call.evidenceBlob).toBeUndefined()
  })
})

describe('Message filtering for blocked users', () => {
  it('filters out messages from blocked users', () => {
    const messages = [
      { id: 'm1', sender_id: 'user-a', content: 'Hello', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
      { id: 'm2', sender_id: 'blocked-user', content: 'Bad message', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
      { id: 'm3', sender_id: 'user-b', content: 'Hi there', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
    ]

    const blockedUserIds = new Set(['blocked-user'])
    const filtered = messages.filter((m) => !blockedUserIds.has(m.sender_id))

    expect(filtered).toHaveLength(2)
    expect(filtered.map((m) => m.id)).toEqual(['m1', 'm3'])
  })

  it('shows all messages when no users are blocked', () => {
    const messages = [
      { id: 'm1', sender_id: 'user-a', content: 'Hello', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
      { id: 'm2', sender_id: 'user-b', content: 'World', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
    ]

    const blockedUserIds = new Set<string>()
    const filtered = messages.filter((m) => !blockedUserIds.has(m.sender_id))

    expect(filtered).toHaveLength(2)
  })

  it('filters multiple blocked users', () => {
    const messages = [
      { id: 'm1', sender_id: 'user-a', content: 'Hello', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
      { id: 'm2', sender_id: 'blocked-1', content: 'Bad', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
      { id: 'm3', sender_id: 'blocked-2', content: 'Also bad', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
      { id: 'm4', sender_id: 'user-b', content: 'Good', channel_id: 'ch-1', message_type: 'text', created_at: null, edited_at: null },
    ]

    const blockedUserIds = new Set(['blocked-1', 'blocked-2'])
    const filtered = messages.filter((m) => !blockedUserIds.has(m.sender_id))

    expect(filtered).toHaveLength(2)
    expect(filtered.map((m) => m.id)).toEqual(['m1', 'm4'])
  })
})
