import React, { useEffect, useState } from 'react'

interface VoicePanelHeaderProps {
  channelName: string
  joinedAt: number
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  if (h > 0) {
    return `${h}:${mm}:${ss}`
  }
  return `${mm}:${ss}`
}

export function VoicePanelHeader({ channelName, joinedAt }: VoicePanelHeaderProps): React.ReactElement {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    setElapsed(Math.floor((Date.now() - joinedAt) / 1000))
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - joinedAt) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [joinedAt])

  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-status-online">
          <path d="M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4Z" />
          <path d="M5.5 9.643a.75.75 0 0 0-1.5 0V10c0 3.06 2.29 5.585 5.25 5.954V17.5h-1.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-1.5v-1.546A6.001 6.001 0 0 0 16 10v-.357a.75.75 0 0 0-1.5 0V10a4.5 4.5 0 0 1-9 0v-.357Z" />
        </svg>
        <span className="truncate text-xs font-semibold text-status-online">{channelName}</span>
      </div>
      <span className="text-xs text-text-muted tabular-nums">{formatDuration(elapsed)}</span>
    </div>
  )
}
