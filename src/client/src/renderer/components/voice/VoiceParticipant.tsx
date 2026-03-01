import React from 'react'

interface VoiceParticipantProps {
  userId: string
  displayName: string
  isSpeaking: boolean
  isMuted: boolean
  isDeafened: boolean
  isLocal?: boolean
}

export function VoiceParticipant({
  displayName,
  isSpeaking,
  isMuted,
  isDeafened,
}: VoiceParticipantProps): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded px-3 py-1">
      {/* Avatar with speaking indicator */}
      <div
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${
          isSpeaking ? 'ring-2 ring-status-online bg-bg-accent' : 'bg-bg-accent'
        }`}
      >
        {displayName.charAt(0).toUpperCase()}
      </div>

      {/* Username */}
      <span className="min-w-0 truncate text-xs text-text-secondary">{displayName}</span>

      {/* Status icons */}
      <div className="ml-auto flex items-center gap-1">
        {isMuted && (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-status-dnd" aria-label="Muted">
            <path d="M7.712 4.598a.75.75 0 0 1 .75.53l.001.002.001.003.003.01.008.032a3.712 3.712 0 0 0 .106.332c.08.21.2.47.376.72.347.494.873.882 1.793.882.92 0 1.446-.388 1.793-.882a3.453 3.453 0 0 0 .482-1.052l.008-.032.003-.01.001-.002v-.002a.75.75 0 0 1 1.466.312l-.734-.155.734.156-.001.002-.001.004-.003.012-.01.04a4.954 4.954 0 0 1-.609 1.383c-.553.787-1.487 1.495-3.129 1.495-1.642 0-2.576-.708-3.13-1.495a4.953 4.953 0 0 1-.608-1.384 3.06 3.06 0 0 1-.01-.039l-.003-.012-.001-.004v-.002h-.001a.75.75 0 0 1 .72-.969ZM2.78 2.22a.75.75 0 0 0-1.06 1.06l4.636 4.637a5.24 5.24 0 0 0-.106.283v.357c0 2.168 1.163 4.063 2.899 5.102v1.591h-1.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-1.5v-1.591A5.993 5.993 0 0 0 13.75 10v-.357a.75.75 0 0 0-1.5 0V10a4.5 4.5 0 0 1-7.62 3.22L2.78 2.22Z" />
            <path d="m7.26 7.322 5.958 5.958A4.48 4.48 0 0 0 14.75 10V4a4.75 4.75 0 0 0-7.49-3.878L7.26 7.322Z" />
          </svg>
        )}
        {isDeafened && (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-status-dnd" aria-label="Deafened">
            <path d="M10 3.75a2 2 0 0 0-2 2v.56l5.72 5.72c.18-.3.28-.65.28-1.03V7a4.25 4.25 0 0 0-4-4.25Zm5.28 10.34L4.22 3.03a.75.75 0 0 0-1.06 1.06l2.76 2.76A4.25 4.25 0 0 0 5.75 7v4a4.25 4.25 0 0 0 8.5 0v-.69l2.03 2.03a.75.75 0 0 0 1.06-1.06l-.06-.06v-.09Z" />
          </svg>
        )}
      </div>
    </div>
  )
}
