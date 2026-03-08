// TESTSPEC: PERF-006
// Bundle size benchmark — ensures the Electron app stays under 200 MB unpacked.
//
// This test measures the size of the built output directory.
// Run after building: pnpm build && pnpm test

import { describe, it, expect } from 'vitest'
import { statSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

function getDirSize(dirPath: string): number {
  let total = 0
  const entries = readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += getDirSize(fullPath)
    } else {
      total += statSync(fullPath).size
    }
  }
  return total
}

const MB = 1024 * 1024
const MAX_BUNDLE_SIZE_MB = 200

describe('Bundle size', () => {
  it(`unpacked build is under ${MAX_BUNDLE_SIZE_MB} MB`, () => {
    const outDir = join(__dirname, '../../out')

    if (!existsSync(outDir)) {
      console.warn('Build output not found at', outDir, '— skipping bundle size check.')
      console.warn('Run "pnpm build" first to generate the output.')
      return
    }

    const totalBytes = getDirSize(outDir)
    const totalMB = totalBytes / MB

    console.log('\n=== Bundle Size ===')
    console.log(`  Output directory: ${outDir}`)
    console.log(`  Total size: ${totalMB.toFixed(2)} MB`)
    console.log(`  Target: < ${MAX_BUNDLE_SIZE_MB} MB`)
    console.log(`  Status: ${totalMB < MAX_BUNDLE_SIZE_MB ? 'PASS' : 'FAIL'}`)

    expect(totalMB).toBeLessThan(MAX_BUNDLE_SIZE_MB)
  })
})
