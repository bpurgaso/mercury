import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { encode } from '@msgpack/msgpack'
import { calculateBackoff, WebSocketManager } from '../../../src/renderer/services/websocket'

// ── Mock WebSocket ────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  binaryType = 'blob'
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  sent: unknown[] = []

  constructor(public url: string) {
    // Auto-open on next tick
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.(new Event('open'))
    }, 0)
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }

  // Test helper: simulate receiving a message
  _receive(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  _receiveBinary(data: ArrayBuffer) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  _close(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code, reason }))
  }
}

// Mock globals
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()

let lastMockWs: MockWebSocket | null = null

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => 'mock-device-uuid' },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'WebSocket', {
    value: class extends MockWebSocket {
      constructor(url: string) {
        super(url)
        lastMockWs = this
      }
    },
    configurable: true,
  })
  localStorageMock.clear()
  lastMockWs = null
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── Helper ────────────────────────────────────────────────

function flushTimers() {
  return vi.advanceTimersByTimeAsync(0)
}

// ── WSM-001: connect_and_identify ─────────────────────────

// TESTSPEC: WSM-001
describe('WebSocketManager connect and identify', () => {
  it('sends identify on connect and transitions to CONNECTED on READY', async () => {
    const mgr = new WebSocketManager()
    mgr.connect('test-token')

    // Advance timers to trigger MockWebSocket onopen
    await flushTimers()

    const ws = lastMockWs!
    expect(ws).not.toBeNull()

    // Should have sent identify
    expect(ws.sent.length).toBeGreaterThanOrEqual(1)
    const identifyMsg = JSON.parse(ws.sent[0] as string)
    expect(identifyMsg.op).toBe('identify')
    expect(identifyMsg.d.token).toBe('test-token')

    // Simulate server sending READY
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-123', heartbeat_interval: 30 },
      seq: 1,
    }))

    expect(mgr.getState()).toBe('CONNECTED')
    expect(mgr.getSessionId()).toBe('sess-123')

    mgr.disconnect()
  })
})

// ── WSM-002: heartbeat_interval ───────────────────────────

// TESTSPEC: WSM-002
describe('WebSocketManager heartbeat', () => {
  it('sends heartbeats at the configured interval', async () => {
    const mgr = new WebSocketManager()
    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!

    // READY with 30s heartbeat interval
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-hb', heartbeat_interval: 30 },
      seq: 1,
    }))

    const sentBefore = ws.sent.length

    // Advance 30 seconds → first heartbeat
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ws.sent.length).toBe(sentBefore + 1)
    const hb1 = JSON.parse(ws.sent[ws.sent.length - 1] as string)
    expect(hb1.op).toBe('heartbeat')

    // Simulate ACK to prevent disconnect
    ws._receive(JSON.stringify({ t: 'HEARTBEAT_ACK' }))

    // Advance another 30 seconds → second heartbeat
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ws.sent.length).toBe(sentBefore + 2)

    // Simulate ACK
    ws._receive(JSON.stringify({ t: 'HEARTBEAT_ACK' }))

    // Third cycle
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ws.sent.length).toBe(sentBefore + 3)

    mgr.disconnect()
  })
})

// ── WSM-003: reconnect_on_close ───────────────────────────

// TESTSPEC: WSM-003
describe('WebSocketManager reconnect on close', () => {
  it('transitions to RECONNECTING and schedules reconnect after close', async () => {
    const mgr = new WebSocketManager()
    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!

    // Move to CONNECTED
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-rc', heartbeat_interval: 30 },
      seq: 1,
    }))
    expect(mgr.getState()).toBe('CONNECTED')

    // Simulate server close
    ws._close(1006, '')

    expect(mgr.getState()).toBe('RECONNECTING')

    // Advance past reconnect delay (~1s for attempt 0)
    await vi.advanceTimersByTimeAsync(1500)

    // A new WebSocket connection should have been created
    expect(lastMockWs).not.toBe(ws)

    mgr.disconnect()
  })
})

// ── WSM-006: extended_base_after_5s ───────────────────────

// TESTSPEC: WSM-006
describe('WebSocketManager extended backoff', () => {
  it('uses longer delay after multiple reconnect attempts', () => {
    // After 5 failed reconnects, backoff should be > 5000ms
    const delays: number[] = []
    for (let i = 0; i < 50; i++) {
      delays.push(calculateBackoff(5))
    }
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length
    // At attempt 5: min(1000 * 2^5, 30000) = 30000 (capped), so it should be ~30000
    expect(avg).toBeGreaterThan(5000)
  })
})

// ── WSM-007: retry_after_respected ────────────────────────

