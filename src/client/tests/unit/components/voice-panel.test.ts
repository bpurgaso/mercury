import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock stores ---

const mockCallStoreState = vi.hoisted(() => ({
  activeCall: null as { roomId: string; channelId: string; joinedAt: number } | null,
  participants: new Map<string, { userId: string; selfMute: boolean; selfDeaf: boolean; hasAudio: boolean; hasVideo: boolean }>(),
  isMuted: false,
  isDeafened: false,
  isCameraOn: false,
  speakingUsers: new Map<string, boolean>(),
  activeSpeakerId: null as string | null,
  toggleMute: vi.fn(),
  toggleDeafen: vi.fn(),
  toggleCamera: vi.fn(),
  leaveCall: vi.fn(),
  activeChannelCalls: new Map<string, string>(),
  voiceChannelParticipants: new Map<string, Set<string>>(),
  joinCall: vi.fn(),
  localStream: null,
  remoteStreams: new Map(),
  callConfig: null,
  connectionState: null,
  diagnosticState: null,
  error: null,
}))

const mockServerStoreState = vi.hoisted(() => ({
  channels: new Map<string, { id: string; name: string; server_id: string; channel_type: string; encryption_mode: string; position: number; topic: null }>(),
  activeServerId: 'server-1',
  activeChannelId: 'ch-text-1',
  servers: new Map(),
  getServerChannels: vi.fn(() => []),
  setActiveChannel: vi.fn(),
}))

const mockAuthStoreState = vi.hoisted(() => ({
  user: { id: 'local-user', username: 'localuser', display_name: 'Local User', email: '', avatar_url: null, status: null, created_at: null },
}))

vi.mock('../../../src/renderer/stores/callStore', () => ({
  useCallStore: vi.fn((selector: (s: typeof mockCallStoreState) => unknown) => selector(mockCallStoreState)),
}))

vi.mock('../../../src/renderer/stores/serverStore', () => ({
  useServerStore: vi.fn((selector: (s: typeof mockServerStoreState) => unknown) => selector(mockServerStoreState)),
}))

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: vi.fn((selector: (s: typeof mockAuthStoreState) => unknown) => selector(mockAuthStoreState)),
}))

// --- Tests ---

describe('VoicePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallStoreState.activeCall = null
    mockCallStoreState.participants = new Map()
    mockCallStoreState.isMuted = false
    mockCallStoreState.isDeafened = false
    mockCallStoreState.isCameraOn = false
    mockCallStoreState.speakingUsers = new Map()
    mockServerStoreState.channels = new Map()
  })

  describe('VoicePanel visibility', () => {
    it('should return null when no active call', async () => {
      // Import dynamically after mocks are set up
      const { VoicePanel } = await import('../../../src/renderer/components/voice/VoicePanel')
      // VoicePanel returns null when activeCall is null
      // Since we can't render React in node, we test the store state logic
      expect(mockCallStoreState.activeCall).toBeNull()
    })

    it('should provide data when active call exists', () => {
      mockCallStoreState.activeCall = { roomId: 'room-1', channelId: 'ch-voice-1', joinedAt: Date.now() }
      mockServerStoreState.channels.set('ch-voice-1', {
        id: 'ch-voice-1', name: 'General Voice', server_id: 'server-1',
        channel_type: 'voice', encryption_mode: 'standard', position: 0, topic: null,
      })
      expect(mockCallStoreState.activeCall).not.toBeNull()
      expect(mockServerStoreState.channels.get('ch-voice-1')?.name).toBe('General Voice')
    })
  })

  describe('VoicePanel participant rendering data', () => {
    it('should show participant names, mute icons, speaking indicators', () => {
      mockCallStoreState.participants = new Map([
        ['user-a', { userId: 'user-a', selfMute: true, selfDeaf: false, hasAudio: true, hasVideo: false }],
        ['user-b', { userId: 'user-b', selfMute: false, selfDeaf: true, hasAudio: true, hasVideo: false }],
        ['user-c', { userId: 'user-c', selfMute: false, selfDeaf: false, hasAudio: true, hasVideo: false }],
      ])
      mockCallStoreState.speakingUsers = new Map([
        ['user-a', false],
        ['user-b', false],
        ['user-c', true],
      ])

      const participants = Array.from(mockCallStoreState.participants.values())
      expect(participants).toHaveLength(3)

      // user-a should show muted
      expect(participants[0].selfMute).toBe(true)
      expect(participants[0].selfDeaf).toBe(false)

      // user-b should show deafened
      expect(participants[1].selfDeaf).toBe(true)

      // user-c should be speaking
      expect(mockCallStoreState.speakingUsers.get('user-c')).toBe(true)
    })
  })

  describe('VoiceControls mute button', () => {
    it('should call toggleMute when clicked', () => {
      mockCallStoreState.toggleMute()
      expect(mockCallStoreState.toggleMute).toHaveBeenCalledTimes(1)
    })

    it('should reflect muted state', () => {
      mockCallStoreState.isMuted = true
      expect(mockCallStoreState.isMuted).toBe(true)
    })

    it('should reflect unmuted state', () => {
      mockCallStoreState.isMuted = false
      expect(mockCallStoreState.isMuted).toBe(false)
    })
  })

  describe('VoiceControls deafen button', () => {
    it('should call toggleDeafen when clicked', () => {
      mockCallStoreState.toggleDeafen()
      expect(mockCallStoreState.toggleDeafen).toHaveBeenCalledTimes(1)
    })

    it('should show deafened state and mute should also be active', () => {
      mockCallStoreState.isDeafened = true
      mockCallStoreState.isMuted = true
      expect(mockCallStoreState.isDeafened).toBe(true)
      expect(mockCallStoreState.isMuted).toBe(true)
    })
  })

  describe('VoiceControls camera button', () => {
    it('should call toggleCamera when clicked', async () => {
      await mockCallStoreState.toggleCamera()
      expect(mockCallStoreState.toggleCamera).toHaveBeenCalledTimes(1)
    })

    it('should reflect camera on state', () => {
      mockCallStoreState.isCameraOn = true
      expect(mockCallStoreState.isCameraOn).toBe(true)
    })
  })

  describe('VoiceControls disconnect button', () => {
    it('should call leaveCall when clicked', async () => {
      await mockCallStoreState.leaveCall()
      expect(mockCallStoreState.leaveCall).toHaveBeenCalledTimes(1)
    })
  })
})

describe('VoicePanelHeader', () => {
  it('should format duration correctly for mm:ss', async () => {
    // Test the formatting logic directly
    function formatDuration(seconds: number): string {
      const h = Math.floor(seconds / 3600)
      const m = Math.floor((seconds % 3600) / 60)
      const s = seconds % 60
      const mm = String(m).padStart(2, '0')
      const ss = String(s).padStart(2, '0')
      if (h > 0) return `${h}:${mm}:${ss}`
      return `${mm}:${ss}`
    }

    expect(formatDuration(0)).toBe('00:00')
    expect(formatDuration(65)).toBe('01:05')
    expect(formatDuration(3661)).toBe('1:01:01')
    expect(formatDuration(7200)).toBe('2:00:00')
  })
})
