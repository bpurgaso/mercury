/**
 * E2E Smoke Test — Playwright + Electron
 *
 * Prerequisites: the Mercury server must be running at https://localhost:8443
 * and the database must be clean (or at least the test user must not exist).
 *
 * Run: pnpm test:e2e
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

let app: ElectronApplication
let page: Page
let userDataDir: string

const TEST_USER = {
  username: `smoketest_${Date.now()}`,
  email: `smoketest_${Date.now()}@test.com`,
  password: 'TestPassword123!',
}

test.beforeAll(async () => {
  // Use a fresh temp directory for Electron userData to avoid state leakage
  // between test runs (persisted auth tokens, databases, etc.)
  userDataDir = mkdtempSync(join(tmpdir(), 'mercury-e2e-'))

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
  // Wait for the renderer to be ready
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  // Clean up the temp userData directory
  rmSync(userDataDir, { recursive: true, force: true })
})

test('launch app shows login screen', async () => {
  // Should show the login page by default
  await expect(page.getByRole('heading', { name: 'Welcome back!' })).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('button', { name: 'Log In' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Register' })).toBeVisible()
})

test('register new account and land on main UI', async () => {
  // Switch to register form
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible()

  // Fill registration form
  await page.getByPlaceholder('cooluser').fill(TEST_USER.username)
  await page.getByPlaceholder('you@example.com').fill(TEST_USER.email)
  await page.locator('input[type="password"]').fill(TEST_USER.password)

  // Submit
  await page.getByRole('button', { name: 'Register' }).click()

  // Should land on the main UI (server page)
  // The main UI has the sidebar with + button for creating servers
  await expect(page.getByTitle('Create Server')).toBeVisible({ timeout: 10000 })
})

test('create server and it appears in sidebar', async () => {
  // Click the + button to create a server
  await page.getByTitle('Create Server').click()

  // Fill in server name
  await expect(page.getByRole('heading', { name: 'Create a Server' })).toBeVisible()
  await page.getByPlaceholder('My Awesome Server').fill('Test Server')

  // Create
  await page.getByRole('button', { name: 'Create' }).click()

  // Server should appear in the sidebar (as initials "TS")
  await expect(page.getByTitle('Test Server')).toBeVisible({ timeout: 5000 })
})

test('create channel and it appears in channel list', async () => {
  // Click the + button next to "Text Channels" to create a channel
  await page.getByTitle('Create Channel').click()

  // Verify modal heading is visible
  await expect(page.getByRole('heading', { name: 'Create Channel' })).toBeVisible()
  await page.getByPlaceholder('general').fill('test-channel')

  // Submit via the button (community channel by default)
  await page.getByRole('button', { name: 'Create Channel' }).click()

  // Channel should appear in the channel list (a button with "# test-channel")
  await expect(page.getByRole('button', { name: /test-channel/ })).toBeVisible({ timeout: 5000 })
})

test('type and send message, it appears in chat', async () => {
  // Click on the channel in the channel list to select it
  await page.getByRole('button', { name: /test-channel/ }).click()

  // Type a message
  const messageInput = page.getByPlaceholder(/Message #test-channel/)
  await expect(messageInput).toBeVisible({ timeout: 5000 })
  await messageInput.fill('Hello Mercury!')

  // Send with Enter
  await messageInput.press('Enter')

  // Message should appear in the chat area
  await expect(page.getByText('Hello Mercury!')).toBeVisible({ timeout: 5000 })
})
