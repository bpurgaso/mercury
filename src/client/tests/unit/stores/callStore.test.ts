import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'

// --- Hoisted shared state (available to vi.mock factories) ---

const { wsListeners, wsSendMock, wsOnMock, wsStateChangeCallbacks, wsOnStateChangeMock } = vi.hoisted(() => {
  type WsCallback = (data: unknown) => void
  const wsListeners = new Map<string, Set<WsCallback>>()
  const wsStateChangeCallbacks = new Set<WsCallback>()
  const wsSendMock = vi.fn()
  const wsOnMock = vi.fn((event: string, cb: WsCallback) => {
    if (!wsListeners.has(event)) {
      wsListeners.set(event, new Set())
    }
    wsListeners.get(event)!.add(cb)
    return () => { wsListeners.get(event)?.delete(cb) }
  })
  const wsOnStateChangeMock = vi.fn((cb: WsCallback) => {
    wsStateChangeCallbacks.add(cb)
    return () => { wsStateChangeCallbacks.delete(cb) }
  })
  return { wsListeners, wsSendMock, wsOnMock, wsStateChangeCallbacks, wsOnStateChangeMock }
})

// --- Mock WebSocket manager (uses hoisted state) ---

vi.mock('../../../src/renderer/services/websocket', () => ({
  wsManager: {
    send: wsSendMock,
    on: wsOnMock,
    getState: vi.fn(() => 'CONNECTED'),
    onStateChange: wsOnStateChangeMock,
  },
}))

// --- Mock frame-crypto module (to avoid real Web Crypto in callStore tests) ---

vi.mock('../../../src/renderer/services/frame-crypto', () => ({
  createSenderTransform: vi.fn(() => new TransformStream()),
  createReceiverTransform: vi.fn(() => new TransformStream()),
  generateMediaKey: vi.fn(async () => ({
    algorithm: { name: 'AES-GCM', length: 256 },
    extractable: true,
    usages: ['encrypt', 'decrypt'],
    type: 'secret',
  })),
  exportMediaKey: vi.fn(async () => new Uint8Array(32)),
  importMediaKey: vi.fn(async (raw: Uint8Array) => ({
    algorithm: { name: 'AES-GCM', length: 256 },
    extractable: false,
    usages: ['encrypt', 'decrypt'],
    type: 'secret',
  })),
}))

// --- Mock crypto service (to avoid real IPC in callStore tests) ---

vi.mock('../../../src/renderer/services/crypto', () => ({
  cryptoService: {
    distributeMediaKey: vi.fn(async () => ({ distributed: true, recipients: [] })),
    decryptMediaKey: vi.fn(async () => ({ key: Array.from(new Uint8Array(32)), epoch: 0, roomId: 'room-123' })),
  },
}))

// --- Mock auth store (provides local userId for key rotation coordination) ---

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({ user: { id: 'local-user' } })),
  },
}))

// --- Mock active speaker detector (to avoid real AudioContext in tests) ---

vi.mock('../../../src/renderer/services/active-speaker', () => ({
  activeSpeakerDetector: {
    start: vi.fn(),
    stop: vi.fn(),
    onSpeakingChange: vi.fn(() => () => {}),
  },
}))

// --- Mock audio cue player (to avoid real AudioContext in tests) ---

vi.mock('../../../src/renderer/services/audio-cues', () => ({
  audioCuePlayer: {
    playJoin: vi.fn(),
    playLeave: vi.fn(),
    dispose: vi.fn(),
  },
}))

// --- Stub global `window` for Node test environment ---

if (typeof window === 'undefined') {
  (globalThis as Record<string, unknown>).window = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

// --- Mock RTCPeerConnection and related WebRTC APIs ---

class MockRTCSessionDescription {
  type: string
  sdp: string
  constructor(init: { type: string; sdp: string }) {
    this.type = init.type
    this.sdp = init.sdp
  }
}

class MockRTCIceCandidate {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
  constructor(init: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null }) {
    this.candidate = init.candidate || ''
    this.sdpMid = init.sdpMid ?? null
    this.sdpMLineIndex = init.sdpMLineIndex ?? null
  }
}

let pcInstances: MockRTCPeerConnection[] = []
let pcOnIceCandidate: ((event: { candidate: { toJSON: () => object } | null }) => void) | null = null
let pcOnTrack: ((event: {
  track: { id: string; kind: string; enabled: boolean; onended: (() => void) | null }
  streams: MediaStream[]
  transceiver: { mid: string | null }
  receiver: { createEncodedStreams: () => { readable: ReadableStream; writable: WritableStream } }
}) => void) | null = null
let pcOnConnectionStateChange: (() => void) | null = null

class MockRTCPeerConnection {
  iceServers: RTCIceServer[] = []
  connectionState: RTCPeerConnectionState = 'new'
  _senders: { track: MediaStreamTrack | null; getParameters: Mock; setParameters: Mock }[] = []
  _receivers: { track: { kind: string; enabled: boolean } }[] = []
  closed = false

  constructor(config?: RTCConfiguration) {
    if (config?.iceServers) {
      this.iceServers = config.iceServers as RTCIceServer[]
    }
    pcInstances.push(this)
  }

  set onicecandidate(fn: ((event: { candidate: object | null }) => void) | null) {
    pcOnIceCandidate = fn as typeof pcOnIceCandidate
  }
  get onicecandidate() { return pcOnIceCandidate as unknown as ((event: RTCPeerConnectionIceEvent) => void) | null }

