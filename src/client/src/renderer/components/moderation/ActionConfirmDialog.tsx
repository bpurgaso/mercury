import React, { useState } from 'react'

interface ActionConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  confirmVariant?: 'danger' | 'primary'
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export function ActionConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmVariant = 'danger',
  onConfirm,
  onCancel,
}: ActionConfirmDialogProps): React.ReactElement {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    setLoading(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
      setLoading(false)
    }
  }

  const btnClass = confirmVariant === 'danger'
    ? 'bg-bg-danger text-white hover:opacity-90'
    : 'bg-bg-accent text-white hover:opacity-90'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="w-96 rounded-lg bg-bg-secondary p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-2 text-lg font-bold text-text-primary">{title}</h3>
        <p className="mb-4 text-sm text-text-secondary">{message}</p>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className={`rounded px-4 py-2 text-sm font-medium disabled:opacity-50 ${btnClass}`}
          >
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
