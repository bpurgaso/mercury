import React, { useState, useRef, useEffect } from 'react'

interface MessageInputProps {
  channelName: string
  onSend: (content: string) => void
}

export function MessageInput({ channelName, onSend }: MessageInputProps): React.ReactElement {
  const [content, setContent] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [channelName])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = () => {
    const trimmed = content.trim()
    if (!trimmed) return
    onSend(trimmed)
    setContent('')
  }

  return (
    <div className="px-4 pb-6 pt-2">
      <div className="flex items-end rounded-lg bg-bg-input">
        <textarea
          ref={inputRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message #${channelName}`}
          rows={1}
          className="max-h-48 flex-1 resize-none bg-transparent px-4 py-3 text-text-primary outline-none placeholder:text-text-muted"
        />
      </div>
    </div>
  )
}
