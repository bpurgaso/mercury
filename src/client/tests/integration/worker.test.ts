import { describe, it, expect } from 'vitest'
import { Worker } from 'worker_threads'
import { join } from 'path'

describe('Crypto Worker Thread MessagePort', () => {
  it('sends ping via parentPort and receives pong (simulates Main↔Worker bridge)', async () => {
    const workerPath = join(__dirname, '../../out/main/workers/crypto-worker.js')
    const worker = new Worker(workerPath)

    // Tell worker it's ready (mirrors what Main does)
    worker.postMessage({ op: 'init:ready' })

    // Send a ping and expect a pong back on parentPort (Main bridges this to renderer)
    const pong = await new Promise<{ op: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for pong')), 5000)

      worker.on('message', (msg) => {
        if (msg.op === 'pong') {
          clearTimeout(timeout)
          resolve(msg)
        }
      })

      worker.postMessage({ op: 'ping', data: 'test-payload' })
    })

    expect(pong.op).toBe('pong')
    expect(pong.data).toBe('test-payload')

    // Cleanup
    worker.postMessage({ op: 'shutdown' })
    await new Promise<void>((resolve) => {
      worker.on('exit', () => resolve())
    })
  })

  it('worker handles shutdown gracefully', async () => {
    const workerPath = join(__dirname, '../../out/main/workers/crypto-worker.js')
    const worker = new Worker(workerPath)

    worker.postMessage({ op: 'shutdown' })

    const exitCode = await new Promise<number>((resolve) => {
      worker.on('exit', (code) => resolve(code))
    })

    expect(exitCode).toBe(0)
  })
})