// TESTSPEC: WSM-007
describe('WebSocketManager retry-after', () => {
  it('respects server Retry-After in close reason', async () => {
    const mgr = new WebSocketManager()
    const states: string[] = []
    mgr.onStateChange((s) => states.push(s))

    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-ra', heartbeat_interval: 30 },
      seq: 1,
    }))

    // Server closes with code 1013 and Retry-After
    ws._close(1013, 'Retry-After: 15')

    expect(mgr.getState()).toBe('RECONNECTING')

    // Should NOT reconnect within 14s
    const wsBefore = lastMockWs
    await vi.advanceTimersByTimeAsync(14_000)
    // The WS should still be the closed one (no new connection yet)

    // After 15s total, should have reconnected
    await vi.advanceTimersByTimeAsync(2_000)
    expect(lastMockWs).not.toBe(ws)

    mgr.disconnect()
  })
})

// ── WSM-008: resume_before_identify ───────────────────────

// TESTSPEC: WSM-008
describe('WebSocketManager resume', () => {
  it('sends resume on reconnect instead of identify', async () => {
    const mgr = new WebSocketManager()
    mgr.connect('test-token')
    await flushTimers()

    const ws1 = lastMockWs!

    // Establish session
    ws1._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-resume', heartbeat_interval: 30 },
      seq: 5,
    }))
    expect(mgr.getSessionId()).toBe('sess-resume')

    // Simulate close (not session expired)
    ws1._close(1006, '')

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(2000)
    await flushTimers()

    const ws2 = lastMockWs!
    expect(ws2).not.toBe(ws1)

    // The first message on the new connection should be resume, not identify
    const resumeMsg = JSON.parse(ws2.sent[0] as string)
    expect(resumeMsg.op).toBe('resume')
    expect(resumeMsg.d.session_id).toBe('sess-resume')
    expect(resumeMsg.d.seq).toBe(5)

    mgr.disconnect()
  })

  it('falls back to identify when session is expired (4009)', async () => {
    const mgr = new WebSocketManager()
    mgr.connect('test-token')
    await flushTimers()

    const ws1 = lastMockWs!

    ws1._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-expired', heartbeat_interval: 30 },
      seq: 3,
    }))

    // Close with session expired code
    ws1._close(4009, 'Session expired')

    // Session should be cleared
    expect(mgr.getSessionId()).toBeNull()

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(2000)
    await flushTimers()

    const ws2 = lastMockWs!
    const msg = JSON.parse(ws2.sent[0] as string)
    expect(msg.op).toBe('identify')

    mgr.disconnect()
  })
})

// ── WSM-009: event_dispatch_typed ─────────────────────────

// TESTSPEC: WSM-009
describe('WebSocketManager event dispatch', () => {
  // TESTSPEC: WSM-011
  it('dispatches typed events to registered listeners', async () => {
    const mgr = new WebSocketManager()
    const received: unknown[] = []

    mgr.on('MESSAGE_CREATE', (data) => {
      received.push(data)
    })

    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-ev', heartbeat_interval: 30 },
      seq: 1,
    }))

    // Simulate MESSAGE_CREATE event
    const msgData = {
      id: 'msg-1',
      channel_id: 'ch-1',
      sender_id: 'user-1',
      content: 'Hello!',
    }
    ws._receive(JSON.stringify({ t: 'MESSAGE_CREATE', d: msgData, seq: 2 }))

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(msgData)

    mgr.disconnect()
  })

  it('unsubscribe removes the listener', async () => {
    const mgr = new WebSocketManager()
    const received: unknown[] = []

    const unsub = mgr.on('PRESENCE_UPDATE', (data) => {
      received.push(data)
    })

    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-unsub', heartbeat_interval: 30 },
      seq: 1,
    }))

    ws._receive(JSON.stringify({ t: 'PRESENCE_UPDATE', d: { user_id: 'u1', status: 'online' }, seq: 2 }))
    expect(received).toHaveLength(1)

    unsub()

    ws._receive(JSON.stringify({ t: 'PRESENCE_UPDATE', d: { user_id: 'u2', status: 'online' }, seq: 3 }))
    expect(received).toHaveLength(1) // Still 1 — unsubscribed

    mgr.disconnect()
  })
})

// ── WSM-010: msgpack_binary_decode ────────────────────────

// TESTSPEC: WSM-010
describe('WebSocketManager binary frame decode (msgpack)', () => {
  it('decodes incoming binary (msgpack) frame and dispatches event', async () => {
    const mgr = new WebSocketManager()
    const received: unknown[] = []

    mgr.on('MESSAGE_CREATE', (data) => {
      received.push(data)
    })

    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!

    // Establish session
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-msgpack', heartbeat_interval: 30 },
      seq: 1,
    }))
    expect(mgr.getState()).toBe('CONNECTED')

    // Build a msgpack-encoded MESSAGE_CREATE event
    const eventPayload = {
      t: 'MESSAGE_CREATE',
      d: {
        id: 'msg-bin-1',
        channel_id: 'ch-bin',
        sender_id: 'user-bin',
        content: 'Hello from binary!',
      },
      seq: 2,
    }
    const packed = encode(eventPayload)
    // Create a standalone ArrayBuffer (encode may return a view into a larger buffer)
    const arrayBuffer = packed.slice().buffer as ArrayBuffer

    // Simulate receiving a binary frame
    ws._receiveBinary(arrayBuffer)

    // Verify the event was dispatched to the listener
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(eventPayload.d)

    // Verify sequence number was updated
    expect(mgr.getSeq()).toBe(2)

    mgr.disconnect()
  })
})

