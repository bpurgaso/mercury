import React, { useState } from 'react'
import { useModerationStore } from '../../stores/moderationStore'

interface BlockConfirmDialogProps {
  userId: string
  username: string
  onClose: () => void
}

export function BlockConfirmDialog({ userId, username, onClose }: BlockConfirmDialogProps): React.ReactElement {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blockUser = useModerationStore((s) => s.blockUser)

  const handleConfirm = async () => {
    setIsLoading(true)
    setError(null)
    try {
      await blockUser(userId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to block user')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-96 rounded-lg bg-bg-secondary p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-lg font-bold text-text-primary">Block {username}?</h2>
        <p className="mb-4 text-sm text-text-secondary">
          They won&apos;t be able to message you or see your online status.
        </p>
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
            type="button"
            onClick={handleConfirm}
            className="rounded bg-bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={isLoading}
          >
            {isLoading ? 'Blocking...' : 'Block'}
          </button>
        </div>
      </div>
    </div>
  )
}
