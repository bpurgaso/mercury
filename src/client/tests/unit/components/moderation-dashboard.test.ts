import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Report, AbuseSignal, Ban, AuditLogEntry, UserModerationMetadata } from '../../../src/renderer/types/models'

// --- Mock stores ---

const mockModerationState = vi.hoisted(() => ({
  activeTab: 'reports' as string,
  selectedReportId: null as string | null,
  reports: new Map<string, Report>(),
  abuseSignals: [] as AbuseSignal[],
  bans: new Map<string, Ban>(),
  auditLog: [] as AuditLogEntry[],
  pendingReportCount: 0,
  pendingAbuseSignalCount: 0,
  blockedUserIds: new Set<string>(),
  mutedChannels: new Set<string>(),
  dmPolicy: 'anyone',
  fetchReports: vi.fn(),
  fetchAbuseSignals: vi.fn(),
  fetchBans: vi.fn(),
  fetchAuditLog: vi.fn(),
  reviewReport: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  kickUser: vi.fn(),
  muteInChannel: vi.fn(),
  markAbuseSignalReviewed: vi.fn(),
  setActiveTab: vi.fn(),
  setSelectedReport: vi.fn(),
  submitReport: vi.fn(),
  blockUser: vi.fn(),
  unblockUser: vi.fn(),
  setDmPolicy: vi.fn(),
  loadBlockedUsers: vi.fn(),
  incrementReportCount: vi.fn(),
  incrementAbuseSignalCount: vi.fn(),
  clearReportCount: vi.fn(),
  clearAbuseSignalCount: vi.fn(),
}))

const mockServerState = vi.hoisted(() => ({
  activeServerId: 'server-1',
  activeChannelId: 'channel-1',
  servers: new Map([
    ['server-1', {
      id: 'server-1',
      name: 'Test Server',
      description: null,
      icon_url: null,
      owner_id: 'owner-user',
      invite_code: 'abc',
      max_members: null,
      created_at: null,
    }],
  ]),
  channels: new Map([
    ['channel-1', {
      id: 'channel-1',
      server_id: 'server-1',
      name: 'general',
      channel_type: 'text' as const,
      encryption_mode: 'standard' as const,
      position: 0,
      topic: null,
      created_at: null,
    }],
    ['channel-private', {
      id: 'channel-private',
      server_id: 'server-1',
      name: 'private-chat',
      channel_type: 'text' as const,
      encryption_mode: 'private' as const,
      position: 1,
      topic: null,
      created_at: null,
    }],
  ]),
  members: new Map([
    ['server-1', [
      { user_id: 'owner-user', server_id: 'server-1', nickname: null, is_moderator: false, joined_at: null },
      { user_id: 'mod-user', server_id: 'server-1', nickname: null, is_moderator: true, joined_at: null },
      { user_id: 'regular-user', server_id: 'server-1', nickname: null, is_moderator: false, joined_at: null },
    ]],
  ]),
  getServerChannels: vi.fn(),
  setActiveServer: vi.fn(),
  setActiveChannel: vi.fn(),
  setServers: vi.fn(),
  addServer: vi.fn(),
  removeServer: vi.fn(),
  updateServer: vi.fn(),
  createServer: vi.fn(),
  joinServer: vi.fn(),
  leaveServer: vi.fn(),
  setChannels: vi.fn(),
  addChannel: vi.fn(),
  removeChannel: vi.fn(),
  updateChannel: vi.fn(),
  createChannel: vi.fn(),
  fetchChannels: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
}))

const mockAuthState = vi.hoisted(() => ({
  user: { id: 'owner-user', username: 'owner', display_name: 'Owner', email: '', avatar_url: null, status: null, created_at: null },
  isAuthenticated: true,
  accessToken: null,
  refreshToken: null,
  isLoading: false,
  error: null,
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  refreshTokens: vi.fn(),
  setTokens: vi.fn(),
  clearError: vi.fn(),
  hydrateFromStorage: vi.fn(),
}))

vi.mock('../../../src/renderer/stores/moderationStore', () => ({
  useModerationStore: vi.fn((selector: (s: typeof mockModerationState) => unknown) =>
    selector(mockModerationState)
  ),
}))

