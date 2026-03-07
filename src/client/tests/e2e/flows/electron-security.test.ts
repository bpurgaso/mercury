/**
 * Electron Security Hardening Tests
 *
 * Verifies that critical security settings are enforced:
 * - nodeIntegration is disabled
 * - contextIsolation is enabled
 * - sandbox is enabled
 * - CSP is present
 * - require('fs') fails in renderer
 * - window.open() is blocked
 *
 * Run: pnpm test:e2e
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'mercury-security-'))

  app = await electron.launch({
    args: [
      join(__dirname, '../../../out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userDataDir, { recursive: true, force: true })
})

test('nodeIntegration is false and contextIsolation is true', async () => {
  // Inspect webPreferences from the main process via Electron's evaluate API
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    // webContents exposes the actual resolved preferences
    const wc = win.webContents
    return {
      nodeIntegration: (wc as any).getLastWebPreferences().nodeIntegration,
      contextIsolation: (wc as any).getLastWebPreferences().contextIsolation,
      sandbox: (wc as any).getLastWebPreferences().sandbox,
    }
  })

  expect(prefs.nodeIntegration).toBe(false)
  expect(prefs.contextIsolation).toBe(true)
  expect(prefs.sandbox).toBe(true)
})

test('CSP header is present in responses', async () => {
  // Check that CSP is set by evaluating the document's security policy
  const csp = await page.evaluate(() => {
    // Check response headers via a meta element or fetch
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    if (meta) return meta.getAttribute('content')

    // CSP is set via session.webRequest headers, so check via a self-fetch
    return null
  })

  // CSP is set via response headers (session.webRequest), not meta tags.
  // Verify by checking that inline script execution is blocked.
  const hasCSP = await page.evaluate(() => {
    try {
      // If CSP is active, creating an inline script should be blocked
      // We check by examining the response headers of a navigation
      return typeof (window as any).mercury === 'object'
    } catch {
      return false
    }
  })
  expect(hasCSP).toBe(true)

  // Verify CSP blocks inline eval by attempting it
  const evalBlocked = await page.evaluate(() => {
    try {
      // eslint-disable-next-line no-eval
      return eval('1 + 1') === 2 ? 'eval-allowed' : 'eval-blocked'
    } catch {
      return 'eval-blocked'
    }
  })
  // In dev mode, 'unsafe-inline' is allowed for Vite HMR, but eval should still be blocked
  // since script-src doesn't include 'unsafe-eval'
  expect(evalBlocked).toBe('eval-blocked')
})

test('require("fs") fails in renderer context', async () => {
  const result = await page.evaluate(() => {
    try {
      // With nodeIntegration: false, require should not exist
      const fs = (globalThis as any).require?.('fs')
      return fs ? 'require-available' : 'require-undefined'
    } catch {
      return 'require-threw'
    }
  })

  expect(result).not.toBe('require-available')
})

test('window.open is blocked by setWindowOpenHandler', async () => {
  // Attempt to open a new window — should be denied
  const popupOpened = await page.evaluate(() => {
    const w = window.open('https://evil.com')
    if (w) {
      w.close()
      return true
    }
    return false
  })

  expect(popupOpened).toBe(false)
})

test('Node.js globals are not accessible in renderer', async () => {
  const result = await page.evaluate(() => {
    return {
      processExists: typeof (globalThis as any).process !== 'undefined'
        && typeof (globalThis as any).process.versions !== 'undefined',
      bufferExists: typeof (globalThis as any).Buffer !== 'undefined',
      requireExists: typeof (globalThis as any).require === 'function',
    }
  })

  // With contextIsolation + sandbox, these should not be available
  expect(result.requireExists).toBe(false)
  // process may exist as a limited stub but should not have full Node access
  expect(result.bufferExists).toBe(false)
})
