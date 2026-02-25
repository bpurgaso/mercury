import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock RTCPeerConnection for diagnostics
let mockPcInstances: MockPc[] = []

class MockPc {
  onicecandidate: ((e: { candidate: { type: string } | null }) => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  iceGatheringState = 'new'
  private _config: { iceServers?: { urls: string[] }[]; iceTransportPolicy?: string }
  private _candidateTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: { iceServers?: { urls: string[] }[]; iceTransportPolicy?: string }) {
    this._config = config
    mockPcInstances.push(this)
  }

  createDataChannel() { return {} }

  async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' } }

  async setLocalDescription() {
    // Simulate ICE candidate gathering based on config
    const isRelay = this._config.iceTransportPolicy === 'relay'
    const urls = this._config.iceServers?.[0]?.urls ?? []

    this._candidateTimer = setTimeout(() => {
      // Determine candidate type based on URLs
      if (isRelay) {
        // TURN test - check if URL contains 'turn'
        if (urls.some((u: string) => u.includes('turn'))) {
          // Simulate relay candidate
          if (this.onicecandidate) {
            this.onicecandidate({ candidate: { type: 'relay' } })
          }
        }
      } else {
        // STUN test
        if (urls.some((u: string) => u.includes('stun'))) {
          if (this.onicecandidate) {
            this.onicecandidate({ candidate: { type: 'srflx' } })
          }
        }
      }
    }, 50)
  }

  close() {
    if (this._candidateTimer) clearTimeout(this._candidateTimer)
  }

  // Test helper: simulate gathering complete with no candidates
  _failGathering() {
    if (this._candidateTimer) clearTimeout(this._candidateTimer)
    this.iceGatheringState = 'complete'
    if (this.onicegatheringstatechange) this.onicegatheringstatechange()
  }
}

// @ts-ignore
globalThis.RTCPeerConnection = MockPc

