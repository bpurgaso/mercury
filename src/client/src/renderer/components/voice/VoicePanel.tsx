import React from 'react'
import { useCallStore } from '../../stores/callStore'
import { useServerStore } from '../../stores/serverStore'
import { useAuthStore } from '../../stores/authStore'
import { VoicePanelHeader } from './VoicePanelHeader'
import { VoiceParticipantList } from './VoiceParticipantList'
import { VoiceControls } from './VoiceControls'

export function VoicePanel(): React.ReactElement | null {
  const activeCall = useCallStore((s) => s.activeCall)
  const participants = useCallStore((s) => s.participants)
  const isMuted = useCallStore((s) => s.isMuted)
  const isDeafened = useCallStore((s) => s.isDeafened)
  const isCameraOn = useCallStore((s) => s.isCameraOn)
  const speakingUsers = useCallStore((s) => s.speakingUsers)
  const toggleMute = useCallStore((s) => s.toggleMute)
  const toggleDeafen = useCallStore((s) => s.toggleDeafen)
  const toggleCamera = useCallStore((s) => s.toggleCamera)
  const leaveCall = useCallStore((s) => s.leaveCall)

  const channels = useServerStore((s) => s.channels)
  const user = useAuthStore((s) => s.user)

  if (!activeCall || !user) return null

  const channel = channels.get(activeCall.channelId)
  const channelName = channel?.name ?? 'Voice Channel'

  return (
    <div className="border-t border-border-subtle bg-bg-primary/80" data-testid="voice-panel">
      <VoicePanelHeader channelName={channelName} joinedAt={activeCall.joinedAt} />

      <VoiceParticipantList
        participants={participants}
        speakingUsers={speakingUsers}
        localUserId={user.id}
        localDisplayName={user.display_name}
        localIsMuted={isMuted}
        localIsDeafened={isDeafened}
      />

      <VoiceControls
        isMuted={isMuted}
        isDeafened={isDeafened}
        isCameraOn={isCameraOn}
        onToggleMute={toggleMute}
        onToggleDeafen={toggleDeafen}
        onToggleCamera={toggleCamera}
        onDisconnect={leaveCall}
      />
    </div>
  )
}