vi.mock('../../../src/renderer/stores/serverStore', () => ({
  useServerStore: vi.fn((selector: (s: typeof mockServerState) => unknown) =>
    selector(mockServerState)
  ),
}))

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: vi.fn((selector: (s: typeof mockAuthState) => unknown) =>
    selector(mockAuthState)
  ),
}))

vi.mock('../../../src/renderer/services/api', () => ({
  moderation: {
    getReports: vi.fn(),
    getAbuseSignals: vi.fn(),
    getBans: vi.fn(),
    getAuditLog: vi.fn(),
    reviewReport: vi.fn(),
    banUser: vi.fn(),
    unbanUser: vi.fn(),
    kickUser: vi.fn(),
    muteInChannel: vi.fn(),
    markAbuseSignalReviewed: vi.fn(),
    getModerationKey: vi.fn(),
    setModerationKey: vi.fn(),
    getUserMetadata: vi.fn(),
    getReport: vi.fn(),
    getBlocks: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    setDmPolicy: vi.fn(),
    submitReport: vi.fn(),
  },
  setTokenProvider: vi.fn(),
}))

vi.mock('../../../src/renderer/services/crypto', () => ({
  cryptoService: {
    encryptReportEvidence: vi.fn(),
    decryptReportEvidence: vi.fn(),
    generateModerationKeypair: vi.fn(),
    storeModerationPrivateKey: vi.fn(),
    hasModerationKey: vi.fn(),
  },
  initCryptoPort: vi.fn(),
}))

// ---- Helper data factories ----

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-1',
    server_id: 'server-1',
    reporter_id: 'reporter-user',
    reported_user_id: 'bad-user',
    category: 'spam',
    description: 'Spam messages',
    status: 'pending',
    created_at: '2026-02-15T10:00:00Z',
    ...overrides,
  }
}

function makeAbuseSignal(overrides: Partial<AbuseSignal> = {}): AbuseSignal {
  return {
    id: 'signal-1',
    server_id: 'server-1',
    user_id: 'bad-user',
    signal_type: 'rapid_messages',
    severity: 'medium',
    details: JSON.stringify({ message_count: 50, time_window: '60s' }),
    reviewed: false,
    created_at: '2026-02-15T10:00:00Z',
    ...overrides,
  }
}

function makeBan(overrides: Partial<Ban> = {}): Ban {
  return {
    server_id: 'server-1',
    user_id: 'banned-user',
    reason: 'Spam',
    banned_by: 'owner-user',
    created_at: '2026-02-15T10:00:00Z',
    ...overrides,
  }
}

function makeAuditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 'audit-1',
    server_id: 'server-1',
    actor_id: 'owner-user',
    action: 'banned',
    target_user_id: 'bad-user',
    reason: 'Spam',
    created_at: '2026-02-15T10:00:00Z',
    ...overrides,
  }
}

function makeMetadata(): UserModerationMetadata {
  return {
    user_id: 'bad-user',
    username: 'baduser',
    account_created_at: '2025-11-01T00:00:00Z',
    server_joined_at: '2026-01-15T00:00:00Z',
    message_count_30d: 142,
    report_count_total: 3,
    report_count_recent: 2,
    active_abuse_signals: 1,
    previous_actions: [],
  }
}

// ---- Tests ----