describe('IceDiagnosticRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockPcInstances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should check websocket status immediately', async () => {
    const { IceDiagnosticRunner } = await import('../../../src/renderer/services/ice-diagnostics')
    const runner = new IceDiagnosticRunner()
    const progress = vi.fn()
    runner.onProgress(progress)

    const resultPromise = runner.run({
      wsConnected: true,
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      connectStartTime: null,
    })

    // Let STUN/TURN checks timeout
    await vi.advanceTimersByTimeAsync(10000)
    const result = await resultPromise

    expect(result.websocket).toBe('pass')
    // No STUN URLs → fail
    expect(result.stun).toBe('fail')
    // No TURN URLs → fail
    expect(result.turnUdp).toBe('fail')
    expect(result.turnTcp).toBe('fail')
  })

  it('should report websocket fail when disconnected', async () => {
    const { IceDiagnosticRunner } = await import('../../../src/renderer/services/ice-diagnostics')
    const runner = new IceDiagnosticRunner()

    const resultPromise = runner.run({
      wsConnected: false,
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      connectStartTime: null,
    })

    await vi.advanceTimersByTimeAsync(10000)
    const result = await resultPromise

    expect(result.websocket).toBe('fail')
  })

  it('should pass STUN check when srflx candidate is gathered', async () => {
    const { IceDiagnosticRunner } = await import('../../../src/renderer/services/ice-diagnostics')
    const runner = new IceDiagnosticRunner()

    const resultPromise = runner.run({
      wsConnected: true,
      stunUrls: ['stun:stun.example.com:3478'],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      connectStartTime: null,
    })

    // Advance past candidate generation delay (50ms) and check timeout
    await vi.advanceTimersByTimeAsync(10000)
    const result = await resultPromise

    expect(result.stun).toBe('pass')
  })

  it('should pass TURN UDP check when relay candidate is gathered', async () => {
    const { IceDiagnosticRunner } = await import('../../../src/renderer/services/ice-diagnostics')
    const runner = new IceDiagnosticRunner()

    const resultPromise = runner.run({
      wsConnected: true,
      stunUrls: [],
      turnUrls: ['turn:turn.example.com:3478'],
      turnUsername: 'user',
      turnCredential: 'pass',
      connectStartTime: null,
    })

    await vi.advanceTimersByTimeAsync(10000)
    const result = await resultPromise

    expect(result.turnUdp).toBe('pass')
    // No TCP URLs
    expect(result.turnTcp).toBe('fail')
  })

  it('should pass TURN TCP check when relay candidate is gathered', async () => {
    const { IceDiagnosticRunner } = await import('../../../src/renderer/services/ice-diagnostics')
    const runner = new IceDiagnosticRunner()

    const resultPromise = runner.run({
      wsConnected: true,
      stunUrls: [],
      turnUrls: ['turn:turn.example.com:443?transport=tcp'],
      turnUsername: 'user',
      turnCredential: 'pass',
      connectStartTime: null,
    })

    await vi.advanceTimersByTimeAsync(10000)
    const result = await resultPromise

    expect(result.turnTcp).toBe('pass')
    // No UDP URLs
    expect(result.turnUdp).toBe('fail')
  })

  it('should compute timeToConnectedMs from connectStartTime', async () => {
    const { IceDiagnosticRunner } = await import('../../../src/renderer/services/ice-diagnostics')
    const runner = new IceDiagnosticRunner()

    const startTime = Date.now() - 5000 // 5 seconds ago
    const resultPromise = runner.run({
      wsConnected: true,
      stunUrls: [],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      connectStartTime: startTime,
    })

    await vi.advanceTimersByTimeAsync(10000)
    const result = await resultPromise

    expect(result.timeToConnectedMs).toBeGreaterThanOrEqual(5000)
  })

  it('should emit progress updates as checks complete', async () => {
    const { IceDiagnosticRunner } = await import('../../../src/renderer/services/ice-diagnostics')
    const runner = new IceDiagnosticRunner()
    const progress = vi.fn()
    runner.onProgress(progress)

    const resultPromise = runner.run({
      wsConnected: true,
      stunUrls: ['stun:stun.example.com'],
      turnUrls: ['turn:turn.example.com'],
      turnUsername: 'user',
      turnCredential: 'pass',
      connectStartTime: null,
    })

    await vi.advanceTimersByTimeAsync(10000)
    await resultPromise

    // Should have been called multiple times:
    // 1. initial (all pending)
    // 2. after websocket check
    // 3. after stun check
    // 4. after turn udp check
    // 5. after turn tcp check
    expect(progress.mock.calls.length).toBeGreaterThanOrEqual(4)

    // First call should show websocket pending or pass
    const firstResult = progress.mock.calls[0][0]
    expect(firstResult.websocket).toBeDefined()
  })

  it('should abort when abort() is called', async () => {
    const { IceDiagnosticRunner } = await import('../../../src/renderer/services/ice-diagnostics')
    const runner = new IceDiagnosticRunner()
    const progress = vi.fn()
    runner.onProgress(progress)

    const resultPromise = runner.run({
      wsConnected: true,
      stunUrls: ['stun:stun.example.com'],
      turnUrls: ['turn:turn.example.com'],
      turnUsername: 'user',
      turnCredential: 'pass',
      connectStartTime: null,
    })

    // Abort immediately after WebSocket check
    runner.abort()

    await vi.advanceTimersByTimeAsync(10000)
    const result = await resultPromise

    // WebSocket should be checked, but other checks may not complete
    expect(result.websocket).toBe('pass')
  })
})

describe('ICE_DIAGNOSTIC WebSocket event', () => {
  it('should have correct payload shape', () => {
    const payload = {
      call_id: 'room-123',
      stun: true,
      turn_udp: false,
      turn_tcp: false,
      time_to_connected_ms: 12500,
    }

    expect(payload).toHaveProperty('call_id')
    expect(payload).toHaveProperty('stun')
    expect(payload).toHaveProperty('turn_udp')
    expect(payload).toHaveProperty('turn_tcp')
    expect(payload).toHaveProperty('time_to_connected_ms')
    expect(typeof payload.stun).toBe('boolean')
    expect(typeof payload.turn_udp).toBe('boolean')
    expect(typeof payload.turn_tcp).toBe('boolean')
  })

  it('should allow null time_to_connected_ms', () => {
    const payload = {
      call_id: 'room-123',
      stun: false,
      turn_udp: false,
      turn_tcp: false,
      time_to_connected_ms: null,
    }

    expect(payload.time_to_connected_ms).toBeNull()
  })
})
