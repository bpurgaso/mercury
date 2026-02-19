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

export function MessageItem({ message }: MessageItemProps): React.ReactElement {
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
        <div className="text-text-secondary">{message.content}</div>
      </div>
    </div>
  )
}
