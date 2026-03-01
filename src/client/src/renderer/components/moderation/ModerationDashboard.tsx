import React, { useEffect } from 'react'
import { useModerationStore } from '../../stores/moderationStore'
import { ReportQueue } from './ReportQueue'
import { ReportDetail } from './ReportDetail'
import { AbuseSignalList } from './AbuseSignalList'
import { BanList } from './BanList'
import { AuditLog } from './AuditLog'

interface ModerationDashboardProps {
  serverId: string
  serverName: string
  onClose: () => void
}

const TABS = [
  { key: 'reports' as const, label: 'Reports' },
  { key: 'abuse_signals' as const, label: 'Abuse Signals' },
  { key: 'bans' as const, label: 'Bans' },
  { key: 'audit_log' as const, label: 'Audit Log' },
]

export function ModerationDashboard({ serverId, serverName, onClose }: ModerationDashboardProps): React.ReactElement {
  const activeTab = useModerationStore((s) => s.activeTab)
  const setActiveTab = useModerationStore((s) => s.setActiveTab)
  const selectedReportId = useModerationStore((s) => s.selectedReportId)
  const setSelectedReport = useModerationStore((s) => s.setSelectedReport)
  const pendingReportCount = useModerationStore((s) => s.pendingReportCount)
  const pendingAbuseSignalCount = useModerationStore((s) => s.pendingAbuseSignalCount)
  const fetchReports = useModerationStore((s) => s.fetchReports)
  const fetchAbuseSignals = useModerationStore((s) => s.fetchAbuseSignals)
  const fetchBans = useModerationStore((s) => s.fetchBans)
  const fetchAuditLog = useModerationStore((s) => s.fetchAuditLog)

  // Load data on mount
  useEffect(() => {
    fetchReports(serverId)
    fetchAbuseSignals(serverId)
    fetchBans(serverId)
    fetchAuditLog(serverId)
  }, [serverId, fetchReports, fetchAbuseSignals, fetchBans, fetchAuditLog])

  // Reset selected report when closing
  useEffect(() => {
    return () => setSelectedReport(null)
  }, [setSelectedReport])

  const badgeCounts: Record<string, number> = {
    reports: pendingReportCount,
    abuse_signals: pendingAbuseSignalCount,
  }

  // If a report is selected, show ReportDetail
  if (selectedReportId) {
    return (
      <div className="flex h-full flex-col bg-bg-secondary">
        <ReportDetail
          reportId={selectedReportId}
          serverId={serverId}
          onBack={() => setSelectedReport(null)}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg-secondary">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
        <div className="flex items-center gap-2">
          <span className="text-text-muted">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path fillRule="evenodd" d="M9.661 2.237a.531.531 0 0 1 .678 0 11.947 11.947 0 0 0 7.078 2.749.5.5 0 0 1 .479.425c.069.52.104 1.05.104 1.59 0 5.162-3.26 9.563-7.834 11.256a.48.48 0 0 1-.332 0C5.26 16.564 2 12.163 2 7c0-.54.035-1.07.104-1.59a.5.5 0 0 1 .48-.425 11.947 11.947 0 0 0 7.077-2.749Z" clipRule="evenodd" />
            </svg>
          </span>
          <span className="font-semibold text-text-primary">{serverName}</span>
          <span className="text-sm text-text-muted">Moderation Dashboard</span>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          title="Close Dashboard"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Tab sidebar */}
        <div className="flex w-44 flex-col border-r border-border-subtle bg-bg-primary/30 p-2">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`mb-1 flex items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors ${
                activeTab === tab.key
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <span>{tab.label}</span>
              {(badgeCounts[tab.key] ?? 0) > 0 && (
                <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-bg-danger px-1.5 text-xs font-medium text-white">
                  {badgeCounts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'reports' && (
            <ReportQueue serverId={serverId} onSelectReport={setSelectedReport} />
          )}
          {activeTab === 'abuse_signals' && (
            <AbuseSignalList serverId={serverId} />
          )}
          {activeTab === 'bans' && (
            <BanList serverId={serverId} />
          )}
          {activeTab === 'audit_log' && (
            <AuditLog serverId={serverId} />
          )}
        </div>
      </div>
    </div>
  )
}
