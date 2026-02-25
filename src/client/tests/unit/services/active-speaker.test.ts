import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock AudioContext and AnalyserNode before importing the module

class MockAnalyserNode {
  fftSize = 256
  private _data: Uint8Array

  constructor(level: number) {
    // Generate waveform data centered at 128, with deviation proportional to level
    this._data = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      this._data[i] = 128 + Math.round(level * 128 * Math.sin(i / 10))
    }
  }

  getByteTimeDomainData(data: Uint8Array): void {
    data.set(this._data.subarray(0, data.length))
  }

  setLevel(level: number): void {
    for (let i = 0; i < 256; i++) {
      this._data[i] = 128 + Math.round(level * 128 * Math.sin(i / 10))
    }
  }
}

const analyserRegistry = new Map<string, MockAnalyserNode>()

class MockAudioContext {
  currentTime = 0

  createMediaStreamSource(_stream: MediaStream) {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
  }

  createAnalyser() {
    // Return the pre-registered analyser based on order of creation
    const analyser = new MockAnalyserNode(0)
    return analyser
  }

  close() {
    return Promise.resolve()
  }
}

// @ts-ignore - mock global
globalThis.AudioContext = MockAudioContext

// We need to test the core logic of the ActiveSpeakerDetector
describe('ActiveSpeakerDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    analyserRegistry.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should export ActiveSpeakerDetector class', async () => {
    const { ActiveSpeakerDetector } = await import('../../../src/renderer/services/active-speaker')
    expect(ActiveSpeakerDetector).toBeDefined()
  })

  it('should fire callback on speaking change', async () => {
    const { ActiveSpeakerDetector } = await import('../../../src/renderer/services/active-speaker')
    const detector = new ActiveSpeakerDetector()
    const cb = vi.fn()
    detector.onSpeakingChange(cb)

    const mockStream = {
      getAudioTracks: () => [{ kind: 'audio', enabled: true, readyState: 'live' }],
    } as unknown as MediaStream

    detector.start('local-user', () => ({
      localStream: mockStream,
      remoteStreams: new Map(),
    }))

    // Advance past the poll interval
    vi.advanceTimersByTime(100)

    // The callback should have been called at least once
    expect(cb).toHaveBeenCalled()

    detector.stop()
  })

  it('should cleanup on stop', async () => {
    const { ActiveSpeakerDetector } = await import('../../../src/renderer/services/active-speaker')
    const detector = new ActiveSpeakerDetector()

    detector.start('local-user', () => ({
      localStream: null,
      remoteStreams: new Map(),
    }))

    detector.stop()

    // Advancing timers should not cause errors
    vi.advanceTimersByTime(1000)
  })

  it('should unsubscribe callback', async () => {
    const { ActiveSpeakerDetector } = await import('../../../src/renderer/services/active-speaker')
    const detector = new ActiveSpeakerDetector()
    const cb = vi.fn()
    const unsub = detector.onSpeakingChange(cb)

    detector.start('local-user', () => ({
      localStream: null,
      remoteStreams: new Map(),
    }))

    unsub()
    vi.advanceTimersByTime(200)

    expect(cb).not.toHaveBeenCalled()
    detector.stop()
  })

  it('should track multiple participants', async () => {
    const { ActiveSpeakerDetector } = await import('../../../src/renderer/services/active-speaker')
    const detector = new ActiveSpeakerDetector()
    const cb = vi.fn()
    detector.onSpeakingChange(cb)

    const localStream = {
      getAudioTracks: () => [{ kind: 'audio', enabled: true, readyState: 'live' }],
    } as unknown as MediaStream

    const remoteStream = {
      getAudioTracks: () => [{ kind: 'audio', enabled: true, readyState: 'live' }],
    } as unknown as MediaStream

    const remoteStreams = new Map([['remote-1', remoteStream]])

    detector.start('local-user', () => ({
      localStream,
      remoteStreams,
    }))

    vi.advanceTimersByTime(100)

    // Callback should receive a map with both users
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1]
    const speakersMap = lastCall[0] as Map<string, boolean>
    expect(speakersMap.has('local-user')).toBe(true)
    expect(speakersMap.has('remote-1')).toBe(true)

    detector.stop()
  })
})
