import { describe, it, expect, vi, beforeEach } from 'vitest'

// Test the video grid layout logic (extracted from the component)

interface TileData {
  userId: string
  displayName: string
  isMuted: boolean
  isLocal: boolean
  hasVideo: boolean
}

type LayoutMode = 'single' | 'grid-2x2' | 'speaker-filmstrip' | 'speaker-paginated'

const GRID_PAGE_SIZE = 6

function determineLayoutMode(tileCount: number): LayoutMode {
  if (tileCount <= 1) return 'single'
  if (tileCount <= 4) return 'grid-2x2'
  if (tileCount <= 9) return 'speaker-filmstrip'
  return 'speaker-paginated'
}

function getPaginatedTiles(tiles: TileData[], activeSpeakerId: string | null, currentPage: number) {
  const speakerTile = tiles.find((t) => t.userId === activeSpeakerId) ?? tiles[0]
  const otherTiles = tiles.filter((t) => t.userId !== speakerTile.userId)
  const totalPages = Math.ceil(otherTiles.length / GRID_PAGE_SIZE)
  const safePage = Math.min(currentPage, totalPages - 1)
  const pagedTiles = otherTiles.slice(safePage * GRID_PAGE_SIZE, (safePage + 1) * GRID_PAGE_SIZE)
  return { speakerTile, pagedTiles, totalPages, safePage }
}

function makeTile(id: string): TileData {
  return {
    userId: id,
    displayName: `User ${id}`,
    isMuted: false,
    isLocal: id === 'local',
    hasVideo: true,
  }
}

describe('VideoGrid layout logic', () => {
  describe('determineLayoutMode', () => {
    it('should return single for 1 participant', () => {
      expect(determineLayoutMode(1)).toBe('single')
    })

    it('should return grid-2x2 for 2 participants', () => {
      expect(determineLayoutMode(2)).toBe('grid-2x2')
    })

    it('should return grid-2x2 for 3 participants', () => {
      expect(determineLayoutMode(3)).toBe('grid-2x2')
    })

    it('should return grid-2x2 for 4 participants', () => {
      expect(determineLayoutMode(4)).toBe('grid-2x2')
    })

    it('should return speaker-filmstrip for 5 participants', () => {
      expect(determineLayoutMode(5)).toBe('speaker-filmstrip')
    })

    it('should return speaker-filmstrip for 9 participants', () => {
      expect(determineLayoutMode(9)).toBe('speaker-filmstrip')
    })

    it('should return speaker-paginated for 10 participants', () => {
      expect(determineLayoutMode(10)).toBe('speaker-paginated')
    })

    it('should return speaker-paginated for 25 participants', () => {
      expect(determineLayoutMode(25)).toBe('speaker-paginated')
    })
  })

  describe('tiles based on video state', () => {
    it('should include only video-enabled participants', () => {
      const participants = [
        { userId: 'a', hasVideo: true },
        { userId: 'b', hasVideo: false },
        { userId: 'c', hasVideo: true },
      ]
      const videoTiles = participants.filter((p) => p.hasVideo)
      expect(videoTiles).toHaveLength(2)
      expect(videoTiles.map((t) => t.userId)).toEqual(['a', 'c'])
    })

    it('should include local user when camera is on', () => {
      const isCameraOn = true
      const participants = [
        { userId: 'remote-1', hasVideo: true },
      ]
      const tiles: string[] = []
      if (isCameraOn) tiles.push('local')
      for (const p of participants) {
        if (p.hasVideo) tiles.push(p.userId)
      }
      expect(tiles).toEqual(['local', 'remote-1'])
    })

    it('should not include local user when camera is off', () => {
      const isCameraOn = false
      const participants = [
        { userId: 'remote-1', hasVideo: true },
      ]
      const tiles: string[] = []
      if (isCameraOn) tiles.push('local')
      for (const p of participants) {
        if (p.hasVideo) tiles.push(p.userId)
      }
      expect(tiles).toEqual(['remote-1'])
    })

    it('should return empty when no video', () => {
      const isCameraOn = false
      const participants = [
        { userId: 'remote-1', hasVideo: false },
      ]
      const tiles: string[] = []
      if (isCameraOn) tiles.push('local')
      for (const p of participants) {
        if (p.hasVideo) tiles.push(p.userId)
      }
      expect(tiles).toHaveLength(0)
    })
  })

  describe('speaker + paginated grid (10+)', () => {
    it('should separate active speaker from grid', () => {
      const tiles = Array.from({ length: 12 }, (_, i) => makeTile(`user-${i}`))
      const { speakerTile, pagedTiles, totalPages } = getPaginatedTiles(tiles, 'user-3', 0)

      expect(speakerTile.userId).toBe('user-3')
      expect(pagedTiles).toHaveLength(6) // first page of 11 others
      expect(totalPages).toBe(2)
    })

    it('should default to first tile if active speaker not found', () => {
      const tiles = Array.from({ length: 10 }, (_, i) => makeTile(`user-${i}`))
      const { speakerTile } = getPaginatedTiles(tiles, 'nonexistent', 0)
      expect(speakerTile.userId).toBe('user-0')
    })

    it('should paginate correctly', () => {
      const tiles = Array.from({ length: 15 }, (_, i) => makeTile(`user-${i}`))
      const page0 = getPaginatedTiles(tiles, 'user-0', 0)
      const page1 = getPaginatedTiles(tiles, 'user-0', 1)
      const page2 = getPaginatedTiles(tiles, 'user-0', 2)

      expect(page0.pagedTiles).toHaveLength(6)
      expect(page1.pagedTiles).toHaveLength(6)
      expect(page2.pagedTiles).toHaveLength(2) // 14 others, 6+6+2
      expect(page0.totalPages).toBe(3)
    })

    it('should clamp page to max when participants leave', () => {
      // Simulate being on page 2 but enough participants leave
      const tiles = Array.from({ length: 8 }, (_, i) => makeTile(`user-${i}`))
      const { safePage, totalPages } = getPaginatedTiles(tiles, 'user-0', 5)
      // 7 others / 6 per page = 2 pages (0, 1)
      expect(totalPages).toBe(2)
      expect(safePage).toBe(1) // clamped from 5 to 1
    })
  })

  describe('speaker + filmstrip (5-9)', () => {
    it('should separate active speaker from filmstrip', () => {
      const tiles = Array.from({ length: 7 }, (_, i) => makeTile(`user-${i}`))
      const speakerTile = tiles.find((t) => t.userId === 'user-2') ?? tiles[0]
      const otherTiles = tiles.filter((t) => t.userId !== speakerTile.userId)

      expect(speakerTile.userId).toBe('user-2')
      expect(otherTiles).toHaveLength(6)
    })
  })
})
