import React, { useState } from 'react'
import { useServerStore } from '../../stores/serverStore'

interface CreateServerModalProps {
  onClose: () => void
}

export function CreateServerModal({ onClose }: CreateServerModalProps): React.ReactElement {
  const [name, setName] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const createServer = useServerStore((s) => s.createServer)
  const setActiveServer = useServerStore((s) => s.setActiveServer)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setIsLoading(true)
    setError('')
    try {
      const server = await createServer(name.trim())
      setActiveServer(server.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create server')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-bg-secondary p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-xl font-bold text-text-primary">Create a Server</h2>

        {error && (
          <div className="mb-4 rounded bg-bg-danger/20 px-4 py-2 text-sm text-red-400">{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <label className="mb-2 block text-xs font-bold uppercase text-text-secondary">
            Server Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            className="mb-4 w-full rounded bg-bg-input px-3 py-2 text-text-primary outline-none focus:ring-2 focus:ring-bg-accent"
            placeholder="My Awesome Server"
            autoFocus
          />

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !name.trim()}
              className="rounded bg-bg-accent px-4 py-2 font-medium text-white hover:bg-bg-accent-hover disabled:opacity-50"
            >
              {isLoading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