  set ontrack(fn: ((event: RTCTrackEvent) => void) | null) {
    pcOnTrack = fn as typeof pcOnTrack
  }
  get ontrack() { return pcOnTrack as unknown as ((event: RTCTrackEvent) => void) | null }

  set onconnectionstatechange(fn: (() => void) | null) {
    pcOnConnectionStateChange = fn
  }
  get onconnectionstatechange() { return pcOnConnectionStateChange }

  addTrack(track: MediaStreamTrack, _stream?: MediaStream) {
    const sender = {
      track,
      getParameters: vi.fn().mockReturnValue({ encodings: [{}] }),
      setParameters: vi.fn().mockResolvedValue(undefined),
      createEncodedStreams: vi.fn().mockReturnValue({
        readable: new ReadableStream(),
        writable: new WritableStream(),
      }),
    }
    this._senders.push(sender)
    return sender
  }

  removeTrack(sender: { track: MediaStreamTrack | null }) {
    const idx = this._senders.indexOf(sender as typeof this._senders[0])
    if (idx >= 0) this._senders.splice(idx, 1)
  }

  getSenders() { return this._senders }
  getReceivers() { return this._receivers }

  async createOffer(_options?: RTCOfferOptions) {
    return { type: 'offer' as const, sdp: 'mock-offer-sdp' }
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: 'mock-answer-sdp' }
  }

  async setLocalDescription(_desc: RTCSessionDescriptionInit) {
    // no-op
  }

  async setRemoteDescription(_desc: RTCSessionDescription) {
    // no-op
  }

  async addIceCandidate(_candidate: RTCIceCandidate) {
    // no-op
  }

  async getStats() {
    return new Map()
  }

  restartIce() {
    // no-op
  }

  close() {
    this.closed = true
    this.connectionState = 'closed'
  }
}

// Install global WebRTC mocks
Object.defineProperty(globalThis, 'RTCPeerConnection', { value: MockRTCPeerConnection, writable: true })
Object.defineProperty(globalThis, 'RTCSessionDescription', { value: MockRTCSessionDescription, writable: true })
Object.defineProperty(globalThis, 'RTCIceCandidate', { value: MockRTCIceCandidate, writable: true })

// --- Mock MediaStream and getUserMedia ---

class MockMediaStreamTrack {
  id: string
  kind: string
  enabled = true
  onended: (() => void) | null = null

  constructor(kind: string, id?: string) {
    this.kind = kind
    this.id = id || `track-${kind}-${Math.random().toString(36).slice(2)}`
  }

  stop() {
    this.enabled = false
    if (this.onended) this.onended()
  }
}

class MockMediaStream {
  private tracks: MockMediaStreamTrack[] = []

  constructor(tracks?: MockMediaStreamTrack[]) {
    if (tracks) this.tracks = [...tracks]
  }

  addTrack(track: MockMediaStreamTrack) { this.tracks.push(track) }
  removeTrack(track: MockMediaStreamTrack) {
    const idx = this.tracks.indexOf(track)
    if (idx >= 0) this.tracks.splice(idx, 1)
  }
  getTracks() { return [...this.tracks] }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio') }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video') }
}

Object.defineProperty(globalThis, 'MediaStream', { value: MockMediaStream, writable: true })

const mockGetUserMedia = vi.fn()
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: mockGetUserMedia,
    },
  },
  writable: true,
})

// Helper: create a mock receiver with createEncodedStreams for Insertable Streams
function mockReceiver() {
  return {
    createEncodedStreams: vi.fn().mockReturnValue({
      readable: new ReadableStream(),
      writable: new WritableStream(),
    }),
  }
}

// Helper to emit mock WS events
function emitWsEvent(event: string, data: unknown): void {
  const listeners = wsListeners.get(event)
  if (listeners) {
    for (const cb of listeners) {
      cb(data)
    }
  }
}

// Helper to emit WS state change
function emitWsStateChange(state: string): void {
  for (const cb of wsStateChangeCallbacks) {
    cb(state)
  }
}

// Now import the modules under test (after mocks are set up)
import { useCallStore } from '../../../src/renderer/stores/callStore'
import { wsManager } from '../../../src/renderer/services/websocket'
import { webRTCManager } from '../../../src/renderer/services/webrtc'
import { cryptoService } from '../../../src/renderer/services/crypto'
import { useAuthStore } from '../../../src/renderer/stores/authStore'
import { generateMediaKey, exportMediaKey, importMediaKey } from '../../../src/renderer/services/frame-crypto'

// --- Mock CALL_CONFIG data ---

const mockCallConfigEvent = {
  room_id: 'room-123',
  turn_urls: ['turn:turn.example.com:3478'],
  stun_urls: ['stun:stun.l.google.com:19302'],
  username: '1700000000:user-1',
  credential: 'hmac-credential-base64',
  ttl: 86400,
  audio: {
    max_bitrate_kbps: 128,
    preferred_bitrate_kbps: 64,
  },
  video: {
    max_bitrate_kbps: 2500,
    max_resolution: '1280x720',
    max_framerate: 30,
    simulcast_enabled: false,
  },
}

