import React, { useState } from 'react'
import { useModerationStore } from '../../stores/moderationStore'

interface AddBanDialogProps {
  serverId: string
  onClose: () => void
}

const BAN_DURATIONS = [
  { label: 'Permanent', value: null },
  { label: '1 Hour', value: 3600000 },
  { label: '24 Hours', value: 86400000 },
  { label: '7 Days', value: 604800000 },
  { label: '30 Days', value: 2592000000 },
]

export function AddBanDialog({ serverId, onClose }: AddBanDialogProps): React.ReactElement {
  const banUser = useModerationStore((s) => s.banUser)
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!userId.trim() || !reason.trim()) return

    setLoading(true)
    setError(null)
    try {
      const expiresAt = duration ? new Date(Date.now() + duration) : undefined
      await banUser(serverId, userId.trim(), reason.trim(), expiresAt)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to ban user')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[28rem] rounded-lg bg-bg-secondary p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-bold text-text-primary">Ban User</h2>

        <form onSubmit={handleSubmit}>
          <label className="mb-2 block text-sm font-medium text-text-secondary">User ID</label>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="Enter user ID"
            className="mb-4 w-full rounded bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:ring-2 focus:ring-bg-accent"
            disabled={loading}
          />

          <label className="mb-2 block text-sm font-medium text-text-secondary">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for ban..."
            className="mb-4 w-full rounded bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:ring-2 focus:ring-bg-accent"
            rows={2}
            disabled={loading}
          />

          <label className="mb-2 block text-sm font-medium text-text-secondary">Duration</label>
          <select
            value={duration === null ? 'permanent' : String(duration)}
            onChange={(e) => setDuration(e.target.value === 'permanent' ? null : Number(e.target.value))}
            className="mb-4 w-full rounded bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none"
            disabled={loading}
          >
            {BAN_DURATIONS.map((d) => (
              <option key={d.label} value={d.value === null ? 'permanent' : String(d.value)}>
                {d.label}
              </option>
            ))}
          </select>

          {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !userId.trim() || !reason.trim()}
              className="rounded bg-bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Banning...' : 'Ban User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
