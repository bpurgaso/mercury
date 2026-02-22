import React from 'react'

interface IdentityWarningDialogProps {
  recipientName: string
  onApprove: () => void
  onCancel: () => void
}

export function IdentityWarningDialog({
  recipientName,
  onApprove,
  onCancel,
}: IdentityWarningDialogProps): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-lg bg-bg-secondary p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-400">
            !
          </div>
          <h2 className="text-lg font-bold text-text-primary">Identity Changed</h2>
        </div>
        <p className="mb-4 text-sm text-text-secondary">
          The security verification for <strong className="text-text-primary">{recipientName}</strong> has
          changed. This could mean their account was compromised or they re-registered.
        </p>
        <p className="mb-6 text-sm text-text-muted">
          Do you want to continue sending this message?
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={onApprove}
            className="rounded bg-yellow-600 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-500"
          >
            Send Anyway
          </button>
        </div>
      </div>
    </div>
  )
}