describe('callStore', () => {
  beforeEach(() => {
    // Reset store state
    useCallStore.setState({
      activeCall: null,
      localStream: null,
      remoteStreams: new Map(),
      isMuted: false,
      isDeafened: false,
      isCameraOn: false,
      participants: new Map(),
      callConfig: null,
      connectionState: null,
      diagnosticState: null,
      error: null,
      activeChannelCalls: new Map(),
    })
    // Only clear call history — do NOT use vi.clearAllMocks() as it strips
    // mock implementations from hoisted vi.fn() instances.
    wsSendMock.mockClear()
    wsOnMock.mockClear()
    wsOnStateChangeMock.mockClear()
    pcInstances = []
    pcOnIceCandidate = null
    pcOnTrack = null
    pcOnConnectionStateChange = null

    // Reset auth store mock to default
    vi.mocked(useAuthStore.getState).mockReturnValue({ user: { id: 'local-user' } } as ReturnType<typeof useAuthStore.getState>)

    // Default getUserMedia mock: returns audio track
    mockGetUserMedia.mockReset()
    mockGetUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
      const tracks: MockMediaStreamTrack[] = []
      if (constraints.audio) tracks.push(new MockMediaStreamTrack('audio'))
      if (constraints.video) tracks.push(new MockMediaStreamTrack('video'))
      return new MockMediaStream(tracks)
    })

    // Clean up webRTCManager state
    webRTCManager.leaveCall()
  })

  describe('joinCall', () => {
    it('sends voice_state_update and creates PeerConnection with correct ICE servers', async () => {
      // Start joinCall — it will wait for CALL_CONFIG
      const joinPromise = useCallStore.getState().joinCall('channel-1')

      // Verify voice_state_update was sent
      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', {
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })

      // Emit CALL_CONFIG
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)

      await joinPromise

      // Verify PeerConnection was created with correct ICE servers
      expect(pcInstances.length).toBe(1)
      const pc = pcInstances[0]
      expect(pc.iceServers).toEqual([
        { urls: ['stun:stun.l.google.com:19302'] },
        {
          urls: ['turn:turn.example.com:3478'],
          username: '1700000000:user-1',
          credential: 'hmac-credential-base64',
        },
      ])

      // Verify store state
      const state = useCallStore.getState()
      expect(state.activeCall).toMatchObject({ roomId: 'room-123', channelId: 'channel-1' })
      expect(state.activeCall?.joinedAt).toBeGreaterThan(0)
      expect(state.localStream).not.toBeNull()
      expect(state.error).toBeNull()
    })

    it('sends SDP offer via webrtc_signal after PC creation', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      // Verify webrtc_signal with offer was sent
      expect(wsManager.send).toHaveBeenCalledWith('webrtc_signal', {
        room_id: 'room-123',
        signal: { type: 'offer', sdp: 'mock-offer-sdp' },
      })
    })

    it('does NOT distribute initial media key to existing participants (coordinator handles it)', async () => {
      // Pre-populate participants so the guard would pass if distribution still happened
      useCallStore.setState({
        participants: new Map([
          ['user-2', { userId: 'user-2', selfMute: false, selfDeaf: false, hasAudio: false, hasVideo: false }],
        ]),
      })

      vi.mocked(cryptoService.distributeMediaKey).mockClear()

      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      // distributeMediaKey should NOT have been called during joinCall
      // The coordinator handles key distribution via VOICE_STATE_UPDATE
      expect(cryptoService.distributeMediaKey).not.toHaveBeenCalled()
    })

    it('stores callConfig in store state', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      const state = useCallStore.getState()
      expect(state.callConfig).not.toBeNull()
      expect(state.callConfig!.roomId).toBe('room-123')
      expect(state.callConfig!.audio.maxBitrateKbps).toBe(128)
      expect(state.callConfig!.video.maxBitrateKbps).toBe(2500)
    })

    it('rejects with error if CALL_CONFIG times out', async () => {
      vi.useFakeTimers()

      const joinPromise = useCallStore.getState().joinCall('channel-1')
      // Attach catch handler immediately to prevent unhandled rejection
      // during fake timer advancement
      let caughtError: Error | null = null
      const handled = joinPromise.catch((err) => { caughtError = err })

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(11_000)
      await handled

      expect(caughtError).toBeInstanceOf(Error)
      expect(caughtError!.message).toBe('CALL_CONFIG timeout')

      // Should have sent leave
      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', { channel_id: null })

      const state = useCallStore.getState()
      expect(state.error).toBe('CALL_CONFIG timeout')

      vi.useRealTimers()
    })

    it('rejects with error if getUserMedia fails', async () => {
      mockGetUserMedia.mockRejectedValueOnce(new Error('Permission denied'))

      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)

      await expect(joinPromise).rejects.toThrow('Permission denied')

      // Should have cleaned up: sent leave, error set
      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', { channel_id: null })
      const state = useCallStore.getState()
      expect(state.error).toBe('Permission denied')
      expect(state.activeCall).toBeNull()
    })

    it('cleans up on createOffer failure', async () => {
      // Override createOffer to throw before starting joinCall
      const origCreateOffer = MockRTCPeerConnection.prototype.createOffer
      MockRTCPeerConnection.prototype.createOffer = async () => {
        throw new Error('SDP offer creation failed')
      }

      try {
        const joinPromise = useCallStore.getState().joinCall('channel-1')
        emitWsEvent('CALL_CONFIG', mockCallConfigEvent)

        await expect(joinPromise).rejects.toThrow('SDP offer creation failed')

        const state = useCallStore.getState()
        expect(state.error).toBe('SDP offer creation failed')
        expect(state.activeCall).toBeNull()
        expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', { channel_id: null })
      } finally {
        // Always restore, even if assertions fail
        MockRTCPeerConnection.prototype.createOffer = origCreateOffer
      }
    })

    it('leaves current call before joining a new one', async () => {
      // Join first call
      const join1 = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await join1

      expect(useCallStore.getState().activeCall?.channelId).toBe('channel-1')

      // Join second call — should leave first.
      // The await leaveCall() inside joinCall creates a microtask boundary,
      // so we must emit CALL_CONFIG after the listener is registered.
      const join2 = useCallStore.getState().joinCall('channel-2')
      // Wait a tick for the async leaveCall() to complete and the new
      // CALL_CONFIG listener to be registered
      await new Promise((r) => setTimeout(r, 0))
      emitWsEvent('CALL_CONFIG', {
        ...mockCallConfigEvent,
        room_id: 'room-456',
      })
      await join2

      expect(useCallStore.getState().activeCall?.channelId).toBe('channel-2')
      expect(useCallStore.getState().activeCall?.roomId).toBe('room-456')
    })
  })

  describe('leaveCall', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('stops tracks, closes PC, and sends voice_state_update with null channel', async () => {
      await setupActiveCall()

      const pc = pcInstances[0]
      expect(pc.closed).toBe(false)

      await useCallStore.getState().leaveCall()

      // PC should be closed
      expect(pc.closed).toBe(true)

      // voice_state_update with null channel should have been sent
      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', { channel_id: null })

      // Store should be cleared
      const state = useCallStore.getState()
      expect(state.activeCall).toBeNull()
      expect(state.localStream).toBeNull()
      expect(state.remoteStreams.size).toBe(0)
      expect(state.isMuted).toBe(false)
      expect(state.isDeafened).toBe(false)
      expect(state.isCameraOn).toBe(false)
      expect(state.participants.size).toBe(0)
      expect(state.callConfig).toBeNull()
      expect(state.connectionState).toBeNull()
    })
  })

  describe('toggleMute', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('toggles track.enabled and sends voice_state_update', async () => {
      await setupActiveCall()

      const audioTrack = webRTCManager.getLocalAudioTrack()
      expect(audioTrack).not.toBeNull()
      expect(audioTrack!.enabled).toBe(true)

      // Mute
      useCallStore.getState().toggleMute()
      expect(useCallStore.getState().isMuted).toBe(true)
      expect(audioTrack!.enabled).toBe(false)
      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', {
        channel_id: 'channel-1',
        self_mute: true,
        self_deaf: false,
      })

      // Unmute
      useCallStore.getState().toggleMute()
      expect(useCallStore.getState().isMuted).toBe(false)
      expect(audioTrack!.enabled).toBe(true)
      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', {
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })
    })

    it('does nothing when not in a call', () => {
      useCallStore.getState().toggleMute()
      expect(useCallStore.getState().isMuted).toBe(false)
      // voice_state_update should not have been sent for mute toggle
      expect(wsManager.send).not.toHaveBeenCalled()
    })
  })

  describe('toggleDeafen', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('mutes remote tracks and self when deafening', async () => {
      await setupActiveCall()

      // Add mock remote audio receiver
      const pc = pcInstances[0]
      const remoteAudioTrack = { kind: 'audio', enabled: true }
      pc._receivers.push({ track: remoteAudioTrack })

      useCallStore.getState().toggleDeafen()

      expect(useCallStore.getState().isDeafened).toBe(true)
      expect(useCallStore.getState().isMuted).toBe(true)
      expect(remoteAudioTrack.enabled).toBe(false)

      // Self audio track should be muted too
      const audioTrack = webRTCManager.getLocalAudioTrack()
      expect(audioTrack!.enabled).toBe(false)

      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', {
        channel_id: 'channel-1',
        self_mute: true,
        self_deaf: true,
      })
    })

    it('restores audio when undeafening', async () => {
      await setupActiveCall()

      const pc = pcInstances[0]
      const remoteAudioTrack = { kind: 'audio', enabled: true }
      pc._receivers.push({ track: remoteAudioTrack })

      // Deafen
      useCallStore.getState().toggleDeafen()
      expect(remoteAudioTrack.enabled).toBe(false)

      // Undeafen
      useCallStore.getState().toggleDeafen()
      expect(useCallStore.getState().isDeafened).toBe(false)
      expect(useCallStore.getState().isMuted).toBe(false)
      expect(remoteAudioTrack.enabled).toBe(true)

      const audioTrack = webRTCManager.getLocalAudioTrack()
      expect(audioTrack!.enabled).toBe(true)

      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', {
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })
    })

    it('preserves manual mute state when undeafening', async () => {
      await setupActiveCall()

      const pc = pcInstances[0]
      pc._receivers.push({ track: { kind: 'audio', enabled: true } })

      // Manually mute first
      useCallStore.getState().toggleMute()
      expect(useCallStore.getState().isMuted).toBe(true)

      const audioTrack = webRTCManager.getLocalAudioTrack()
      expect(audioTrack!.enabled).toBe(false)

      // Deafen (was already muted)
      useCallStore.getState().toggleDeafen()
      expect(useCallStore.getState().isDeafened).toBe(true)
      expect(useCallStore.getState().isMuted).toBe(true)

      vi.mocked(wsManager.send).mockClear()

      // Undeafen — should remain muted since user was muted before deafening
      useCallStore.getState().toggleDeafen()
      expect(useCallStore.getState().isDeafened).toBe(false)
      expect(useCallStore.getState().isMuted).toBe(true)
      expect(audioTrack!.enabled).toBe(false)

      // voice_state_update should reflect the restored mute state
      expect(wsManager.send).toHaveBeenCalledWith('voice_state_update', {
        channel_id: 'channel-1',
        self_mute: true,
        self_deaf: false,
      })
    })
  })

  describe('toggleCamera', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('adds video track and triggers renegotiation when enabling', async () => {
      await setupActiveCall()
      vi.mocked(wsManager.send).mockClear()

      await useCallStore.getState().toggleCamera()

      expect(useCallStore.getState().isCameraOn).toBe(true)

      // Should have sent a renegotiation offer
      expect(wsManager.send).toHaveBeenCalledWith('webrtc_signal', expect.objectContaining({
        room_id: 'room-123',
        signal: expect.objectContaining({ type: 'offer' }),
      }))
    })

    it('removes video track and triggers renegotiation when disabling', async () => {
      await setupActiveCall()

      // Enable camera
      await useCallStore.getState().toggleCamera()
      expect(useCallStore.getState().isCameraOn).toBe(true)

      vi.mocked(wsManager.send).mockClear()

      // Disable camera
      await useCallStore.getState().toggleCamera()
      expect(useCallStore.getState().isCameraOn).toBe(false)

      // Should have sent a renegotiation offer
      expect(wsManager.send).toHaveBeenCalledWith('webrtc_signal', expect.objectContaining({
        room_id: 'room-123',
        signal: expect.objectContaining({ type: 'offer' }),
      }))
    })
  })

  describe('remote track association', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('updates remoteStreams using signaling-based mid mapping', async () => {
      await setupActiveCall()

      // Simulate receiving a WEBRTC_SIGNAL answer with SDP containing mid values
      // This populates the pendingTrackUserMap via updateTrackMappingFromSignal
      emitWsEvent('WEBRTC_SIGNAL', {
        from_user: 'user-2',
        signal: {
          type: 'answer',
          sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n',
        },
      })

      await new Promise((r) => setTimeout(r, 10))

      // Simulate remote track arriving with mid '0'
      const remoteTrack = new MockMediaStreamTrack('audio', 'remote-audio-1')
      const remoteStream = new MockMediaStream([remoteTrack])

      pcOnTrack!({
        track: remoteTrack as unknown as MediaStreamTrack & { onended: (() => void) | null },
        streams: [remoteStream as unknown as MediaStream],
        transceiver: { mid: '0' },
        receiver: mockReceiver(),
      })

      const state = useCallStore.getState()
      expect(state.remoteStreams.size).toBe(1)
      expect(state.remoteStreams.has('user-2')).toBe(true)
    })

    it('falls back to "unknown" when no signaling mapping exists', async () => {
      await setupActiveCall()

      const remoteTrack = new MockMediaStreamTrack('audio', 'remote-audio-1')
      const remoteStream = new MockMediaStream([remoteTrack])

      pcOnTrack!({
        track: remoteTrack as unknown as MediaStreamTrack & { onended: (() => void) | null },
        streams: [remoteStream as unknown as MediaStream],
        transceiver: { mid: '99' },
        receiver: mockReceiver(),
      })

      const state = useCallStore.getState()
      expect(state.remoteStreams.size).toBe(1)
      expect(state.remoteStreams.has('unknown')).toBe(true)
    })
  })

  describe('ICE candidate relay', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('sends webrtc_signal when local ICE candidate is generated', async () => {
      await setupActiveCall()
      vi.mocked(wsManager.send).mockClear()

      const mockCandidate = {
        candidate: 'candidate:123 1 udp 456 1.2.3.4 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      }

      // Fire onicecandidate
      pcOnIceCandidate!({
        candidate: {
          toJSON: () => mockCandidate,
        },
      })

      expect(wsManager.send).toHaveBeenCalledWith('webrtc_signal', {
        room_id: 'room-123',
        signal: {
          type: 'ice_candidate',
          candidate: JSON.stringify(mockCandidate),
        },
      })
    })

    it('adds ICE candidate to PC when WEBRTC_SIGNAL with candidate received', async () => {
      await setupActiveCall()

      const pc = pcInstances[0]
      const addIceSpy = vi.spyOn(pc, 'addIceCandidate')

      const candidateData = {
        candidate: 'candidate:789 1 udp 123 5.6.7.8 9000 typ srflx',
        sdpMid: '0',
        sdpMLineIndex: 0,
      }

      emitWsEvent('WEBRTC_SIGNAL', {
        from_user: 'user-2',
        signal: {
          type: 'ice_candidate',
          candidate: JSON.stringify(candidateData),
        },
      })

      // Give the async handleSignal a tick to resolve
      await new Promise((r) => setTimeout(r, 10))

      expect(addIceSpy).toHaveBeenCalled()
    })
  })

  describe('CALL_CONFIG parsing', () => {
    it('correctly parses CALL_CONFIG into CallConfig', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')

      const configWithSimulcast = {
        ...mockCallConfigEvent,
        video: {
          ...mockCallConfigEvent.video,
          simulcast_enabled: true,
          simulcast_layers: [
            { rid: 'high', max_bitrate_kbps: 2500, scale_down: 1.0 },
            { rid: 'medium', max_bitrate_kbps: 500, scale_down: 2.0 },
            { rid: 'low', max_bitrate_kbps: 150, scale_down: 4.0 },
          ],
        },
      }

      emitWsEvent('CALL_CONFIG', configWithSimulcast)
      await joinPromise

      const config = useCallStore.getState().callConfig!
      expect(config.turnUrls).toEqual(['turn:turn.example.com:3478'])
      expect(config.stunUrls).toEqual(['stun:stun.l.google.com:19302'])
      expect(config.username).toBe('1700000000:user-1')
      expect(config.credential).toBe('hmac-credential-base64')
      expect(config.ttl).toBe(86400)
      expect(config.audio.maxBitrateKbps).toBe(128)
      expect(config.audio.preferredBitrateKbps).toBe(64)
      expect(config.video.maxBitrateKbps).toBe(2500)
      expect(config.video.maxResolution).toBe('1280x720')
      expect(config.video.maxFramerate).toBe(30)
      expect(config.video.simulcastEnabled).toBe(true)
      expect(config.video.simulcastLayers).toEqual([
        { rid: 'high', maxBitrateKbps: 2500, scaleDown: 1.0 },
        { rid: 'medium', maxBitrateKbps: 500, scaleDown: 2.0 },
        { rid: 'low', maxBitrateKbps: 150, scaleDown: 4.0 },
      ])
    })

    it('configures PeerConnection ICE servers from CALL_CONFIG', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      const pc = pcInstances[0]
      expect(pc.iceServers).toEqual([
        { urls: ['stun:stun.l.google.com:19302'] },
        {
          urls: ['turn:turn.example.com:3478'],
          username: '1700000000:user-1',
          credential: 'hmac-credential-base64',
        },
      ])
    })
  })

  describe('connection failure diagnostics', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('sets connectionState immediately on "failed" but delays diagnosticState by 10s', async () => {
      vi.useFakeTimers()
      await setupActiveCall()

      const pc = pcInstances[0]
      pc.connectionState = 'failed'
      pcOnConnectionStateChange!()

      // connectionState should be set immediately
      expect(useCallStore.getState().connectionState).toBe('failed')
      // diagnosticState should NOT be set immediately (10-second delay in webRTCManager)
      expect(useCallStore.getState().diagnosticState).toBeNull()

      // Advance 10 seconds for the diagnostic callback to fire
      await vi.advanceTimersByTimeAsync(10_000)

      expect(useCallStore.getState().diagnosticState).not.toBeNull()
      expect(useCallStore.getState().diagnosticState!.failed).toBe(true)

      vi.useRealTimers()
    })

    it('clears diagnosticState when connection recovers to "connected"', async () => {
      vi.useFakeTimers()
      await setupActiveCall()

      const pc = pcInstances[0]

      // First fail
      pc.connectionState = 'failed'
      pcOnConnectionStateChange!()

      // Advance past the diagnostic delay
      await vi.advanceTimersByTimeAsync(10_000)
      expect(useCallStore.getState().diagnosticState).not.toBeNull()

      // Then recover
      pc.connectionState = 'connected'
      pcOnConnectionStateChange!()
      expect(useCallStore.getState().diagnosticState).toBeNull()
      expect(useCallStore.getState().connectionState).toBe('connected')

      vi.useRealTimers()
    })

    it('does not fire diagnosticState if connection recovers before 10s', async () => {
      vi.useFakeTimers()
      await setupActiveCall()

      const pc = pcInstances[0]

      // Fail
      pc.connectionState = 'failed'
      pcOnConnectionStateChange!()

      // Recover after 5 seconds (before 10s delay fires)
      await vi.advanceTimersByTimeAsync(5_000)
      pc.connectionState = 'connected'
      pcOnConnectionStateChange!()

      // Advance past 10s total
      await vi.advanceTimersByTimeAsync(10_000)

      // diagnosticState should still be null since connection recovered
      expect(useCallStore.getState().diagnosticState).toBeNull()

      vi.useRealTimers()
    })
  })

  describe('VOICE_STATE_UPDATE event', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('updates participant state when user joins/updates', async () => {
      await setupActiveCall()

      emitWsEvent('VOICE_STATE_UPDATE', {
        user_id: 'user-2',
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })

      const participants = useCallStore.getState().participants
      expect(participants.has('user-2')).toBe(true)
      expect(participants.get('user-2')!.selfMute).toBe(false)
    })

    it('removes participant when channel_id is null', async () => {
      await setupActiveCall()

      // Add participant
      emitWsEvent('VOICE_STATE_UPDATE', {
        user_id: 'user-2',
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })
      expect(useCallStore.getState().participants.has('user-2')).toBe(true)

      // Remove participant
      emitWsEvent('VOICE_STATE_UPDATE', {
        user_id: 'user-2',
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      })
      expect(useCallStore.getState().participants.has('user-2')).toBe(false)
    })

    it('triggers key rotation when a new participant joins and local user is lowest ID', async () => {
      await setupActiveCall()
      vi.mocked(cryptoService.distributeMediaKey).mockClear()
      vi.mocked(useAuthStore.getState).mockReturnValue({ user: { id: 'aaa-local' } } as ReturnType<typeof useAuthStore.getState>)

      // New participant joins with a higher userId
      emitWsEvent('VOICE_STATE_UPDATE', {
        user_id: 'zzz-remote',
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })

      // Give async rotation a tick
      await new Promise((r) => setTimeout(r, 50))

      // generateMediaKey should have been called for the rotation
      expect(generateMediaKey).toHaveBeenCalled()
    })

    it('does NOT trigger key rotation when local user is NOT lowest ID on join', async () => {
      await setupActiveCall()
      vi.mocked(generateMediaKey as Mock).mockClear()
      vi.mocked(useAuthStore.getState).mockReturnValue({ user: { id: 'zzz-local' } } as ReturnType<typeof useAuthStore.getState>)

      // New participant joins with a lower userId
      emitWsEvent('VOICE_STATE_UPDATE', {
        user_id: 'aaa-remote',
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })

      await new Promise((r) => setTimeout(r, 50))

      // generateMediaKey should NOT have been called (aaa-remote is lowest, not us)
      expect(generateMediaKey).not.toHaveBeenCalled()
    })

    it('triggers key rotation when participant leaves and local user is lowest remaining ID', async () => {
      await setupActiveCall()
      vi.mocked(useAuthStore.getState).mockReturnValue({ user: { id: 'aaa-local' } } as ReturnType<typeof useAuthStore.getState>)

      // Add two participants
      emitWsEvent('VOICE_STATE_UPDATE', {
        user_id: 'bbb-remote',
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })
      emitWsEvent('VOICE_STATE_UPDATE', {
        user_id: 'ccc-remote',
        channel_id: 'channel-1',
        self_mute: false,
        self_deaf: false,
      })

      await new Promise((r) => setTimeout(r, 50))
      vi.mocked(generateMediaKey as Mock).mockClear()

      // One participant leaves
      emitWsEvent('VOICE_STATE_UPDATE', {
        user_id: 'ccc-remote',
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      })

      await new Promise((r) => setTimeout(r, 50))

      // Should rotate since local user (aaa-local) is the lowest among remaining
      expect(generateMediaKey).toHaveBeenCalled()
    })
  })

  describe('CALL_STARTED event', () => {
    it('tracks active channel calls', () => {
      emitWsEvent('CALL_STARTED', {
        room_id: 'room-abc',
        channel_id: 'channel-5',
        initiator_id: 'user-1',
      })

      const state = useCallStore.getState()
      expect(state.activeChannelCalls.has('channel-5')).toBe(true)
      expect(state.activeChannelCalls.get('channel-5')).toBe('room-abc')
    })

    it('removes from activeChannelCalls on CALL_ENDED', () => {
      emitWsEvent('CALL_STARTED', {
        room_id: 'room-abc',
        channel_id: 'channel-5',
        initiator_id: 'user-1',
      })
      expect(useCallStore.getState().activeChannelCalls.has('channel-5')).toBe(true)

      emitWsEvent('CALL_ENDED', { room_id: 'room-abc' })
      expect(useCallStore.getState().activeChannelCalls.has('channel-5')).toBe(false)
    })
  })

  describe('CALL_ENDED event', () => {
    it('cleans up callStore when call ends', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      expect(useCallStore.getState().activeCall).not.toBeNull()

      emitWsEvent('CALL_ENDED', { room_id: 'room-123' })

      const state = useCallStore.getState()
      expect(state.activeCall).toBeNull()
      expect(state.localStream).toBeNull()
      expect(state.callConfig).toBeNull()
    })
  })

  describe('MEDIA_KEY event', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('decrypts media key via DR and imports into keyRing', async () => {
      await setupActiveCall()
      vi.mocked(cryptoService.decryptMediaKey).mockClear()
      vi.mocked(importMediaKey as Mock).mockClear()

      const keyRing = webRTCManager.getMediaKeyRing()!
      expect(keyRing.currentKey).not.toBeNull() // set during joinCall

      emitWsEvent('MEDIA_KEY', {
        room_id: 'room-123',
        sender_id: 'user-2',
        sender_device_id: 'device-2',
        ciphertext: [1, 2, 3],
      })

      await new Promise((r) => setTimeout(r, 50))

      // Should have called decryptMediaKey with DR params
      expect(cryptoService.decryptMediaKey).toHaveBeenCalledWith({
        senderId: 'user-2',
        senderDeviceId: 'device-2',
        ciphertext: [1, 2, 3],
      })

      // Should have imported the decrypted key
      expect(importMediaKey).toHaveBeenCalled()
    })

    it('uses sender epoch via setKeyForEpoch (not auto-increment)', async () => {
      await setupActiveCall()

      const keyRing = webRTCManager.getMediaKeyRing()!
      expect(keyRing.currentEpoch).toBe(0) // initial epoch

      // Receive a key at epoch 5 (simulating coordinator at epoch 5)
      vi.mocked(cryptoService.decryptMediaKey).mockResolvedValueOnce({
        key: Array.from(new Uint8Array(32)),
        epoch: 5,
        roomId: 'room-123',
      })

      emitWsEvent('MEDIA_KEY', {
        room_id: 'room-123',
        sender_id: 'user-2',
        sender_device_id: 'device-2',
        ciphertext: [1, 2, 3],
      })

      await new Promise((r) => setTimeout(r, 50))

      // Epoch should be 5 (sender's epoch), NOT 1 (auto-increment)
      expect(keyRing.currentEpoch).toBe(5)
    })

    it('handles concurrent key distributions without epoch desync', async () => {
      await setupActiveCall()

      const keyRing = webRTCManager.getMediaKeyRing()!
      expect(keyRing.currentEpoch).toBe(0)

      // Simulate receiving a stale epoch 0 key from a concurrent joiner
      vi.mocked(cryptoService.decryptMediaKey).mockResolvedValueOnce({
        key: Array.from(new Uint8Array(32)),
        epoch: 0,
        roomId: 'room-123',
      })

      emitWsEvent('MEDIA_KEY', {
        room_id: 'room-123',
        sender_id: 'joiner-user',
        sender_device_id: 'device-joiner',
        ciphertext: [10, 20, 30],
      })

      await new Promise((r) => setTimeout(r, 50))

      // Epoch should still be 0 (not incremented to 1)
      expect(keyRing.currentEpoch).toBe(0)

      // Now receive the coordinator's key at epoch 3
      vi.mocked(cryptoService.decryptMediaKey).mockResolvedValueOnce({
        key: Array.from(new Uint8Array(32)),
        epoch: 3,
        roomId: 'room-123',
      })

      emitWsEvent('MEDIA_KEY', {
        room_id: 'room-123',
        sender_id: 'coordinator-user',
        sender_device_id: 'device-coord',
        ciphertext: [40, 50, 60],
      })

      await new Promise((r) => setTimeout(r, 50))

      // Epoch should be exactly 3 (coordinator's epoch), not 1 or 4
      expect(keyRing.currentEpoch).toBe(3)
    })

    it('does not import key when decryption fails', async () => {
      await setupActiveCall()
      vi.mocked(cryptoService.decryptMediaKey).mockResolvedValueOnce({ error: 'DECRYPT_FAILED' })
      vi.mocked(importMediaKey as Mock).mockClear()

      emitWsEvent('MEDIA_KEY', {
        room_id: 'room-123',
        sender_id: 'user-2',
        sender_device_id: 'device-2',
        ciphertext: [1, 2, 3],
      })

      await new Promise((r) => setTimeout(r, 50))

      expect(importMediaKey).not.toHaveBeenCalled()
    })
  })

  // TESTSPEC: ST-015
  describe('call_join_leave', () => {
    it('joinCall sets activeCall, leaveCall clears it', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      // activeCall should be set after joining
      const stateAfterJoin = useCallStore.getState()
      expect(stateAfterJoin.activeCall).not.toBeNull()
      expect(stateAfterJoin.activeCall?.channelId).toBe('channel-1')

      // leaveCall should clear activeCall
      await useCallStore.getState().leaveCall()
      const stateAfterLeave = useCallStore.getState()
      expect(stateAfterLeave.activeCall).toBeNull()
    })
  })

  // TESTSPEC: ST-016
  describe('call_toggle_mute', () => {
    it('toggleMute flips isMuted', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      expect(useCallStore.getState().isMuted).toBe(false)

      useCallStore.getState().toggleMute()
      expect(useCallStore.getState().isMuted).toBe(true)

      useCallStore.getState().toggleMute()
      expect(useCallStore.getState().isMuted).toBe(false)
    })
  })

  describe('SDP answer handling', () => {
    it('sets remote description when SDP answer received via WEBRTC_SIGNAL', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      const pc = pcInstances[0]
      const setRemoteSpy = vi.spyOn(pc, 'setRemoteDescription')

      emitWsEvent('WEBRTC_SIGNAL', {
        from_user: 'sfu',
        signal: {
          type: 'answer',
          sdp: 'mock-answer-sdp',
        },
      })

      await new Promise((r) => setTimeout(r, 10))

      expect(setRemoteSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'answer', sdp: 'mock-answer-sdp' })
      )
    })
  })

  describe('SFU-initiated renegotiation', () => {
    it('handles offer from SFU by creating and sending an answer', async () => {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise

      const pc = pcInstances[0]
      const setRemoteSpy = vi.spyOn(pc, 'setRemoteDescription')
      const createAnswerSpy = vi.spyOn(pc, 'createAnswer')
      vi.mocked(wsManager.send).mockClear()

      // SFU sends an offer (new participant joined)
      emitWsEvent('WEBRTC_SIGNAL', {
        from_user: 'sfu',
        signal: {
          type: 'offer',
          sdp: 'sfu-renegotiation-offer-sdp',
        },
      })

      // Wait for async negotiation queue to process
      await new Promise((r) => setTimeout(r, 50))

      expect(setRemoteSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'offer', sdp: 'sfu-renegotiation-offer-sdp' })
      )
      expect(createAnswerSpy).toHaveBeenCalled()
      expect(wsManager.send).toHaveBeenCalledWith('webrtc_signal', {
        room_id: 'room-123',
        signal: { type: 'answer', sdp: 'mock-answer-sdp' },
      })
    })
  })

  describe('WebSocket disconnect', () => {
    async function setupActiveCall(): Promise<void> {
      const joinPromise = useCallStore.getState().joinCall('channel-1')
      emitWsEvent('CALL_CONFIG', mockCallConfigEvent)
      await joinPromise
    }

    it('terminates active call when WebSocket disconnects', async () => {
      await setupActiveCall()
      expect(useCallStore.getState().activeCall).not.toBeNull()

      const pc = pcInstances[0]

      // Simulate WS disconnect
      emitWsStateChange('DISCONNECTED')

      // Call should be terminated
      const state = useCallStore.getState()
      expect(state.activeCall).toBeNull()
      expect(state.error).toBe('WebSocket disconnected')
      expect(pc.closed).toBe(true)
    })

    it('does nothing when no active call on disconnect', () => {
      expect(useCallStore.getState().activeCall).toBeNull()

      emitWsStateChange('DISCONNECTED')

      // Should not set error
      expect(useCallStore.getState().error).toBeNull()
    })
  })
})
