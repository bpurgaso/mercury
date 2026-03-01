import React, { useMemo, useState } from 'react'
import { useModerationStore } from '../../stores/moderationStore'

interface AuditLogProps {
  serverId: string
}

type ActionFilter = 'all' | 'ban' | 'kick' | 'mute' | 'warn' | 'unban' | 'dismissed'

const ACTION_BADGE_CLASSES: Record<string, string> = {
  ban: 'bg-red-500/20 text-red-400',
  banned: 'bg-red-500/20 text-red-400',
  kick: 'bg-orange-500/20 text-orange-400',
  kicked: 'bg-orange-500/20 text-orange-400',
  mute: 'bg-yellow-500/20 text-yellow-400',
  muted: 'bg-yellow-500/20 text-yellow-400',
  warn: 'bg-blue-500/20 text-blue-400',
  warned: 'bg-blue-500/20 text-blue-400',
  unban: 'bg-green-500/20 text-green-400',
  dismissed: 'bg-gray-500/20 text-gray-400',
  'auto-rate-limit': 'bg-purple-500/20 text-purple-400',
}

function getActionBadgeClass(action: string): string {
  return ACTION_BADGE_CLASSES[action] || 'bg-gray-500/20 text-gray-400'
}

export function AuditLog({ serverId }: AuditLogProps): React.ReactElement {
  const auditLog = useModerationStore((s) => s.auditLog)
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all')
  const [moderatorFilter, setModeratorFilter] = useState('')
  const [targetFilter, setTargetFilter] = useState('')

  const filteredEntries = useMemo(() => {
    return auditLog
      .filter((e) => e.server_id === serverId)
      .filter((e) => actionFilter === 'all' || e.action.startsWith(actionFilter))
      .filter((e) => !moderatorFilter || (e.actor_id && e.actor_id.toLowerCase().includes(moderatorFilter.toLowerCase())))
      .filter((e) => !targetFilter || (e.target_user_id && e.target_user_id.toLowerCase().includes(targetFilter.toLowerCase())))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [auditLog, serverId, actionFilter, moderatorFilter, targetFilter])

  return (
    <div className="p-4">
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">Action:</span>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value as ActionFilter)}
            className="rounded bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none"
          >
            <option value="all">All</option>
            <option value="ban">Ban</option>
            <option value="unban">Unban</option>
            <option value="kick">Kick</option>
            <option value="mute">Mute</option>
            <option value="warn">Warn</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">Moderator:</span>
          <input
            type="text"
            value={moderatorFilter}
            onChange={(e) => setModeratorFilter(e.target.value)}
            placeholder="Filter..."
            className="w-24 rounded bg-bg-tertiary px-2 py-1 text-xs text-text-primary placeholder-text-muted outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">Target:</span>
          <input
            type="text"
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value)}
            placeholder="Filter..."
            className="w-24 rounded bg-bg-tertiary px-2 py-1 text-xs text-text-primary placeholder-text-muted outline-none"
          />
        </div>
      </div>

      {/* Log entries */}
      {filteredEntries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-muted">
          <p className="text-sm">No audit log entries found</p>
        </div>
      ) : (
        <div className="space-y-1">
          {filteredEntries.map((entry) => {
            const isSystem = !entry.actor_id || entry.action.startsWith('auto-')
            return (
              <div key={entry.id} className="flex items-center gap-3 rounded bg-bg-tertiary px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">
                      {new Date(entry.created_at).toLocaleString()}
                    </span>
                    <span className="text-sm font-medium text-text-primary">
                      {isSystem ? 'System' : entry.actor_id.slice(0, 8)}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${getActionBadgeClass(entry.action)}`}>
                      {entry.action}
                    </span>
                    {entry.target_user_id && (
                      <>
                        <span className="text-xs text-text-muted">on</span>
                        <span className="text-sm text-text-primary">{entry.target_user_id.slice(0, 8)}</span>
                      </>
                    )}
                  </div>
                  {entry.reason && (
                    <p className="mt-0.5 text-xs text-text-muted">{entry.reason}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
