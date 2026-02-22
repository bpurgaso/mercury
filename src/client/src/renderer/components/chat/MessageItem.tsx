import React from 'react'
import type { Message } from '../../types/models'

interface MessageItemProps {
  message: Message
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function LockIcon(): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="inline h-3.5 w-3.5"
    >
      <path
        fillRule="evenodd"
        d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

export function MessageItem({ message }: MessageItemProps): React.ReactElement {
  // System messages render centered with muted styling
  if (message.message_type === 'system') {
    return (
      <div className="flex justify-center px-4 py-2">
        <span className="text-xs text-text-muted">{message.content}</span>
      </div>
    )
  }

  const initial = (message.sender_username || message.sender_id).charAt(0).toUpperCase()

  return (
    <div className="group flex gap-4 px-4 py-1 hover:bg-bg-hover/30">
      {/* Avatar */}
      <div className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-bg-accent text-sm font-semibold text-white">
        {initial}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-text-primary">
            {message.sender_username || message.sender_id.slice(0, 8)}
          </span>
          <span className="text-xs text-text-muted">{formatTime(message.created_at)}</span>
        </div>
        {message.decrypt_error ? (
          message.decrypt_error === 'MISSING_SENDER_KEY' ? (
            <div className="italic text-text-muted">
              Waiting for encryption key...
            </div>
          ) : (
            <div className="flex items-center gap-1 italic text-text-muted">
              <LockIcon />
              This message could not be decrypted.
            </div>
          )
        ) : (
          <div className="text-text-secondary">{message.content}</div>
        )}
      </div>
    </div>
  )
}
