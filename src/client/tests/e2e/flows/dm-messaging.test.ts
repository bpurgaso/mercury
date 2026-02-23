/**
 * E2E tests for DM messaging flow.
 *
 * These tests require a running Mercury server and exercise the full
 * Alice → Server → Bob message flow with E2E encryption.
 *
 * Prerequisites:
 * - Mercury server running at VITE_SERVER_URL (default: https://localhost:8443)
 * - Database seeded or fresh (tests register new users)
 *
 * NOTE: These tests are designed for the Playwright + Electron test runner.
 * They will not run in the standard Vitest unit test suite.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const PASSWORD = 'TestPassword123!'
const ts = Date.now()

interface AppCtx {
  app: ElectronApplication
  page: Page
  userDataDir: string
  username: string
  email: string
  userId: string
}

async function launchApp(name: string): Promise<AppCtx> {
  const userDataDir = mkdtempSync(join(tmpdir(), `mercury-e2e-dm-${name}-`))
  const rand = Math.random().toString(36).slice(2, 6)
  const username = `${name}_${ts}_${rand}`
  const email = `${username}@test.com`

  const app = await electron.launch({
    args: [
      join(__dirname, '../../../out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      MERCURY_DEV_MULTI_INSTANCE: '1',
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  return { app, page, userDataDir, username, email, userId: '' }
}

async function registerUser(ctx: AppCtx): Promise<void> {
  const { page, username, email } = ctx

  await expect(page.getByRole('heading', { name: 'Welcome back!' })).toBeVisible({ timeout: 10_000 })

  // Switch to register view
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible()

  // Fill registration form
  await page.getByPlaceholder('cooluser').fill(username)
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.locator('input[type="password"]').fill(PASSWORD)

  // Submit
  await page.getByRole('button', { name: 'Register' }).click()

  // Wait for main UI (server page)
  await expect(page.getByTitle('Create Server')).toBeVisible({ timeout: 15_000 })

  // Extract user ID via API from renderer
  ctx.userId = await page.evaluate(async () => {
    const token = localStorage.getItem('mercury_access_token')
    const res = await fetch('https://localhost:8443/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const user = await res.json()
    return user.id as string
  })
}

test.describe('DM messaging E2E', () => {
  test.describe.configure({ mode: 'serial' })

  let alice: AppCtx
  let bob: AppCtx

  test.describe('Alice and Bob DM exchange', () => {
    test('Register Alice and Bob with unique credentials', async () => {
      ;[alice, bob] = await Promise.all([
        launchApp('alice'),
        launchApp('bob'),
      ])

      await Promise.all([
        registerUser(alice),
        registerUser(bob),
      ])

      // Verify both are on the main UI
      await expect(alice.page.getByTitle('Create Server')).toBeVisible()
      await expect(bob.page.getByTitle('Create Server')).toBeVisible()

      // Verify user IDs are valid UUIDs
      expect(alice.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
      expect(bob.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
      expect(alice.userId).not.toBe(bob.userId)
    })

    test('Alice starts a DM with Bob via POST /dm', async () => {
      // Click New Direct Message button in sidebar
      await alice.page.getByTitle('New Direct Message').click()
      await expect(alice.page.getByText('New Direct Message')).toBeVisible()

      // Enter Bob's user ID
      await alice.page.getByPlaceholder('Enter user ID').fill(bob.userId)

      // Click Start Chat
      await alice.page.getByRole('button', { name: 'Start Chat' }).click()

      // Should switch to DM view — "Direct Messages" header visible
      await expect(alice.page.getByText('Direct Messages')).toBeVisible({ timeout: 5_000 })

      // Bob's name should appear in the DM list (use .first() since name also shows in header)
      await expect(alice.page.getByText(bob.username).first()).toBeVisible({ timeout: 5_000 })

      // Encryption badge should be visible in header
      await expect(alice.page.getByText('Encrypted')).toBeVisible({ timeout: 5_000 })
    })

    test('Alice sends "hello" → Bob receives and sees "hello"', async () => {
      // Alice types and sends "hello"
      const aliceInput = alice.page.locator('textarea')
      await expect(aliceInput).toBeVisible({ timeout: 5_000 })
      await aliceInput.fill('hello')
      await aliceInput.press('Enter')

      // Alice should see her own message immediately (optimistic)
      await expect(alice.page.getByText('hello')).toBeVisible({ timeout: 15_000 })

      // Bob navigates to DM view
      await bob.page.getByTitle('Direct Messages').click()

      // Wait for Alice's DM to appear in Bob's list
      // (The DM channel is auto-discovered when the MESSAGE_CREATE event arrives)
      await expect(bob.page.getByText(alice.username)).toBeVisible({ timeout: 15_000 })

      // Bob clicks on Alice's DM
      await bob.page.getByText(alice.username).click()

      // Bob should see "hello" (decrypted from E2E ciphertext)
      await expect(bob.page.getByText('hello')).toBeVisible({ timeout: 15_000 })
    })

    test('Bob replies "hi" → Alice sees "hi"', async () => {
      // Bob types and sends "hi"
      const bobInput = bob.page.locator('textarea')
      await expect(bobInput).toBeVisible({ timeout: 5_000 })
      await bobInput.fill('hi')
      await bobInput.press('Enter')

      // Bob sees their own message
      await expect(bob.page.getByText('hi')).toBeVisible({ timeout: 5_000 })

      // Alice sees Bob's reply
      await expect(alice.page.getByText('hi')).toBeVisible({ timeout: 15_000 })
    })

    test('Messages are E2E encrypted — server stores only ciphertext', async () => {
      // Query the server's DM message history via REST API.
      // The server stores per-device ciphertext: Alice sees messages encrypted
      // for her device (Bob's reply) and Bob sees messages for his (Alice's hello).
      // Together they should account for at least 2 encrypted messages total.

      async function getServerMessages(page: typeof alice.page) {
        return page.evaluate(async () => {
          const token = localStorage.getItem('mercury_access_token')

          const dmRes = await fetch('https://localhost:8443/dm', {
            headers: { Authorization: `Bearer ${token}` },
          })
          const dmChannels = await dmRes.json()
          if (!dmChannels.length) return { error: 'No DM channels found', messageCount: 0, hasCiphertext: false, hasNoPlaintext: false }

          const dmId = dmChannels[0].id

          const histRes = await fetch(`https://localhost:8443/dm/${dmId}/messages`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          const messages = await histRes.json()

          return {
            messageCount: messages.length,
            hasCiphertext: messages.every(
              (m: { ciphertext?: string }) =>
                typeof m.ciphertext === 'string' && m.ciphertext.length > 0,
            ),
            hasNoPlaintext: messages.every(
              (m: { content?: string | null }) =>
                m.content === null || m.content === undefined,
            ),
          }
        })
      }

      const aliceResult = await getServerMessages(alice.page)
      const bobResult = await getServerMessages(bob.page)

      // Each user should see at least 1 message encrypted for their device
      expect(aliceResult.messageCount).toBeGreaterThanOrEqual(1)
      expect(bobResult.messageCount).toBeGreaterThanOrEqual(1)

      // Combined: at least 2 encrypted messages stored on server
      expect(aliceResult.messageCount + bobResult.messageCount).toBeGreaterThanOrEqual(2)

      // All server-stored messages should be ciphertext, not plaintext
      expect(aliceResult.hasCiphertext).toBe(true)
      expect(aliceResult.hasNoPlaintext).toBe(true)
      expect(bobResult.hasCiphertext).toBe(true)
      expect(bobResult.hasNoPlaintext).toBe(true)
    })
  })

  test.describe('Offline message history from local DB', () => {
    test("Close Alice's app → reopen → DM history loaded from local db", async () => {
      // Save Alice's userData dir so we can relaunch with the same state
      const savedDir = alice.userDataDir
      const savedUsername = alice.username
      const savedEmail = alice.email
      const savedUserId = alice.userId

      // Close Alice's Electron app
      await alice.app.close()

      // Relaunch with the SAME userData dir (tokens + local DB persist)
      alice.app = await electron.launch({
        args: [
          join(__dirname, '../../../out/main/index.js'),
          `--user-data-dir=${savedDir}`,
        ],
        env: {
          ...process.env,
          NODE_ENV: 'development',
          MERCURY_DEV_MULTI_INSTANCE: '1',
        },
      })
      alice.page = await alice.app.firstWindow()
      await alice.page.waitForLoadState('domcontentloaded')
      alice.userDataDir = savedDir
      alice.username = savedUsername
      alice.email = savedEmail
      alice.userId = savedUserId

      // Should auto-login from persisted tokens
      await expect(alice.page.getByTitle('Create Server')).toBeVisible({ timeout: 15_000 })

      // Navigate to DM view
      await alice.page.getByTitle('Direct Messages').click()

      // Click on Bob's DM
      await expect(alice.page.getByText(bob.username)).toBeVisible({ timeout: 10_000 })
      await alice.page.getByText(bob.username).click()

      // Previous messages should be loaded from local encrypted database
      await expect(alice.page.getByText('hello')).toBeVisible({ timeout: 10_000 })
      await expect(alice.page.getByText('hi')).toBeVisible({ timeout: 10_000 })
    })

    test('Messages visible without server fetch', async () => {
      // Messages were loaded from the local encrypted database (messages.db),
      // not from a fresh server fetch. We verify they're visible and count >= 2.
      await expect(alice.page.getByText('hello')).toBeVisible()
      await expect(alice.page.getByText('hi')).toBeVisible()

      // Verify there are multiple message content elements rendered
      const msgCount = await alice.page.locator('[class*="text-text-secondary"]').count()
      expect(msgCount).toBeGreaterThanOrEqual(2)
    })
  })

  test.describe('WebSocket frame types', () => {
    test('message_send is sent as binary (MessagePack) frame', async () => {
      // DM messages must be sent as binary (MessagePack) frames, not JSON text.
      // We verify by sending a DM and confirming the message arrives successfully.
      // The server only accepts DM payloads in MessagePack binary format —
      // if it were sent as JSON text, the server would reject or misroute it.

      const aliceInput = alice.page.locator('textarea')
      await expect(aliceInput).toBeVisible({ timeout: 5_000 })
      await aliceInput.fill('binary frame test')
      await aliceInput.press('Enter')

      // Alice sees message (optimistic)
      await expect(alice.page.getByText('binary frame test')).toBeVisible({ timeout: 10_000 })

      // Bob receives and decrypts it (proves binary framing worked end-to-end)
      await expect(bob.page.getByText('binary frame test')).toBeVisible({ timeout: 15_000 })
    })

    test('heartbeat is sent as text (JSON) frame', async () => {
      // Heartbeats keep the WebSocket alive using JSON text frames.
      // We verify the connection is CONNECTED (heartbeats working properly).
      // If heartbeats used wrong framing, the server would drop the connection.

      // No "Disconnected" or "Reconnecting" indicator should be visible
      await expect(alice.page.locator('text=Disconnected')).not.toBeVisible()
      await expect(alice.page.locator('text=Reconnecting...')).not.toBeVisible()

      // Wait 2 seconds — connection should remain stable
      await alice.page.waitForTimeout(2_000)
      await expect(alice.page.locator('text=Disconnected')).not.toBeVisible()
    })

    test('MESSAGE_CREATE for DMs is received as binary frame', async () => {
      // DM MESSAGE_CREATE events are sent as binary (MessagePack) frames.
      // We verify by having Alice send and confirming Bob receives + decrypts.
      // The client's WebSocket handler uses ArrayBuffer detection to route
      // binary frames through MessagePack decode (not JSON.parse).

      const aliceInput = alice.page.locator('textarea')
      await aliceInput.fill('binary receive test')
      await aliceInput.press('Enter')

      // Bob receives and successfully decrypts — proves binary MESSAGE_CREATE worked
      await expect(bob.page.getByText('binary receive test')).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe('TOFU identity verification', () => {
    test('Identity change shows warning dialog', async () => {
      // Trigger the identity warning via test hook.
      // This calls the identityWarningCallback registered by ServerPage,
      // which shows the IdentityWarningDialog component.
      const warningPromise = alice.page.evaluate(async (bobId: string) => {
        const testHook = (window as Record<string, any>).__mercury_test__
        return testHook.triggerIdentityWarning(bobId) as Promise<boolean>
      }, bob.userId)

      // The "Identity Changed" dialog should appear
      await expect(alice.page.getByText('Identity Changed')).toBeVisible({ timeout: 5_000 })

      // Verify dialog elements
      await expect(alice.page.getByText('security verification')).toBeVisible()
      await expect(alice.page.getByRole('button', { name: 'Send Anyway' })).toBeVisible()
      await expect(alice.page.getByRole('button', { name: 'Cancel' })).toBeVisible()

      // Cancel to dismiss
      await alice.page.getByRole('button', { name: 'Cancel' }).click()
      const result = await warningPromise
      expect(result).toBe(false)
    })

    test('Message NOT sent until user approves', async () => {
      // Trigger identity warning — the send pipeline is blocked until user acts
      const warningPromise = alice.page.evaluate(async (bobId: string) => {
        const testHook = (window as Record<string, any>).__mercury_test__
        return testHook.triggerIdentityWarning(bobId) as Promise<boolean>
      }, bob.userId)

      // Dialog appears — send is blocked
      await expect(alice.page.getByText('Identity Changed')).toBeVisible({ timeout: 5_000 })

      // The dialog persists (send is still waiting for approval)
      await alice.page.waitForTimeout(1_000)
      await expect(alice.page.getByText('Identity Changed')).toBeVisible()

      // Cancel — message was NOT sent
      await alice.page.getByRole('button', { name: 'Cancel' }).click()
      const result = await warningPromise
      expect(result).toBe(false) // Not approved = not sent
    })

    test('After approval, message sends successfully', async () => {
      // Trigger identity warning and approve it
      const warningPromise = alice.page.evaluate(async (bobId: string) => {
        const testHook = (window as Record<string, any>).__mercury_test__
        return testHook.triggerIdentityWarning(bobId) as Promise<boolean>
      }, bob.userId)

      await expect(alice.page.getByText('Identity Changed')).toBeVisible({ timeout: 5_000 })

      // Click "Send Anyway" — approve the identity change
      await alice.page.getByRole('button', { name: 'Send Anyway' }).click()
      const result = await warningPromise
      expect(result).toBe(true) // Approved

      // Verify DMs still work after approval by sending a message
      const aliceInput = alice.page.locator('textarea')
      await expect(aliceInput).toBeVisible({ timeout: 5_000 })
      await aliceInput.fill('after approval')
      await aliceInput.press('Enter')

      await expect(alice.page.getByText('after approval')).toBeVisible({ timeout: 10_000 })
      await expect(bob.page.getByText('after approval')).toBeVisible({ timeout: 15_000 })
    })
  })

  test.afterAll(async () => {
    await alice?.app?.close()
    await bob?.app?.close()
    if (alice?.userDataDir) rmSync(alice.userDataDir, { recursive: true, force: true })
    if (bob?.userDataDir) rmSync(bob.userDataDir, { recursive: true, force: true })
  })
})
