import { create } from 'zustand'
import type { Report, AbuseSignal, Ban, AuditLogEntry, ReportSubmission } from '../types/models'
import { moderation as moderationApi } from '../services/api'

type DmPolicy = 'anyone' | 'mutual_servers' | 'nobody'
type DashboardTab = 'reports' | 'abuse_signals' | 'bans' | 'audit_log'

interface ModerationState {
  // User-level
  blockedUserIds: Set<string>
  dmPolicy: DmPolicy
  blockUser(userId: string): Promise<void>
  unblockUser(userId: string): Promise<void>
  setDmPolicy(policy: DmPolicy): Promise<void>
  loadBlockedUsers(): Promise<void>

  // Reporting
  submitReport(report: ReportSubmission): Promise<void>

  // Server moderation (owner/mod only)
  reports: Map<string, Report>
  abuseSignals: AbuseSignal[]
  bans: Map<string, Ban>
  auditLog: AuditLogEntry[]
  fetchReports(serverId: string): Promise<void>
  reviewReport(reportId: string, action: string): Promise<void>
  banUser(serverId: string, userId: string, reason: string, expiresAt?: Date): Promise<void>
  unbanUser(serverId: string, userId: string): Promise<void>
  kickUser(serverId: string, userId: string, reason: string): Promise<void>
  muteInChannel(channelId: string, userId: string, duration?: number): Promise<void>
  fetchAuditLog(serverId: string): Promise<void>
  fetchAbuseSignals(serverId: string): Promise<void>
  fetchBans(serverId: string): Promise<void>
  markAbuseSignalReviewed(signalId: string): Promise<void>

  // Dashboard UI state
  activeTab: DashboardTab
  selectedReportId: string | null
  setActiveTab(tab: DashboardTab): void
  setSelectedReport(reportId: string | null): void

  // Mute tracking (current user)
  mutedChannels: Set<string>

  // Notification badges
  pendingReportCount: number
  pendingAbuseSignalCount: number
  incrementReportCount(): void
  incrementAbuseSignalCount(): void
  clearReportCount(): void
  clearAbuseSignalCount(): void
}

export const useModerationStore = create<ModerationState>((set, get) => ({
  blockedUserIds: new Set(),
  dmPolicy: 'anyone' as DmPolicy,
  reports: new Map(),
  abuseSignals: [],
  bans: new Map(),
  auditLog: [],
  mutedChannels: new Set(),
  pendingReportCount: 0,
  pendingAbuseSignalCount: 0,
  activeTab: 'reports' as DashboardTab,
  selectedReportId: null,

  async loadBlockedUsers() {
    try {
      const resp = await moderationApi.getBlocks()
      set({ blockedUserIds: new Set(resp.blocked_user_ids) })
    } catch {
      // Non-critical — start with empty set
    }
  },

  async blockUser(userId: string) {
    await moderationApi.blockUser(userId)
    set((state) => {
      const blockedUserIds = new Set(state.blockedUserIds)
      blockedUserIds.add(userId)
      return { blockedUserIds }
    })
  },

  async unblockUser(userId: string) {
    await moderationApi.unblockUser(userId)
    set((state) => {
      const blockedUserIds = new Set(state.blockedUserIds)
      blockedUserIds.delete(userId)
      return { blockedUserIds }
    })
  },

  async setDmPolicy(policy: DmPolicy) {
    await moderationApi.setDmPolicy(policy)
    set({ dmPolicy: policy })
  },

  async submitReport(report: ReportSubmission) {
    await moderationApi.submitReport({
      reported_user_id: report.reportedUserId,
      message_id: report.messageId,
      channel_id: report.channelId,
      category: report.category,
      description: report.description,
      evidence_blob: report.evidenceBlob,
    })
  },

  async fetchReports(serverId: string) {
    const reports = await moderationApi.getReports(serverId)
    const map = new Map<string, Report>()
    for (const r of reports) {
      map.set(r.id, r)
    }
    set({ reports: map, pendingReportCount: 0 })
  },

  async reviewReport(reportId: string, action: string) {
    await moderationApi.reviewReport(reportId, action)
    set((state) => {
      const reports = new Map(state.reports)
      const existing = reports.get(reportId)
      if (existing) {
        const status = action === 'dismissed' ? 'dismissed' as const : 'reviewed' as const
        reports.set(reportId, { ...existing, status, action_taken: action })
      }
      return { reports }
    })
  },

  async banUser(serverId: string, userId: string, reason: string, expiresAt?: Date) {
    await moderationApi.banUser(serverId, userId, reason, expiresAt?.toISOString())
    set((state) => {
      const bans = new Map(state.bans)
      bans.set(`${serverId}:${userId}`, {
        server_id: serverId,
        user_id: userId,
        reason,
        banned_by: '',  // Set by server
        expires_at: expiresAt?.toISOString(),
        created_at: new Date().toISOString(),
      })
      return { bans }
    })
  },

  async unbanUser(serverId: string, userId: string) {
    await moderationApi.unbanUser(serverId, userId)
    set((state) => {
      const bans = new Map(state.bans)
      bans.delete(`${serverId}:${userId}`)
      return { bans }
    })
  },

  async kickUser(serverId: string, userId: string, reason: string) {
    await moderationApi.kickUser(serverId, userId, reason)
  },

  async muteInChannel(channelId: string, userId: string, duration?: number) {
    await moderationApi.muteInChannel(channelId, userId, duration)
  },

  async fetchAuditLog(serverId: string) {
    const log = await moderationApi.getAuditLog(serverId)
    set({ auditLog: log })
  },

  async fetchAbuseSignals(serverId: string) {
    const signals = await moderationApi.getAbuseSignals(serverId)
    set({ abuseSignals: signals, pendingAbuseSignalCount: 0 })
  },

  async fetchBans(serverId: string) {
    const bansList = await moderationApi.getBans(serverId)
    const map = new Map<string, Ban>()
    for (const b of bansList) {
      map.set(`${b.server_id}:${b.user_id}`, b)
    }
    set({ bans: map })
  },

  async markAbuseSignalReviewed(signalId: string) {
    await moderationApi.markAbuseSignalReviewed(signalId)
    set((state) => ({
      abuseSignals: state.abuseSignals.map((s) =>
        s.id === signalId ? { ...s, reviewed: true } : s
      ),
    }))
  },

  setActiveTab(tab: DashboardTab) {
    set({ activeTab: tab })
  },

  setSelectedReport(reportId: string | null) {
    set({ selectedReportId: reportId })
  },

  incrementReportCount() {
    set((state) => ({ pendingReportCount: state.pendingReportCount + 1 }))
  },

  incrementAbuseSignalCount() {
    set((state) => ({ pendingAbuseSignalCount: state.pendingAbuseSignalCount + 1 }))
  },

  clearReportCount() {
    set({ pendingReportCount: 0 })
  },

  clearAbuseSignalCount() {
    set({ pendingAbuseSignalCount: 0 })
  },
}))
