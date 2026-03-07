// CPU idle benchmark.
// Measures average CPU usage over 30 seconds with no active call.
// Target: < 5% average CPU.
//
// Run with: pnpm run bench:cpu
// Requires: electron-vite build to have been run first.

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const CPU_TARGET_PERCENT = 5
const SAMPLE_DURATION_MS = 30_000
const SAMPLE_INTERVAL_MS = 1000

test('CPU idle usage < 5% over 30 seconds', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mercury-bench-cpu-'))

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

  // Wait for the UI to settle before measuring
  await page.getByRole('heading', { name: 'Welcome back!' }).waitFor({
    state: 'visible',
    timeout: 10000,
  })
  // Let startup activity die down
  await page.waitForTimeout(5000)

  // Sample CPU usage over 30 seconds using Electron's app.getAppMetrics()
  const samples = Math.floor(SAMPLE_DURATION_MS / SAMPLE_INTERVAL_MS)
  const cpuReadings: number[] = []

  for (let i = 0; i < samples; i++) {
    const metrics = await app.evaluate(({ app: electronApp }) => {
      const appMetrics = electronApp.getAppMetrics()
      // Sum CPU percentage across all processes
      const totalCpu = appMetrics.reduce(
        (sum, proc) => sum + proc.cpu.percentCPUUsage,
        0,
      )
      return totalCpu
    })
    cpuReadings.push(metrics)
    await page.waitForTimeout(SAMPLE_INTERVAL_MS)
  }

  const avgCpu = cpuReadings.reduce((a, b) => a + b, 0) / cpuReadings.length
  const maxCpu = Math.max(...cpuReadings)
  const minCpu = Math.min(...cpuReadings)

  console.log('\n=== CPU Idle Benchmark (30 seconds) ===')
  console.log(`  Average CPU: ${avgCpu.toFixed(2)}%`)
  console.log(`  Min CPU: ${minCpu.toFixed(2)}%`)
  console.log(`  Max CPU: ${maxCpu.toFixed(2)}%`)
  console.log(`  Samples: ${cpuReadings.length}`)
  console.log(`  Target: < ${CPU_TARGET_PERCENT}%`)
  console.log(`  [${avgCpu <= CPU_TARGET_PERCENT ? 'PASS' : 'FAIL'}]`)

  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })

  expect(avgCpu).toBeLessThan(CPU_TARGET_PERCENT)
}, 120_000) // 2 minute timeout for the 30s sampling + startup
