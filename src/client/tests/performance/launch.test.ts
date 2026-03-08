// App launch performance benchmark.
// Measures time from Electron launch to login screen visible.
// Target: < 3 seconds.
//
// Run with: pnpm run bench:launch
// Requires: electron-vite build to have been run first.

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const LAUNCH_TARGET_MS = 3000
const RUNS = 3

// TESTSPEC: PERF-004
test('app launch to login screen < 3 seconds', async () => {
  const times: number[] = []

  for (let i = 0; i < RUNS; i++) {
    const userDataDir = mkdtempSync(join(tmpdir(), 'mercury-bench-launch-'))

    const startTime = performance.now()

    const app = await electron.launch({
      args: [
        join(__dirname, '../../out/main/index.js'),
        `--user-data-dir=${userDataDir}`,
      ],
      env: {
        ...process.env,
        NODE_ENV: 'development',
      },
    })

    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Wait for the login screen heading to be visible (first meaningful paint)
    await page.getByRole('heading', { name: 'Welcome back!' }).waitFor({
      state: 'visible',
      timeout: 10000,
    })

    const elapsed = performance.now() - startTime
    times.push(elapsed)

    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }

  const sorted = [...times].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  console.log('\n=== App Launch Benchmark ===')
  for (let i = 0; i < times.length; i++) {
    console.log(`  Run ${i + 1}: ${times[i].toFixed(0)}ms`)
  }
  console.log(`  Median: ${median.toFixed(0)}ms`)
  console.log(`  Target: < ${LAUNCH_TARGET_MS}ms`)
  console.log(`  [${median <= LAUNCH_TARGET_MS ? 'PASS' : 'FAIL'}]`)

  expect(median).toBeLessThan(LAUNCH_TARGET_MS)
})