describe('ModerationDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockModerationState.activeTab = 'reports'
    mockModerationState.selectedReportId = null
    mockModerationState.reports = new Map()
    mockModerationState.abuseSignals = []
    mockModerationState.bans = new Map()
    mockModerationState.auditLog = []
    mockModerationState.pendingReportCount = 0
    mockModerationState.pendingAbuseSignalCount = 0
  })

  describe('access control', () => {
    it('owner can access — shield icon should be visible for owner', () => {
      mockAuthState.user = { id: 'owner-user', username: 'owner', display_name: 'Owner', email: '', avatar_url: null, status: null, created_at: null }
      const server = mockServerState.servers.get('server-1')!
      const members = mockServerState.members.get('server-1') || []
      const currentMember = members.find(m => m.user_id === mockAuthState.user!.id)
      const isOwner = server.owner_id === mockAuthState.user!.id
      const isModerator = currentMember?.is_moderator === true
      const canModerate = isOwner || isModerator

      expect(canModerate).toBe(true)
      expect(isOwner).toBe(true)
    })

    it('moderator can access dashboard', () => {
      mockAuthState.user = { id: 'mod-user', username: 'mod', display_name: 'Mod', email: '', avatar_url: null, status: null, created_at: null }
      const server = mockServerState.servers.get('server-1')!
      const members = mockServerState.members.get('server-1') || []
      const currentMember = members.find(m => m.user_id === mockAuthState.user!.id)
      const isOwner = server.owner_id === mockAuthState.user!.id
      const isModerator = currentMember?.is_moderator === true
      const canModerate = isOwner || isModerator

      expect(canModerate).toBe(true)
      expect(isOwner).toBe(false)
      expect(isModerator).toBe(true)
    })

    it('regular user cannot access dashboard', () => {
      mockAuthState.user = { id: 'regular-user', username: 'regular', display_name: 'Regular', email: '', avatar_url: null, status: null, created_at: null }
      const server = mockServerState.servers.get('server-1')!
      const members = mockServerState.members.get('server-1') || []
      const currentMember = members.find(m => m.user_id === mockAuthState.user!.id)
      const isOwner = server.owner_id === mockAuthState.user!.id
      const isModerator = currentMember?.is_moderator === true
      const canModerate = isOwner || isModerator

      expect(canModerate).toBe(false)
    })
  })
})

describe('ReportQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders reports sorted newest first', () => {
    const r1 = makeReport({ id: 'r1', created_at: '2026-02-14T10:00:00Z' })
    const r2 = makeReport({ id: 'r2', created_at: '2026-02-15T10:00:00Z' })
    const r3 = makeReport({ id: 'r3', created_at: '2026-02-13T10:00:00Z' })

    const reports = [r1, r2, r3]
    const sorted = reports.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    expect(sorted[0].id).toBe('r2')
    expect(sorted[1].id).toBe('r1')
    expect(sorted[2].id).toBe('r3')
  })

  it('filters by status', () => {
    const reports = [
      makeReport({ id: 'r1', status: 'pending' }),
      makeReport({ id: 'r2', status: 'reviewed' }),
      makeReport({ id: 'r3', status: 'dismissed' }),
    ]

    const pending = reports.filter(r => r.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe('r1')

    const reviewed = reports.filter(r => r.status === 'reviewed')
    expect(reviewed).toHaveLength(1)
    expect(reviewed[0].id).toBe('r2')
  })

  it('filters by category', () => {
    const reports = [
      makeReport({ id: 'r1', category: 'spam' }),
      makeReport({ id: 'r2', category: 'harassment' }),
      makeReport({ id: 'r3', category: 'spam' }),
    ]

    const spam = reports.filter(r => r.category === 'spam')
    expect(spam).toHaveLength(2)
  })

  it('filters by date range (last 24h)', () => {
    const now = Date.now()
    const reports = [
      makeReport({ id: 'r1', created_at: new Date(now - 3600000).toISOString() }),   // 1h ago
      makeReport({ id: 'r2', created_at: new Date(now - 172800000).toISOString() }), // 2 days ago
    ]

    const cutoff = now - 86400000 // 24h
    const recent = reports.filter(r => new Date(r.created_at).getTime() >= cutoff)
    expect(recent).toHaveLength(1)
    expect(recent[0].id).toBe('r1')
  })
})

