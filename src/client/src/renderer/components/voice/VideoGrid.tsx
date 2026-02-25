import React, { useMemo, useState } from 'react'
import { useCallStore } from '../../stores/callStore'
import { useAuthStore } from '../../stores/authStore'
import { VideoTile } from './VideoTile'

interface TileData {
  userId: string
  displayName: string
  stream: MediaStream | null
  isMuted: boolean
  isLocal: boolean
}

const GRID_PAGE_SIZE = 6 // 3x2

export function VideoGrid(): React.ReactElement | null {
  const activeCall = useCallStore((s) => s.activeCall)
  const localStream = useCallStore((s) => s.localStream)
  const remoteStreams = useCallStore((s) => s.remoteStreams)
  const participants = useCallStore((s) => s.participants)
  const isMuted = useCallStore((s) => s.isMuted)
  const isCameraOn = useCallStore((s) => s.isCameraOn)
  const speakingUsers = useCallStore((s) => s.speakingUsers)
  const activeSpeakerId = useCallStore((s) => s.activeSpeakerId)
  const user = useAuthStore((s) => s.user)

  const [currentPage, setCurrentPage] = useState(0)

  // Build tile data for all video-enabled participants
  const tiles = useMemo(() => {
    if (!activeCall || !user) return []

    const result: TileData[] = []

    // Local user tile (if camera is on)
    if (isCameraOn) {
      result.push({
        userId: user.id,
        displayName: user.display_name,
        stream: localStream,
        isMuted,
        isLocal: true,
      })
    }

    // Remote participants with video
    for (const [userId, p] of participants) {
      if (p.hasVideo) {
        result.push({
          userId,
          displayName: userId,
          stream: remoteStreams.get(userId) ?? null,
          isMuted: p.selfMute,
          isLocal: false,
        })
      }
    }

    return result
  }, [activeCall, user, isCameraOn, localStream, isMuted, participants, remoteStreams])

  if (tiles.length === 0) return null

  const count = tiles.length

  // Mode 1: 1-4 tiles → equal grid
  if (count <= 4) {
    return (
      <div className="flex-1 p-2" data-testid="video-grid">
        <div className={`grid h-full gap-2 ${count <= 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2'}`}>
          {tiles.map((tile) => (
            <VideoTile
              key={tile.userId}
              userId={tile.userId}
              displayName={tile.displayName}
              stream={tile.stream}
              isSpeaking={speakingUsers.get(tile.userId) ?? false}
              isMuted={tile.isMuted}
              isLocal={tile.isLocal}
            />
          ))}
        </div>
      </div>
    )
  }

  // Determine active speaker tile
  const speakerTile = tiles.find((t) => t.userId === activeSpeakerId) ?? tiles[0]
  const otherTiles = tiles.filter((t) => t.userId !== speakerTile.userId)

  // Mode 2: 5-9 tiles → active speaker + filmstrip
  if (count <= 9) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-2" data-testid="video-grid">
        {/* Active speaker (large) */}
        <div className="flex-[3]">
          <VideoTile
            userId={speakerTile.userId}
            displayName={speakerTile.displayName}
            stream={speakerTile.stream}
            isSpeaking={speakingUsers.get(speakerTile.userId) ?? false}
            isMuted={speakerTile.isMuted}
            isLocal={speakerTile.isLocal}
            size="large"
          />
        </div>

        {/* Filmstrip */}
        <div className="flex flex-1 gap-2 overflow-x-auto" data-testid="video-filmstrip">
          {otherTiles.map((tile) => (
            <div key={tile.userId} className="aspect-video h-full shrink-0">
              <VideoTile
                userId={tile.userId}
                displayName={tile.displayName}
                stream={tile.stream}
                isSpeaking={speakingUsers.get(tile.userId) ?? false}
                isMuted={tile.isMuted}
                isLocal={tile.isLocal}
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Mode 3: 10+ tiles → active speaker + paginated grid
  const totalPages = Math.ceil(otherTiles.length / GRID_PAGE_SIZE)
  const safePage = Math.min(currentPage, totalPages - 1)
  const pagedTiles = otherTiles.slice(safePage * GRID_PAGE_SIZE, (safePage + 1) * GRID_PAGE_SIZE)

  return (
    <div className="flex flex-1 flex-col gap-2 p-2" data-testid="video-grid">
      {/* Active speaker (large) */}
      <div className="flex-[3]">
        <VideoTile
          userId={speakerTile.userId}
          displayName={speakerTile.displayName}
          stream={speakerTile.stream}
          isSpeaking={speakingUsers.get(speakerTile.userId) ?? false}
          isMuted={speakerTile.isMuted}
          isLocal={speakerTile.isLocal}
          size="large"
        />
      </div>

      {/* Paginated grid (3x2) */}
      <div className="flex-1">
        <div className="grid h-full grid-cols-3 grid-rows-2 gap-2" data-testid="video-paginated-grid">
          {pagedTiles.map((tile) => (
            <VideoTile
              key={tile.userId}
              userId={tile.userId}
              displayName={tile.displayName}
              stream={tile.stream}
              isSpeaking={speakingUsers.get(tile.userId) ?? false}
              isMuted={tile.isMuted}
              isLocal={tile.isLocal}
            />
          ))}
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="mt-1 flex items-center justify-center gap-2">
            <button
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-30"
            >
              Prev
            </button>
            <span className="text-xs text-text-muted">
              {safePage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-30"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
