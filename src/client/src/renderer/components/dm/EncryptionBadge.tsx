import React from 'react'

interface EncryptionBadgeProps {
  mode?: 'standard' | 'private' | 'e2e_dm'
}

// Lock icon SVG for private channels
function LockIcon(): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5"
    >
      <path
        fillRule="evenodd"
        d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

// Shield icon SVG for DMs
function ShieldIcon(): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5"
    >
      <path
        fillRule="evenodd"
        d="M8 1.027a.75.75 0 0 1 .552.242l4.5 4.5A.75.75 0 0 1 12.5 7v4.5a.75.75 0 0 1-.22.53l-4 4a.75.75 0 0 1-1.06 0l-4-4A.75.75 0 0 1 3 11.5V7a.75.75 0 0 1-.552-1.231l4.5-4.5A.75.75 0 0 1 8 1.027ZM4.5 7.31v3.88L8 14.69l3.5-3.5V7.31L8 3.81 4.5 7.31Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

export function EncryptionBadge({ mode }: EncryptionBadgeProps): React.ReactElement | null {
  // Backwards-compatible: no mode prop = DM mode (existing behavior)
  const effectiveMode = mode ?? 'e2e_dm'

  if (effectiveMode === 'standard') return null

  if (effectiveMode === 'private') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-status-online"
        title="End-to-end encrypted. Only channel members can read messages."
      >
        <LockIcon />
        Encrypted
      </span>
    )
  }

  // e2e_dm
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-status-online"
      title="End-to-end encrypted. Only you and the recipient can read these messages."
    >
      <ShieldIcon />
      Encrypted
    </span>
  )
}

/** Small lock icon for channel list — no text, just the icon. */
export function ChannelLockIcon(): React.ReactElement {
  return (
    <span
      className="inline-flex text-status-online"
      title="End-to-end encrypted"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="h-3 w-3"
      >
        <path
          fillRule="evenodd"
          d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z"
          clipRule="evenodd"
        />
      </svg>
    </span>
  )
}
