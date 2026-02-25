import React from 'react'
import type { Channel } from '../../types/models'
import { useCallStore } from '../../stores/callStore'

interface VoiceChannelEntryProps {
  channel: Channel
}

export function VoiceChannelEntry({ channel }: VoiceChannelEntryProps): React.ReactElement {
  const activeCall = useCallStore((s) => s.activeCall)
  const activeChannelCalls = useCallStore((s) => s.activeChannelCalls)
  const voiceChannelParticipants = useCallStore((s) => s.voiceChannelParticipants)
  const joinCall = useCallStore((s) => s.joinCall)

  const hasActiveCall = activeChannelCalls.has(channel.id)
  const participants = voiceChannelParticipants.get(channel.id)
  const participantCount = participants?.size ?? 0
  const isInThisChannel = activeCall?.channelId === channel.id

  const handleClick = () => {
    if (!isInThisChannel) {
      joinCall(channel.id)
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
          isInThisChannel
            ? 'bg-bg-active text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
        data-testid={`voice-channel-${channel.id}`}
      >
        {/* Speaker icon */}
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-text-muted">
          <path d="M10 3.75a.75.75 0 0 0-1.264-.546L4.703 7H3.167a.75.75 0 0 0-.7.48A6.985 6.985 0 0 0 2 10c0 .887.165 1.737.468 2.52.111.29.39.48.7.48h1.535l4.033 3.796A.75.75 0 0 0 10 16.25V3.75ZM15.95 5.05a.75.75 0 0 0-1.06 1.061 5.5 5.5 0 0 1 0 7.778.75.75 0 0 0 1.06 1.06 7 7 0 0 0 0-9.899Z" />
          <path d="M13.829 7.172a.75.75 0 0 0-1.061 1.06 2.5 2.5 0 0 1 0 3.536.75.75 0 0 0 1.06 1.06 4 4 0 0 0 0-5.656Z" />
        </svg>

        <span className="truncate">{channel.name}</span>

        {/* Participant count badge */}
        {hasActiveCall && participantCount > 0 && (
          <span className="ml-auto flex items-center gap-1 text-xs text-text-muted">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 text-status-online">
              <path d="M10 3.75a.75.75 0 0 0-1.264-.546L4.703 7H3.167a.75.75 0 0 0-.7.48A6.985 6.985 0 0 0 2 10c0 .887.165 1.737.468 2.52.111.29.39.48.7.48h1.535l4.033 3.796A.75.75 0 0 0 10 16.25V3.75Z" />
            </svg>
            {participantCount}
          </span>
        )}
      </button>

      {/* Show participant names under the voice channel */}
      {hasActiveCall && participants && participants.size > 0 && (
        <div className="mb-1 ml-6 space-y-0.5">
          {Array.from(participants).map((userId) => (
            <div key={userId} className="flex items-center gap-1.5 px-2 py-0.5">
              <div className="h-1.5 w-1.5 rounded-full bg-status-online" />
              <span className="truncate text-[11px] text-text-muted">{userId}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
