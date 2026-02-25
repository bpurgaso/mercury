import React, { useRef, useEffect } from 'react'

interface VideoTileProps {
  userId: string
  displayName: string
  stream: MediaStream | null
  isSpeaking: boolean
  isMuted: boolean
  isLocal?: boolean
  size?: 'large' | 'normal'
}

export function VideoTile({
  displayName,
  stream,
  isSpeaking,
  isMuted,
  isLocal,
  size = 'normal',
}: VideoTileProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasVideo = stream ? stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live') : false

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [stream])

  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-bg-primary ${
        isSpeaking ? 'ring-2 ring-status-online' : 'ring-1 ring-border-subtle'
      } ${size === 'large' ? 'h-full' : ''}`}
      data-testid="video-tile"
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className={`h-full w-full object-cover ${isLocal ? 'scale-x-[-1]' : ''}`}
        />
      ) : (
        <div className="flex h-full min-h-[120px] w-full items-center justify-center bg-bg-secondary">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-bg-accent text-2xl font-semibold text-white">
            {displayName.charAt(0).toUpperCase()}
          </div>
        </div>
      )}

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
        <span className="truncate text-xs font-medium text-white">
          {displayName}{isLocal ? ' (You)' : ''}
        </span>
        {isMuted && (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="ml-auto h-3 w-3 shrink-0 text-status-dnd">
            <path d="M5.937 3.604a.75.75 0 0 1 .75.53l.001.003.003.01.008.032a3 3 0 0 0 .106.332c.08.21.2.47.376.72.347.494.873.882 1.793.882.92 0 1.446-.388 1.793-.882a3 3 0 0 0 .482-1.052l.003-.01.001-.003a.75.75 0 0 1 1.466.312l-.733-.156.733.156v.002l-.001.004-.003.012-.01.04a4 4 0 0 1-.609 1.383c-.553.787-1.487 1.495-3.129 1.495-1.642 0-2.576-.708-3.13-1.495a4 4 0 0 1-.607-1.383l-.011-.04-.003-.012v-.004l-.001-.002a.75.75 0 0 1 .72-.97Z" />
          </svg>
        )}
      </div>
    </div>
  )
}
