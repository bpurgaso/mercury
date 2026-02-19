import { describe, it, expect } from 'vitest'
import { calculateBackoff } from '../../../src/renderer/services/websocket'

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
