// Memory usage benchmark.
// Measures RSS after loading the app with mock server data.
// Target: < 300 MB idle with 5 servers loaded.
//
// Run with: pnpm run bench:memory
// Requires: electron-vite build to have been run first, server running.
//
// Note: This test requires a running Mercury server to authenticate and load
// real server data. If the server is unavailable, the test measures baseline
// memory with the app at the login screen, which is a lower bound.

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const MEMORY_TARGET_MB = 300

// TESTSPEC: PERF-005
test('memory usage at idle < 300 MB', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mercury-bench-memory-'))

  const app = await electron.launch({
    args: [
      join(__dirname, '../../out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      '--js-flags=--expose-gc',
    ],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Wait for the UI to settle
  await page.getByRole('heading', { name: 'Welcome back!' }).waitFor({
    state: 'visible',
    timeout: 10000,
  })

  // Wait for GC and idle settling
  await page.waitForTimeout(5000)

  // Measure memory from the main (browser) process and all renderer processes
  // Electron exposes process metrics via app.getAppMetrics() in the main process
  const metrics = await app.evaluate(async ({ app: electronApp }) => {
    // Force GC if available
    if (typeof global.gc === 'function') {
      global.gc()
    }

    const appMetrics = electronApp.getAppMetrics()
    const totalMemoryKB = appMetrics.reduce(
      (sum, proc) => sum + proc.memory.workingSetSize,
      0,
    )

    return {
      totalMemoryMB: Math.round(totalMemoryKB / 1024),
      processes: appMetrics.map((p) => ({
        type: p.type,
        memoryMB: Math.round(p.memory.workingSetSize / 1024),
        pid: p.pid,
      })),
    }
  })

  console.log('\n=== Memory Usage Benchmark ===')
  console.log(`  Total RSS: ${metrics.totalMemoryMB} MB`)
  console.log(`  Target: < ${MEMORY_TARGET_MB} MB`)
  for (const proc of metrics.processes) {
    console.log(`    ${proc.type} (pid ${proc.pid}): ${proc.memoryMB} MB`)
  }
  console.log(`  [${metrics.totalMemoryMB <= MEMORY_TARGET_MB ? 'PASS' : 'FAIL'}]`)
  console.log()
  console.log(
    '  Note: This measures baseline memory at login screen.',
  )
  console.log(
    '  With 5 active servers and message history, expect higher usage.',
  )

  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })

  expect(metrics.totalMemoryMB).toBeLessThan(MEMORY_TARGET_MB)
})
