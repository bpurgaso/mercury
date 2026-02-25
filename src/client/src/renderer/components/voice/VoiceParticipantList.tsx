import React from 'react'
import type { ParticipantState } from '../../types/call'
import { VoiceParticipant } from './VoiceParticipant'

interface VoiceParticipantListProps {
  participants: Map<string, ParticipantState>
  speakingUsers: Map<string, boolean>
  localUserId: string
  localDisplayName: string
  localIsMuted: boolean
  localIsDeafened: boolean
}

export function VoiceParticipantList({
  participants,
  speakingUsers,
  localUserId,
  localDisplayName,
  localIsMuted,
  localIsDeafened,
}: VoiceParticipantListProps): React.ReactElement {
  return (
    <div className="max-h-32 overflow-y-auto">
      {/* Local user */}
      <VoiceParticipant
        userId={localUserId}
        displayName={localDisplayName}
        isSpeaking={speakingUsers.get(localUserId) ?? false}
        isMuted={localIsMuted}
        isDeafened={localIsDeafened}
        isLocal
      />

      {/* Remote participants */}
      {Array.from(participants.values()).map((p) => (
        <VoiceParticipant
          key={p.userId}
          userId={p.userId}
          displayName={p.userId}
          isSpeaking={speakingUsers.get(p.userId) ?? false}
          isMuted={p.selfMute}
          isDeafened={p.selfDeaf}
        />
      ))}
    </div>
  )
}
