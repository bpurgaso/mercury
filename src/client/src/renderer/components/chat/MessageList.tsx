import React, { useRef, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Message } from '../../types/models'
import { MessageItem } from './MessageItem'

interface MessageListProps {
  messages: Message[]
  onLoadMore?: () => void
  onReport?: (message: Message) => void
  onBlock?: (userId: string, username: string) => void
}

export function MessageList({ messages, onLoadMore, onReport, onBlock }: MessageListProps): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  })

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      // Only auto-scroll if user was near the bottom
      const el = parentRef.current
      if (el) {
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
        if (isNearBottom || prevCountRef.current === 0) {
          virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
        }
      }
    }
    prevCountRef.current = messages.length
  }, [messages.length, virtualizer])

  // Load more when scrolled to top
  useEffect(() => {
    const el = parentRef.current
    if (!el || !onLoadMore) return

    const handleScroll = () => {
      if (el.scrollTop < 100) {
        onLoadMore()
      }
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [onLoadMore])

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-text-muted">
        No messages yet. Start the conversation!
      </div>
    )
  }

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            <MessageItem
              message={messages[virtualItem.index]}
              onReport={onReport}
              onBlock={onBlock}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
