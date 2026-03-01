import React, { useEffect, useState } from 'react'
import { moderation as moderationApi } from '../../services/api'
import type { UserModerationMetadata } from '../../types/models'

interface MetadataCorroborationProps {
  serverId: string
  userId: string
}

function getRelativeAge(dateStr: string): string {
  const now = Date.now()
  const date = new Date(dateStr).getTime()
  const diffMs = now - date
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays < 1) return 'today'
  if (diffDays === 1) return '1 day ago'
  if (diffDays < 30) return `${diffDays} days ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths === 1) return '1 month ago'
  if (diffMonths < 12) return `${diffMonths} months ago`
  const diffYears = Math.floor(diffMonths / 12)
  return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`
}

export function MetadataCorroboration({ serverId, userId }: MetadataCorroborationProps): React.ReactElement {
  const [metadata, setMetadata] = useState<UserModerationMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    moderationApi.getUserMetadata(serverId, userId)
      .then((data) => {
        if (!cancelled) setMetadata(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load metadata')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [serverId, userId])

  if (loading) {
    return (
      <div className="rounded-lg bg-bg-tertiary p-4">
        <p className="text-xs text-text-muted">Loading user metadata...</p>
      </div>
    )
  }

  if (error || !metadata) {
    return (
      <div className="rounded-lg bg-bg-tertiary p-4">
        <p className="text-xs text-red-400">{error || 'No metadata available'}</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg bg-bg-tertiary p-4">
      <h4 className="mb-3 text-xs font-semibold uppercase text-text-muted">User Context</h4>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-text-muted">Account Created</p>
          <p className="text-sm text-text-primary">{getRelativeAge(metadata.account_created_at)}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Joined Server</p>
          <p className="text-sm text-text-primary">{getRelativeAge(metadata.server_joined_at)}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Messages (30d)</p>
          <p className="text-sm text-text-primary">{metadata.message_count_30d}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Reports Received</p>
          <p className="text-sm text-text-primary">
            {metadata.report_count_total} total, {metadata.report_count_recent} recent
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Active Abuse Signals</p>
          <p className={`text-sm ${metadata.active_abuse_signals > 0 ? 'text-red-400' : 'text-text-primary'}`}>
            {metadata.active_abuse_signals}
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Username</p>
          <p className="text-sm text-text-primary">{metadata.username}</p>
        </div>
      </div>

      {metadata.previous_actions.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase text-text-muted">Previous Actions</p>
          <div className="space-y-1">
            {metadata.previous_actions.slice(0, 5).map((action) => (
              <div key={action.id} className="flex items-center gap-2 text-xs">
                <span className="text-text-muted">{new Date(action.created_at).toLocaleDateString()}</span>
                <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-text-secondary">{action.action}</span>
                {action.reason && <span className="truncate text-text-muted">{action.reason}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
