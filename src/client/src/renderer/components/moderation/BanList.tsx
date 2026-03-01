import React, { useMemo, useState } from 'react'
import { useModerationStore } from '../../stores/moderationStore'
import { ActionConfirmDialog } from './ActionConfirmDialog'
import { AddBanDialog } from './AddBanDialog'
import type { Ban } from '../../types/models'

interface BanListProps {
  serverId: string
}

function isBanExpired(ban: Ban): boolean {
  if (!ban.expires_at) return false
  return new Date(ban.expires_at).getTime() < Date.now()
}

export function BanList({ serverId }: BanListProps): React.ReactElement {
  const bans = useModerationStore((s) => s.bans)
  const unbanUser = useModerationStore((s) => s.unbanUser)
  const [showAddBan, setShowAddBan] = useState(false)
  const [unbanTarget, setUnbanTarget] = useState<Ban | null>(null)

  const serverBans = useMemo(() => {
    return Array.from(bans.values())
      .filter((b) => b.server_id === serverId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [bans, serverId])

  const activeBans = serverBans.filter((b) => !isBanExpired(b))
  const expiredBans = serverBans.filter((b) => isBanExpired(b))

  const handleUnban = async () => {
    if (!unbanTarget) return
    await unbanUser(serverId, unbanTarget.user_id)
    setUnbanTarget(null)
  }

  return (
    <div className="p-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">
          Server Bans ({activeBans.length} active)
        </h3>
        <button
          onClick={() => setShowAddBan(true)}
          className="rounded bg-bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          Add Ban
        </button>
      </div>

      {/* Active Bans */}
      {activeBans.length === 0 && expiredBans.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-muted">
          <p className="text-sm">No bans found</p>
        </div>
      ) : (
        <>
          {activeBans.length > 0 && (
            <div className="mb-4 space-y-1">
              {activeBans.map((ban) => (
                <div key={`${ban.server_id}:${ban.user_id}`} className="flex items-center gap-3 rounded bg-bg-tertiary px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{ban.user_id.slice(0, 8)}</span>
                      {ban.expires_at ? (
                        <span className="text-xs text-text-muted">
                          Expires {new Date(ban.expires_at).toLocaleDateString()}
                        </span>
                      ) : (
                        <span className="text-xs text-red-400">Permanent</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
                      <span>By: {ban.banned_by ? ban.banned_by.slice(0, 8) : 'Unknown'}</span>
                      <span>Reason: {ban.reason}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setUnbanTarget(ban)}
                    className="rounded bg-green-600/20 px-2 py-1 text-xs font-medium text-green-400 hover:bg-green-600/30"
                  >
                    Unban
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Expired Bans */}
          {expiredBans.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase text-text-muted">Expired</p>
              <div className="space-y-1 opacity-60">
                {expiredBans.map((ban) => (
                  <div key={`${ban.server_id}:${ban.user_id}`} className="flex items-center gap-3 rounded bg-bg-tertiary px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{ban.user_id.slice(0, 8)}</span>
                        <span className="rounded bg-gray-500/20 px-1.5 py-0.5 text-xs text-gray-400">Expired</span>
                      </div>
                      <div className="mt-0.5 text-xs text-text-muted">
                        {ban.reason} — {new Date(ban.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Add Ban Dialog */}
      {showAddBan && (
        <AddBanDialog serverId={serverId} onClose={() => setShowAddBan(false)} />
      )}

      {/* Unban Confirmation */}
      {unbanTarget && (
        <ActionConfirmDialog
          title="Unban User"
          message={`Remove the ban on user ${unbanTarget.user_id.slice(0, 8)}? They will be able to rejoin the server.`}
          confirmLabel="Unban"
          confirmVariant="primary"
          onConfirm={handleUnban}
          onCancel={() => setUnbanTarget(null)}
        />
      )}
    </div>
  )
}
