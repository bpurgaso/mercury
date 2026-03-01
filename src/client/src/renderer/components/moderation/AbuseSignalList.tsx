import React, { useMemo, useState } from 'react'
import { useModerationStore } from '../../stores/moderationStore'
import type { AbuseSignal } from '../../types/models'

interface AbuseSignalListProps {
  serverId: string
}

type ReviewedFilter = 'all' | 'unreviewed' | 'reviewed'
type SeverityFilter = 'all' | 'low' | 'medium' | 'high' | 'critical'

const SEVERITY_CLASSES: Record<string, string> = {
  low: 'bg-gray-500/20 text-gray-400',
  medium: 'bg-yellow-500/20 text-yellow-400',
  high: 'bg-orange-500/20 text-orange-400',
  critical: 'bg-red-500/20 text-red-400',
}

function parseDetails(details: string): Record<string, unknown> | null {
  try {
    return JSON.parse(details) as Record<string, unknown>
  } catch {
    return null
  }
}

function getRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(dateStr).toLocaleDateString()
}

export function AbuseSignalList({ serverId }: AbuseSignalListProps): React.ReactElement {
  const abuseSignals = useModerationStore((s) => s.abuseSignals)
  const markAbuseSignalReviewed = useModerationStore((s) => s.markAbuseSignalReviewed)
  const [reviewedFilter, setReviewedFilter] = useState<ReviewedFilter>('all')
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [markingReviewed, setMarkingReviewed] = useState<string | null>(null)

  const filteredSignals = useMemo(() => {
    return abuseSignals
      .filter((s) => s.server_id === serverId)
      .filter((s) => {
        if (reviewedFilter === 'reviewed') return s.reviewed
        if (reviewedFilter === 'unreviewed') return !s.reviewed
        return true
      })
      .filter((s) => severityFilter === 'all' || s.severity === severityFilter)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [abuseSignals, serverId, reviewedFilter, severityFilter])

  const handleMarkReviewed = async (signal: AbuseSignal) => {
    setMarkingReviewed(signal.id)
    try {
      await markAbuseSignalReviewed(signal.id)
    } finally {
      setMarkingReviewed(null)
    }
  }

  return (
    <div className="p-4">
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">Status:</span>
          <select
            value={reviewedFilter}
            onChange={(e) => setReviewedFilter(e.target.value as ReviewedFilter)}
            className="rounded bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
          >
            <option value="all">All</option>
            <option value="unreviewed">Unreviewed</option>
            <option value="reviewed">Reviewed</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">Severity:</span>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}
            className="rounded bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
          >
            <option value="all">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      {/* Signal list */}
      {filteredSignals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-muted">
          <p className="text-sm">No abuse signals found</p>
        </div>
      ) : (
        <div className="space-y-1">
          {filteredSignals.map((signal) => {
            const isExpanded = expandedId === signal.id
            const details = parseDetails(signal.details)

            return (
              <div key={signal.id} className="rounded bg-bg-tertiary">
                <button
                  onClick={() => setExpandedId(isExpanded ? null : signal.id)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">
                        {signal.user_id.slice(0, 8)}
                      </span>
                      <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-xs text-text-secondary">
                        {signal.signal_type}
                      </span>
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_CLASSES[signal.severity] || ''}`}>
                        {signal.severity}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="text-xs text-text-muted">{getRelativeTime(signal.created_at)}</span>
                      {signal.auto_action && (
                        <span className="text-xs text-text-muted">Auto: {signal.auto_action}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {signal.reviewed ? (
                      <span className="text-xs text-green-400">Reviewed</span>
                    ) : (
                      <span className="text-xs text-yellow-400">Unreviewed</span>
                    )}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className={`h-4 w-4 text-text-muted transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    >
                      <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                    </svg>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-border-subtle px-3 py-3">
                    {details ? (
                      <div className="space-y-1">
                        {Object.entries(details).map(([key, value]) => (
                          <div key={key} className="flex gap-2 text-xs">
                            <span className="font-medium text-text-muted">{key}:</span>
                            <span className="text-text-secondary">{String(value)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-text-muted">{signal.details}</p>
                    )}

                    {!signal.reviewed && (
                      <button
                        onClick={() => handleMarkReviewed(signal)}
                        disabled={markingReviewed === signal.id}
                        className="mt-3 rounded bg-bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {markingReviewed === signal.id ? 'Marking...' : 'Mark Reviewed'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