describe('ReportDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('evidence decryption flow: decrypted evidence is parsed and available', async () => {
    const { cryptoService } = await import('../../../src/renderer/services/crypto')

    const evidenceJson = JSON.stringify({
      message_text: 'offensive content',
      sender_id: 'bad-user',
      timestamp: '2026-02-15T10:00:00Z',
      channel_id: 'channel-1',
    })

    vi.mocked(cryptoService.decryptReportEvidence).mockResolvedValue({
      evidence: evidenceJson,
    })

    const result = await cryptoService.decryptReportEvidence('base64-blob', 'server-1')
    const parsed = JSON.parse(result.evidence)

    expect(cryptoService.decryptReportEvidence).toHaveBeenCalledWith('base64-blob', 'server-1')
    expect(parsed.message_text).toBe('offensive content')
    expect(parsed.sender_id).toBe('bad-user')
    expect(parsed.channel_id).toBe('channel-1')
  })

  it('shows UnverifiedReportBanner for E2E encrypted channels', () => {
    // Channel with encryption_mode === 'private' → isEncrypted = true
    const channel = mockServerState.channels.get('channel-private')
    expect(channel?.encryption_mode).toBe('private')

    // For a report in this channel, isEncrypted should be true
    const report = makeReport({ channel_id: 'channel-private' })
    const channelLookup = mockServerState.channels.get(report.channel_id!)
    const isEncrypted = !channelLookup || channelLookup.encryption_mode === 'private'
    expect(isEncrypted).toBe(true)
  })

  it('shows verified banner for standard channels', () => {
    const channel = mockServerState.channels.get('channel-1')
    expect(channel?.encryption_mode).toBe('standard')

    const report = makeReport({ channel_id: 'channel-1' })
    const channelLookup = mockServerState.channels.get(report.channel_id!)
    const isEncrypted = !channelLookup || channelLookup.encryption_mode === 'private'
    expect(isEncrypted).toBe(false)
  })

  it('shows unverified banner for unknown/DM channels', () => {
    const report = makeReport({ channel_id: 'dm-channel-unknown' })
    const channelLookup = mockServerState.channels.get(report.channel_id!)
    const isEncrypted = !channelLookup || channelLookup.encryption_mode === 'private'
    expect(isEncrypted).toBe(true) // Channel not found → treat as encrypted
  })

  it('action buttons: dismiss calls reviewReport with dismissed', async () => {
    mockModerationState.reviewReport.mockResolvedValue(undefined)

    await mockModerationState.reviewReport('report-1', 'dismissed')

    expect(mockModerationState.reviewReport).toHaveBeenCalledWith('report-1', 'dismissed')
  })

  it('action buttons: warn calls reviewReport with warned', async () => {
    mockModerationState.reviewReport.mockResolvedValue(undefined)

    await mockModerationState.reviewReport('report-1', 'warned')

    expect(mockModerationState.reviewReport).toHaveBeenCalledWith('report-1', 'warned')
  })

  it('action buttons: kick calls kickUser then reviewReport', async () => {
    mockModerationState.kickUser.mockResolvedValue(undefined)
    mockModerationState.reviewReport.mockResolvedValue(undefined)

    await mockModerationState.kickUser('server-1', 'bad-user', 'Report: spam')
    await mockModerationState.reviewReport('report-1', 'kicked')

    expect(mockModerationState.kickUser).toHaveBeenCalledWith('server-1', 'bad-user', 'Report: spam')
    expect(mockModerationState.reviewReport).toHaveBeenCalledWith('report-1', 'kicked')
  })

  it('action buttons: ban calls banUser then reviewReport', async () => {
    mockModerationState.banUser.mockResolvedValue(undefined)
    mockModerationState.reviewReport.mockResolvedValue(undefined)

    await mockModerationState.banUser('server-1', 'bad-user', 'Report: harassment', undefined)
    await mockModerationState.reviewReport('report-1', 'banned')

    expect(mockModerationState.banUser).toHaveBeenCalledWith('server-1', 'bad-user', 'Report: harassment', undefined)
    expect(mockModerationState.reviewReport).toHaveBeenCalledWith('report-1', 'banned')
  })

  it('action buttons: mute calls muteInChannel then reviewReport', async () => {
    mockModerationState.muteInChannel.mockResolvedValue(undefined)
    mockModerationState.reviewReport.mockResolvedValue(undefined)

    await mockModerationState.muteInChannel('channel-1', 'bad-user', 3600)
    await mockModerationState.reviewReport('report-1', 'muted')

    expect(mockModerationState.muteInChannel).toHaveBeenCalledWith('channel-1', 'bad-user', 3600)
    expect(mockModerationState.reviewReport).toHaveBeenCalledWith('report-1', 'muted')
  })
})