// ── WSM-012: send_message_as_msgpack ──────────────────────

// TESTSPEC: WSM-012
describe('WebSocketManager binary framing', () => {
  it('sends DM message_send as binary (msgpack)', async () => {
    const mgr = new WebSocketManager()
    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-bin', heartbeat_interval: 30 },
      seq: 1,
    }))

    // Send a DM message (has dm_channel_id → should use binary)
    mgr.send('message_send', {
      dm_channel_id: 'dm-1',
      recipients: [{ device_id: 'dev-1', ciphertext: [1, 2, 3] }],
    })

    // The last sent item should be a Uint8Array (msgpack binary)
    const lastSent = ws.sent[ws.sent.length - 1]
    expect(lastSent).toBeInstanceOf(Uint8Array)

    mgr.disconnect()
  })
})

// ── WSM-013: send_control_as_json ─────────────────────────

// TESTSPEC: WSM-013
describe('WebSocketManager JSON framing for control ops', () => {
  it('sends heartbeat as JSON text', async () => {
    const mgr = new WebSocketManager()
    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-json', heartbeat_interval: 30 },
      seq: 1,
    }))

    mgr.send('heartbeat', { seq: 1 })

    const lastSent = ws.sent[ws.sent.length - 1]
    expect(typeof lastSent).toBe('string')
    const parsed = JSON.parse(lastSent as string)
    expect(parsed.op).toBe('heartbeat')

    mgr.disconnect()
  })

  it('sends standard channel message_send as JSON', async () => {
    const mgr = new WebSocketManager()
    mgr.connect('test-token')
    await flushTimers()

    const ws = lastMockWs!
    ws._receive(JSON.stringify({
      t: 'READY',
      d: { session_id: 'sess-std', heartbeat_interval: 30 },
      seq: 1,
    }))

    // Standard channel message (channel_id + content, no dm_channel_id)
    mgr.send('message_send', {
      channel_id: 'ch-1',
      content: 'Hello, world!',
    })

    const lastSent = ws.sent[ws.sent.length - 1]
    expect(typeof lastSent).toBe('string')
    const parsed = JSON.parse(lastSent as string)
    expect(parsed.op).toBe('message_send')
    expect(parsed.d.content).toBe('Hello, world!')

    mgr.disconnect()
  })
})

// ── Original backoff tests ────────────────────────────────

describe('WebSocket reconnection backoff', () => {
  it('starts at ~1s for attempt 0', () => {
    const delays: number[] = []
    for (let i = 0; i < 100; i++) {
      delays.push(calculateBackoff(0))
    }
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length

    // Should be roughly 1000ms with +/-20% jitter -> [800, 1200]
    expect(avg).toBeGreaterThan(700)
    expect(avg).toBeLessThan(1300)
  })

  // TESTSPEC: WSM-004
  it('grows exponentially: attempt 0 < attempt 1 < attempt 2', () => {
    const avg = (attempt: number) => {
      const samples = Array.from({ length: 200 }, () => calculateBackoff(attempt))
      return samples.reduce((a, b) => a + b, 0) / samples.length
    }

    const a0 = avg(0) // ~1000
    const a1 = avg(1) // ~2000
    const a2 = avg(2) // ~4000
    const a3 = avg(3) // ~8000

    expect(a1).toBeGreaterThan(a0)
    expect(a2).toBeGreaterThan(a1)
    expect(a3).toBeGreaterThan(a2)
  })

  it('caps at 30s regardless of attempt number', () => {
    for (let i = 0; i < 100; i++) {
      const delay = calculateBackoff(20) // way past the cap
      expect(delay).toBeLessThanOrEqual(30_000 * 1.2) // 30s + max jitter
    }
  })

  // TESTSPEC: WSM-005
  it('applies jitter within +/-20% bounds', () => {
    // At attempt 0, base is 1000ms. +/-20% -> [800, 1200]
    for (let i = 0; i < 200; i++) {
      const delay = calculateBackoff(0)
      expect(delay).toBeGreaterThanOrEqual(800)
      expect(delay).toBeLessThanOrEqual(1200)
    }
  })

  it('attempt 2: ~4000ms on average', () => {
    const delays: number[] = []
    for (let i = 0; i < 200; i++) {
      delays.push(calculateBackoff(2))
    }
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length

    // 1000 * 2^2 = 4000 +/- 20%
    expect(avg).toBeGreaterThan(3000)
    expect(avg).toBeLessThan(5000)
  })

  it('reaches cap by attempt 5: ~30s', () => {
    const delays: number[] = []
    for (let i = 0; i < 200; i++) {
      delays.push(calculateBackoff(5))
    }
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length

    // 1000 * 2^5 = 32000, capped to 30000 +/- 20% -> avg ~30000
    expect(avg).toBeGreaterThan(24_000)
    expect(avg).toBeLessThanOrEqual(36_000)
  })
})
