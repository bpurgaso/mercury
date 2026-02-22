import React, { useState } from 'react'
import { useDmChannelStore } from '../../stores/dmChannelStore'

interface NewDmModalProps {
  onClose: () => void
}

export function NewDmModal({ onClose }: NewDmModalProps): React.ReactElement {
  const [username, setUsername] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const createDmChannel = useDmChannelStore((s) => s.createDmChannel)
  const setActiveDmChannel = useDmChannelStore((s) => s.setActiveDmChannel)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) return

    setIsLoading(true)
    setError(null)

    try {
      // For now, we use the username as recipient_id
      // In a full implementation, we'd search for the user first
      const channel = await createDmChannel(username.trim())
      setActiveDmChannel(channel.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create DM')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-lg bg-bg-secondary p-6">
        <h2 className="mb-4 text-lg font-bold text-text-primary">New Direct Message</h2>
        <form onSubmit={handleSubmit}>
          <label className="mb-2 block text-sm text-text-secondary">
            Recipient User ID
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter user ID"
            className="mb-4 w-full rounded bg-bg-tertiary px-3 py-2 text-text-primary placeholder-text-muted outline-none focus:ring-2 focus:ring-bg-accent"
            autoFocus
            disabled={isLoading}
          />
          {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              disabled={isLoading || !username.trim()}
            >
              {isLoading ? 'Creating...' : 'Start Chat'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