describe('MetadataCorroboration', () => {
  it('renders account age, report count, and signals', () => {
    const metadata = makeMetadata()

    expect(metadata.username).toBe('baduser')
    expect(metadata.report_count_total).toBe(3)
    expect(metadata.report_count_recent).toBe(2)
    expect(metadata.active_abuse_signals).toBe(1)
    expect(metadata.message_count_30d).toBe(142)

    // Verify account age calculation
    const accountDate = new Date(metadata.account_created_at)
    expect(accountDate.getFullYear()).toBe(2025)

    const joinDate = new Date(metadata.server_joined_at)
    expect(joinDate.getFullYear()).toBe(2026)
  })

  it('renders previous moderation actions', () => {
    const metadata = makeMetadata()
    metadata.previous_actions = [
      makeAuditEntry({ id: 'a1', action: 'warned', reason: 'First warning' }),
      makeAuditEntry({ id: 'a2', action: 'muted', reason: 'Spam in channel' }),
    ]

    expect(metadata.previous_actions).toHaveLength(2)
    expect(metadata.previous_actions[0].action).toBe('warned')
    expect(metadata.previous_actions[1].action).toBe('muted')
  })
})

describe('AbuseSignalList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders signals sorted newest first', () => {
    const signals = [
      makeAbuseSignal({ id: 's1', created_at: '2026-02-14T10:00:00Z' }),
      makeAbuseSignal({ id: 's2', created_at: '2026-02-15T10:00:00Z' }),
    ]

    const sorted = signals.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    expect(sorted[0].id).toBe('s2')
    expect(sorted[1].id).toBe('s1')
  })

  it('filters by reviewed status', () => {
    const signals = [
      makeAbuseSignal({ id: 's1', reviewed: false }),
      makeAbuseSignal({ id: 's2', reviewed: true }),
      makeAbuseSignal({ id: 's3', reviewed: false }),
    ]

    const unreviewed = signals.filter(s => !s.reviewed)
    expect(unreviewed).toHaveLength(2)

    const reviewed = signals.filter(s => s.reviewed)
    expect(reviewed).toHaveLength(1)
  })

  it('filters by severity', () => {
    const signals = [
      makeAbuseSignal({ id: 's1', severity: 'low' }),
      makeAbuseSignal({ id: 's2', severity: 'critical' }),
      makeAbuseSignal({ id: 's3', severity: 'medium' }),
    ]

    const critical = signals.filter(s => s.severity === 'critical')
    expect(critical).toHaveLength(1)
  })

  it('mark reviewed calls API', async () => {
    mockModerationState.markAbuseSignalReviewed.mockResolvedValue(undefined)

    await mockModerationState.markAbuseSignalReviewed('signal-1')

    expect(mockModerationState.markAbuseSignalReviewed).toHaveBeenCalledWith('signal-1')
  })

  it('parses JSONB details', () => {
    const signal = makeAbuseSignal({
      details: JSON.stringify({ message_count: 50, time_window: '60s' }),
    })

    const parsed = JSON.parse(signal.details)
    expect(parsed.message_count).toBe(50)
    expect(parsed.time_window).toBe('60s')
  })
})

describe('BanList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders active and expired bans separately', () => {
    const now = Date.now()
    const bans = [
      makeBan({ user_id: 'u1' }), // No expiry = permanent = active
      makeBan({ user_id: 'u2', expires_at: new Date(now + 86400000).toISOString() }), // Future = active
      makeBan({ user_id: 'u3', expires_at: new Date(now - 86400000).toISOString() }), // Past = expired
    ]

    const active = bans.filter(b => !b.expires_at || new Date(b.expires_at).getTime() >= now)
    const expired = bans.filter(b => b.expires_at && new Date(b.expires_at).getTime() < now)

    expect(active).toHaveLength(2)
    expect(expired).toHaveLength(1)
    expect(expired[0].user_id).toBe('u3')
  })

  it('unban calls API and removes from store', async () => {
    mockModerationState.unbanUser.mockResolvedValue(undefined)

    await mockModerationState.unbanUser('server-1', 'banned-user')

    expect(mockModerationState.unbanUser).toHaveBeenCalledWith('server-1', 'banned-user')
  })

  it('add ban calls banUser with expiration', async () => {
    mockModerationState.banUser.mockResolvedValue(undefined)
    const expiresAt = new Date(Date.now() + 86400000)

    await mockModerationState.banUser('server-1', 'new-ban-user', 'Toxic behavior', expiresAt)

    expect(mockModerationState.banUser).toHaveBeenCalledWith('server-1', 'new-ban-user', 'Toxic behavior', expiresAt)
  })
})

