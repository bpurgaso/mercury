import React from 'react'
import { useDmChannelStore } from '../../stores/dmChannelStore'

export function DmList(): React.ReactElement {
  const dmChannels = useDmChannelStore((s) => s.dmChannels)
  const activeDmChannelId = useDmChannelStore((s) => s.activeDmChannelId)
  const setActiveDmChannel = useDmChannelStore((s) => s.setActiveDmChannel)

  const channels = Array.from(dmChannels.values())

  return (
    <div className="flex h-full w-60 flex-col bg-bg-secondary">
      <div className="flex h-12 items-center border-b border-border-subtle px-4">
        <span className="font-semibold text-text-primary">Direct Messages</span>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {channels.length === 0 ? (
          <p className="px-4 text-sm text-text-muted">No conversations yet</p>
        ) : (
          channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => setActiveDmChannel(ch.id)}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                activeDmChannelId === ch.id
                  ? 'bg-bg-accent text-text-primary'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
              }`}
            >
              {/* Avatar */}
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-bg-accent text-sm font-medium text-text-primary">
                {ch.recipient.display_name?.[0]?.toUpperCase() || ch.recipient.username[0]?.toUpperCase()}
              </div>
              <span className="truncate text-sm">
                {ch.recipient.display_name || ch.recipient.username}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
