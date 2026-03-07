import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/performance',
  testMatch: ['launch.test.ts', 'memory.test.ts', 'cpu-idle.test.ts'],
  timeout: 120_000,
  retries: 0,
  use: {
    trace: 'off',
  },
})