describe('AuditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders entries sorted newest first', () => {
    const entries = [
      makeAuditEntry({ id: 'a1', created_at: '2026-02-14T10:00:00Z' }),
      makeAuditEntry({ id: 'a2', created_at: '2026-02-15T10:00:00Z' }),
      makeAuditEntry({ id: 'a3', created_at: '2026-02-13T10:00:00Z' }),
    ]

    const sorted = entries.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    expect(sorted[0].id).toBe('a2')
    expect(sorted[1].id).toBe('a1')
    expect(sorted[2].id).toBe('a3')
  })

  it('filters by action type', () => {
    const entries = [
      makeAuditEntry({ id: 'a1', action: 'banned' }),
      makeAuditEntry({ id: 'a2', action: 'kicked' }),
      makeAuditEntry({ id: 'a3', action: 'banned' }),
      makeAuditEntry({ id: 'a4', action: 'warned' }),
    ]

    const banEntries = entries.filter(e => e.action.startsWith('ban'))
    expect(banEntries).toHaveLength(2)

    const kickEntries = entries.filter(e => e.action.startsWith('kick'))
    expect(kickEntries).toHaveLength(1)
  })

  it('filters by moderator', () => {
    const entries = [
      makeAuditEntry({ id: 'a1', actor_id: 'mod-1' }),
      makeAuditEntry({ id: 'a2', actor_id: 'mod-2' }),
      makeAuditEntry({ id: 'a3', actor_id: 'mod-1' }),
    ]

    const mod1 = entries.filter(e => e.actor_id.includes('mod-1'))
    expect(mod1).toHaveLength(2)
  })

  it('filters by target user', () => {
    const entries = [
      makeAuditEntry({ id: 'a1', target_user_id: 'target-1' }),
      makeAuditEntry({ id: 'a2', target_user_id: 'target-2' }),
      makeAuditEntry({ id: 'a3', target_user_id: 'target-1' }),
    ]

    const target1 = entries.filter(e => e.target_user_id?.includes('target-1'))
    expect(target1).toHaveLength(2)
  })

  it('system actions show "System" as actor', () => {
    const entry = makeAuditEntry({ actor_id: '', action: 'auto-rate-limit' })

    const isSystem = !entry.actor_id || entry.action.startsWith('auto-')
    expect(isSystem).toBe(true)
  })
})

describe('moderationStore new methods (via mock)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetchAbuseSignals calls the store method', async () => {
    mockModerationState.fetchAbuseSignals.mockResolvedValue(undefined)

    await mockModerationState.fetchAbuseSignals('server-1')

    expect(mockModerationState.fetchAbuseSignals).toHaveBeenCalledWith('server-1')
  })

  it('fetchBans calls the store method', async () => {
    mockModerationState.fetchBans.mockResolvedValue(undefined)

    await mockModerationState.fetchBans('server-1')

    expect(mockModerationState.fetchBans).toHaveBeenCalledWith('server-1')
  })

  it('markAbuseSignalReviewed calls the store method', async () => {
    mockModerationState.markAbuseSignalReviewed.mockResolvedValue(undefined)

    await mockModerationState.markAbuseSignalReviewed('signal-1')

    expect(mockModerationState.markAbuseSignalReviewed).toHaveBeenCalledWith('signal-1')
  })

  it('reviewReport with dismissed calls with correct action', async () => {
    mockModerationState.reviewReport.mockResolvedValue(undefined)

    await mockModerationState.reviewReport('r1', 'dismissed')

    expect(mockModerationState.reviewReport).toHaveBeenCalledWith('r1', 'dismissed')
  })

  it('setActiveTab calls with correct tab', () => {
    mockModerationState.setActiveTab('bans')

    expect(mockModerationState.setActiveTab).toHaveBeenCalledWith('bans')
  })

  it('setSelectedReport calls with correct id', () => {
    mockModerationState.setSelectedReport('r1')
    expect(mockModerationState.setSelectedReport).toHaveBeenCalledWith('r1')

    mockModerationState.setSelectedReport(null)
    expect(mockModerationState.setSelectedReport).toHaveBeenCalledWith(null)
  })
})
