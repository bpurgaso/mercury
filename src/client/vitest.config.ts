import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@main': resolve(__dirname, 'src/main'),
      '@worker': resolve(__dirname, 'src/worker'),
      '@shared': resolve(__dirname, 'src/shared'),
      // Force CJS version — the ESM build has a broken sibling import
      // of libsodium.mjs that fails under pnpm's strict node_modules layout.
      'libsodium-wrappers': resolve(
        __dirname,
        'node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js',
      ),
    },
  },
})
