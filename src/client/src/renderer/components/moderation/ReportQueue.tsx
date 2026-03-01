import React, { useMemo, useState } from 'react'
import { useModerationStore } from '../../stores/moderationStore'
import type { ReportCategory } from '../../types/models'

interface ReportQueueProps {
  serverId: string
  onSelectReport: (reportId: string) => void
}

type StatusFilter = 'all' | 'pending' | 'reviewed' | 'dismissed'
type DateFilter = 'all' | '24h' | '7d' | '30d'

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'dismissed', label: 'Dismissed' },
]

const CATEGORY_OPTIONS: { value: ReportCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'illegal', label: 'Illegal' },
  { value: 'csam', label: 'CSAM' },
  { value: 'other', label: 'Other' },
]

const DATE_OPTIONS: { value: DateFilter; label: string }[] = [
  { value: 'all', label: 'All Time' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
]

const STATUS_BADGE_CLASSES: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  reviewed: 'bg-blue-500/20 text-blue-400',
  dismissed: 'bg-gray-500/20 text-gray-400',
}

function getRelativeTime(dateStr: string): string {
  const now = Date.now()
  const date = new Date(dateStr).getTime()
  const diffMs = now - date
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function getDateCutoff(filter: DateFilter): number {
  if (filter === 'all') return 0
  const now = Date.now()
  const ms = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }
  return now - ms[filter]
}

export function ReportQueue({ serverId, onSelectReport }: ReportQueueProps): React.ReactElement {
  const reports = useModerationStore((s) => s.reports)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState<ReportCategory | 'all'>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')

  const filteredReports = useMemo(() => {
    const arr = Array.from(reports.values())
      .filter((r) => r.server_id === serverId)
      .filter((r) => statusFilter === 'all' || r.status === statusFilter)
      .filter((r) => categoryFilter === 'all' || r.category === categoryFilter)
      .filter((r) => {
        const cutoff = getDateCutoff(dateFilter)
        return cutoff === 0 || new Date(r.created_at).getTime() >= cutoff
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    return arr
  }, [reports, serverId, statusFilter, categoryFilter, dateFilter])

  return (
    <div className="p-4">
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">Status:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">Category:</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as ReportCategory | 'all')}
            className="rounded bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">Date:</span>
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value as DateFilter)}
            className="rounded bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
          >
            {DATE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Report list */}
      {filteredReports.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-muted">
          <p className="text-sm">No reports found</p>
          <p className="mt-1 text-xs">Adjust your filters or check back later</p>
        </div>
      ) : (
        <div className="space-y-1">
          {filteredReports.map((report) => (
            <button
              key={report.id}
              onClick={() => onSelectReport(report.id)}
              className="flex w-full items-center gap-3 rounded px-3 py-2.5 text-left transition-colors hover:bg-bg-hover"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    {report.reporter_id.slice(0, 8)}
                  </span>
                  <span className="text-xs text-text-muted">reported</span>
                  <span className="text-sm font-medium text-text-primary">
                    {report.reported_user_id.slice(0, 8)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-secondary">
                    {report.category}
                  </span>
                  <span className="text-xs text-text-muted">{getRelativeTime(report.created_at)}</span>
                </div>
              </div>
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[report.status] || ''}`}>
                {report.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
