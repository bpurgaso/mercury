import React from 'react'

interface VoiceControlsProps {
  isMuted: boolean
  isDeafened: boolean
  isCameraOn: boolean
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleCamera: () => void
  onDisconnect: () => void
}

export function VoiceControls({
  isMuted,
  isDeafened,
  isCameraOn,
  onToggleMute,
  onToggleDeafen,
  onToggleCamera,
  onDisconnect,
}: VoiceControlsProps): React.ReactElement {
  return (
    <div className="flex items-center justify-center gap-2 border-t border-border-subtle px-3 py-2">
      {/* Mute */}
      <button
        onClick={onToggleMute}
        title={isMuted ? 'Unmute' : 'Mute'}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          isMuted
            ? 'bg-status-dnd/20 text-status-dnd hover:bg-status-dnd/30'
            : 'bg-bg-hover text-text-secondary hover:bg-bg-active hover:text-text-primary'
        }`}
        data-testid="voice-mute-btn"
      >
        {isMuted ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M7.712 4.598a.75.75 0 0 1 .75.53l.001.002.001.003.003.01.008.032a3.712 3.712 0 0 0 .106.332c.08.21.2.47.376.72.347.494.873.882 1.793.882.92 0 1.446-.388 1.793-.882a3.453 3.453 0 0 0 .482-1.052l.008-.032.003-.01.001-.002v-.002a.75.75 0 0 1 1.466.312l-.734-.155.734.156-.001.002-.001.004-.003.012-.01.04a4.954 4.954 0 0 1-.609 1.383c-.553.787-1.487 1.495-3.129 1.495-1.642 0-2.576-.708-3.13-1.495a4.953 4.953 0 0 1-.608-1.384 3.06 3.06 0 0 1-.01-.039l-.003-.012-.001-.004v-.002h-.001a.75.75 0 0 1 .72-.969ZM2.78 2.22a.75.75 0 0 0-1.06 1.06l4.636 4.637a5.24 5.24 0 0 0-.106.283v.357c0 2.168 1.163 4.063 2.899 5.102v1.591h-1.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-1.5v-1.591A5.993 5.993 0 0 0 13.75 10v-.357a.75.75 0 0 0-1.5 0V10a4.5 4.5 0 0 1-7.62 3.22L2.78 2.22Z" />
            <path d="m7.26 7.322 5.958 5.958A4.48 4.48 0 0 0 14.75 10V4a4.75 4.75 0 0 0-7.49-3.878L7.26 7.322Z" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4Z" />
            <path d="M5.5 9.643a.75.75 0 0 0-1.5 0V10c0 3.06 2.29 5.585 5.25 5.954V17.5h-1.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-1.5v-1.546A6.001 6.001 0 0 0 16 10v-.357a.75.75 0 0 0-1.5 0V10a4.5 4.5 0 0 1-9 0v-.357Z" />
          </svg>
        )}
      </button>

      {/* Deafen */}
      <button
        onClick={onToggleDeafen}
        title={isDeafened ? 'Undeafen' : 'Deafen'}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          isDeafened
            ? 'bg-status-dnd/20 text-status-dnd hover:bg-status-dnd/30'
            : 'bg-bg-hover text-text-secondary hover:bg-bg-active hover:text-text-primary'
        }`}
        data-testid="voice-deafen-btn"
      >
        {isDeafened ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M10 3.75a2 2 0 0 0-2 2v.56l5.72 5.72c.18-.3.28-.65.28-1.03V7a4.25 4.25 0 0 0-4-4.25Zm5.28 10.34L4.22 3.03a.75.75 0 0 0-1.06 1.06l2.76 2.76A4.25 4.25 0 0 0 5.75 7v4a4.25 4.25 0 0 0 8.5 0v-.69l2.03 2.03a.75.75 0 0 0 1.06-1.06l-.06-.06v-.09Z" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M10 3.75a2 2 0 0 0-2 2v5.25a2 2 0 1 0 4 0V5.75a2 2 0 0 0-2-2Z" />
            <path d="M5.75 7a4.25 4.25 0 1 1 8.5 0v4a4.25 4.25 0 0 1-8.5 0V7Z" />
          </svg>
        )}
      </button>

      {/* Camera */}
      <button
        onClick={onToggleCamera}
        title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          isCameraOn
            ? 'bg-bg-accent/20 text-bg-accent hover:bg-bg-accent/30'
            : 'bg-bg-hover text-text-secondary hover:bg-bg-active hover:text-text-primary'
        }`}
        data-testid="voice-camera-btn"
      >
        {isCameraOn ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M3.25 4A2.25 2.25 0 0 0 1 6.25v7.5A2.25 2.25 0 0 0 3.25 16h7.5A2.25 2.25 0 0 0 13 13.75v-7.5A2.25 2.25 0 0 0 10.75 4h-7.5ZM19 4.75a.75.75 0 0 0-1.28-.53l-3 3a.75.75 0 0 0-.22.53v4.5c0 .199.079.39.22.53l3 3a.75.75 0 0 0 1.28-.53V4.75Z" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M1 13.75V6.25A2.25 2.25 0 0 1 3.25 4h7.5A2.25 2.25 0 0 1 13 6.25v.26l2.72-2.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53L13 13.49v.26A2.25 2.25 0 0 1 10.75 16h-7.5A2.25 2.25 0 0 1 1 13.75Zm12-1.56 3 3V4.81l-3 3v4.38ZM3.25 5.5a.75.75 0 0 0-.75.75v7.5c0 .414.336.75.75.75h7.5a.75.75 0 0 0 .75-.75v-7.5a.75.75 0 0 0-.75-.75h-7.5Z" />
          </svg>
        )}
      </button>

      {/* Disconnect */}
      <button
        onClick={onDisconnect}
        title="Disconnect"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-status-dnd/20 text-status-dnd transition-colors hover:bg-status-dnd/30"
        data-testid="voice-disconnect-btn"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path d="M3.26 2.224a.75.75 0 0 0-.04 1.06l2.03 2.148a9.734 9.734 0 0 0-2.859 3.86.75.75 0 0 0 .402.979c3.407 1.43 7.093 1.694 10.674.874l2.27 2.405a.75.75 0 1 0 1.09-1.03l-12.5-13.24a.75.75 0 0 0-1.06-.04L3.26 2.224Z" />
          <path d="M17.61 9.292a.75.75 0 0 0-.4-.978 16.036 16.036 0 0 0-4.09-1.136l5.04 5.34a.748.748 0 0 0 .062-.075l.009-.013a.75.75 0 0 0 .108-.353 9.693 9.693 0 0 0-.729-2.785Z" />
        </svg>
      </button>
    </div>
  )
}
