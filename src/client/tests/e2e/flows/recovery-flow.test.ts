/**
 * E2E tests for the recovery key lifecycle.
 *
 * Validates: generate recovery key → create encrypted backup → upload to server →
 * simulate device loss → download backup → restore identity → verify messaging works.
 *
 * Prerequisites:
 * - Mercury server running at https://localhost:8443
 * - Database seeded or fresh (tests register new users)
 *
 * NOTE: Designed for the Playwright + Electron test runner.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const SERVER = 'https://localhost:8443'
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
  const userDataDir = mkdtempSync(join(tmpdir(), `mercury-e2e-recovery-${name}-`))
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

  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible()

  await page.getByPlaceholder('cooluser').fill(username)
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.locator('input[type="password"]').fill(PASSWORD)

  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByTitle('Create Server')).toBeVisible({ timeout: 15_000 })

  ctx.userId = await page.evaluate(async () => {
    const token = localStorage.getItem('mercury_access_token')
    const res = await fetch('https://localhost:8443/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const user = await res.json()
    return user.id as string
  })
}

/** Helper: call the crypto service from the renderer context. */
async function cryptoOp<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ method, args }) => {
      // Access the crypto service via the window.__mercury_test_crypto__ hook
      // which we expose below, or fall back to direct postMessage.
      const svc = (window as any).__mercury_crypto_service__
      if (!svc || !svc[method]) throw new Error(`crypto method not found: ${method}`)
      return svc[method](...args)
    },
    { method, args },
  )
}

/** Expose cryptoService on window for test access. */
async function exposeCryptoService(page: Page): Promise<void> {
  await page.evaluate(() => {
    // The cryptoService is imported into the renderer bundle — access it from the module scope.
    // It's available as a global import in the renderer entry.
    const mod = (window as any).__mercury_modules__
    if (mod?.cryptoService) {
      ;(window as any).__mercury_crypto_service__ = mod.cryptoService
    }
  })

  // Verify the crypto service is available
  const available = await page.evaluate(() => !!(window as any).__mercury_crypto_service__)
  if (!available) {
    // Fallback: create a test-specific crypto proxy that piggybacks on
    // the existing preload message bridge without replacing the renderer's handler.
    await page.evaluate(() => {
      let counter = 0
      const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()

      // Intercept messages by wrapping the preload's onMessage.
      // The preload stores a single messageHandler; we chain ours before it.
      const origSend = window.mercury.crypto.send.bind(window.mercury.crypto)
      const origOnMessage = window.mercury.crypto.onMessage.bind(window.mercury.crypto)
      let existingHandler: ((data: unknown) => void) | null = null

      // Capture the existing handler by re-registering it through our wrapper
      origOnMessage((data: any) => {
        // Route test-prefixed IDs to our pending map
        if (data?.id?.startsWith('test-')) {
          const p = pending.get(data.id)
          if (p) {
            pending.delete(data.id)
            if (data.op === 'crypto:error') p.reject(new Error(data.error))
            else p.resolve(data.data)
            return
          }
        }
        // Forward to the existing renderer handler
        existingHandler?.(data)
      })

      // Save existing handler — the renderer's initCryptoPort already registered one
      // We replaced it above, but the renderer's pending ops still exist in the
      // closure. We need to re-register the renderer's handler. However, since
      // initCryptoPort already ran and set up pendingOps, we can't recover it.
      // For test-only contexts (login via API, not UI), there's no renderer handler.

      function postOp<T>(op: string, data?: Record<string, unknown>): Promise<T> {
        return new Promise((resolve, reject) => {
          const id = `test-${++counter}`
          pending.set(id, { resolve: resolve as any, reject })
          origSend({ op, id, data })
        })
      }

      ;(window as any).__mercury_crypto_service__ = {
        generateRecoveryKey: () => postOp('crypto:generateRecoveryKey'),
        createBackup: (recoveryKey: number[]) =>
          postOp('crypto:createBackup', { recoveryKey }),
        restoreFromBackup: (params: any) =>
          postOp('crypto:restoreFromBackup', params),
        decodeMnemonic: (mnemonic: string[]) =>
          postOp('crypto:decodeMnemonic', { mnemonic }),
        getMasterVerifyKey: () => postOp('crypto:getMasterVerifyKey'),
        recoverDevice: (params: any) => postOp('crypto:recoverDevice', params),
        getPublicKeys: () => postOp('crypto:getPublicKeys'),
      }
    })
  }
}

test.describe('Recovery flow E2E', () => {
  test.describe.configure({ mode: 'serial' })

  let alice: AppCtx
  let bob: AppCtx
  let aliceMnemonic: string[]
  let aliceRecoveryKey: number[]
  let aliceMasterVerifyKey: number[]

  test.describe('Full recovery lifecycle', () => {
    test('Register Alice and Bob', async () => {
      ;[alice, bob] = await Promise.all([launchApp('alice'), launchApp('bob')])
      await Promise.all([registerUser(alice), registerUser(bob)])

      expect(alice.userId).toMatch(/^[0-9a-f]{8}-/)
      expect(bob.userId).toMatch(/^[0-9a-f]{8}-/)
    })

    test('Alice and Bob exchange DMs to establish E2E sessions', async () => {
      // Alice starts DM with Bob
      await alice.page.getByTitle('New Direct Message').click()
      await expect(alice.page.getByText('New Direct Message')).toBeVisible()
      await alice.page.getByPlaceholder('Enter user ID').fill(bob.userId)
      await alice.page.getByRole('button', { name: 'Start Chat' }).click()
      await expect(alice.page.getByText('Encrypted')).toBeVisible({ timeout: 5_000 })

      // Alice sends a message
      const aliceInput = alice.page.locator('textarea')
      await expect(aliceInput).toBeVisible({ timeout: 5_000 })
      await aliceInput.fill('pre-recovery message')
      await aliceInput.press('Enter')
      await expect(alice.page.getByText('pre-recovery message')).toBeVisible({ timeout: 15_000 })

      // Bob receives it
      await bob.page.getByTitle('Direct Messages').click()
      await expect(bob.page.getByText(alice.username)).toBeVisible({ timeout: 15_000 })
      await bob.page.getByText(alice.username).click()
      await expect(bob.page.getByText('pre-recovery message')).toBeVisible({ timeout: 15_000 })

      // Bob replies
      const bobInput = bob.page.locator('textarea')
      await expect(bobInput).toBeVisible({ timeout: 5_000 })
      await bobInput.fill('got it')
      await bobInput.press('Enter')
      await expect(alice.page.getByText('got it')).toBeVisible({ timeout: 15_000 })
    })

    // TESTSPEC: E2E-037
    test('Generate recovery key and create encrypted backup', async () => {
      await exposeCryptoService(alice.page)

      // Generate recovery key (BIP-39 mnemonic)
      const keyResult = await cryptoOp<{ recoveryKey: number[]; mnemonic: string[] }>(
        alice.page,
        'generateRecoveryKey',
      )
      aliceMnemonic = keyResult.mnemonic
      aliceRecoveryKey = keyResult.recoveryKey

      expect(aliceMnemonic).toHaveLength(24)
      expect(aliceRecoveryKey).toHaveLength(32)

      // Save Alice's master verify key before backup
      const mkResult = await cryptoOp<{ masterVerifyKey: number[] }>(
        alice.page,
        'getMasterVerifyKey',
      )
      aliceMasterVerifyKey = mkResult.masterVerifyKey
      expect(aliceMasterVerifyKey.length).toBe(32)
    })

    // TESTSPEC: E2E-038
    test('Create and upload encrypted backup to server', async () => {
      // Create backup blob
      const backup = await cryptoOp<{ encrypted_backup: number[]; salt: number[] }>(
        alice.page,
        'createBackup',
        aliceRecoveryKey,
      )
      expect(backup.encrypted_backup.length).toBeGreaterThan(0)
      expect(backup.salt).toHaveLength(32)

      // Upload to server via PUT /users/me/key-backup
      const uploadResult = await alice.page.evaluate(
        async ({ backup, server }) => {
          const token = localStorage.getItem('mercury_access_token')
          // Convert number[] to base64
          function toBase64(arr: number[]): string {
            const bytes = new Uint8Array(arr)
            let binary = ''
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
            return btoa(binary)
          }
          const res = await fetch(`${server}/users/me/key-backup`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              encrypted_backup: toBase64(backup.encrypted_backup),
              key_derivation_salt: toBase64(backup.salt),
            }),
          })
          return { status: res.status }
        },
        { backup, server: SERVER },
      )
      expect(uploadResult.status).toBe(204)

      // Verify backup exists on server
      const downloadCheck = await alice.page.evaluate(async (server) => {
        const token = localStorage.getItem('mercury_access_token')
        const res = await fetch(`${server}/users/me/key-backup`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        return { status: res.status }
      }, SERVER)
      expect(downloadCheck.status).toBe(200)
    })

    test('Simulate device loss — destroy local data', async () => {
      const savedDir = alice.userDataDir
      await alice.app.close()

      // Delete all local data (simulates lost device)
      rmSync(savedDir, { recursive: true, force: true })
    })

    // TESTSPEC: E2E-039
    test('Restore: login on new device and recover from backup', async () => {
      // Relaunch with fresh userData directory
      const newUserDataDir = mkdtempSync(join(tmpdir(), 'mercury-e2e-recovery-alice-restored-'))
      alice.userDataDir = newUserDataDir

      alice.app = await electron.launch({
        args: [
          join(__dirname, '../../../out/main/index.js'),
          `--user-data-dir=${newUserDataDir}`,
        ],
        env: {
          ...process.env,
          NODE_ENV: 'development',
          MERCURY_DEV_MULTI_INSTANCE: '1',
        },
      })
      alice.page = await alice.app.firstWindow()
      await alice.page.waitForLoadState('domcontentloaded')

      // Should see login page (no persisted tokens)
      await expect(alice.page.getByRole('heading', { name: 'Welcome back!' })).toBeVisible({ timeout: 10_000 })

      // Login via API (not UI) to avoid initializeDevice generating new master key
      // which would conflict with the existing TOFU record on server.
      const loginResult = await alice.page.evaluate(
        async ({ email, password, server }) => {
          const res = await fetch(`${server}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          })
          if (!res.ok) return { error: `Login failed: ${res.status}` }
          const data = await res.json()
          localStorage.setItem('mercury_access_token', data.access_token)
          localStorage.setItem('mercury_refresh_token', data.refresh_token)
          return { access_token: data.access_token }
        },
        { email: alice.email, password: PASSWORD, server: SERVER },
      )
      expect(loginResult.error).toBeUndefined()

      // Register a new device on the server
      const deviceResult = await alice.page.evaluate(async (server) => {
        const token = localStorage.getItem('mercury_access_token')
        const res = await fetch(`${server}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ device_name: 'Mercury Desktop (Recovered)' }),
        })
        if (!res.ok) return { error: `Device registration failed: ${res.status}` }
        const data = await res.json()
        localStorage.setItem('mercury_device_id', data.device_id)
        return { device_id: data.device_id }
      }, SERVER)
      expect(deviceResult.error).toBeUndefined()
      expect(deviceResult.device_id).toBeTruthy()

      // Download the encrypted backup from server
      const backupData = await alice.page.evaluate(async (server) => {
        const token = localStorage.getItem('mercury_access_token')
        const res = await fetch(`${server}/users/me/key-backup`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return { error: `Backup download failed: ${res.status}` }
        const data = await res.json()
        // Decode base64 to number arrays
        function fromBase64(b64: string): number[] {
          const binary = atob(b64)
          const arr: number[] = []
          for (let i = 0; i < binary.length; i++) arr.push(binary.charCodeAt(i))
          return arr
        }
        return {
          encrypted_backup: fromBase64(data.encrypted_backup),
          salt: fromBase64(data.key_derivation_salt),
          backup_version: data.backup_version,
        }
      }, SERVER)
      expect(backupData.error).toBeUndefined()
      expect(backupData.backup_version).toBeGreaterThanOrEqual(1)

      // Wait for the crypto worker to be ready before sending operations
      await alice.page.evaluate(() => {
        return new Promise<void>((resolve) => {
          window.mercury.crypto.onReady(() => resolve())
        })
      })

      // Expose crypto service for test operations
      await exposeCryptoService(alice.page)

      // Decode the saved mnemonic to get recovery key
      const decoded = await cryptoOp<{ recoveryKey: number[] }>(
        alice.page,
        'decodeMnemonic',
        aliceMnemonic,
      )
      expect(decoded.recoveryKey).toHaveLength(32)

      // Recover device: restore backup + generate new device keys
      const recoveryResult = await cryptoOp<{
        masterVerifyPublicKey: number[]
        deviceId: string
        deviceIdentityEd25519PublicKey: number[]
        deviceIdentityPublicKey: number[]
        signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
        oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
        signedDeviceList: { signedList: number[]; signature: number[]; masterVerifyKey: number[] }
      }>(alice.page, 'recoverDevice', {
        recoveryKey: decoded.recoveryKey,
        encrypted_backup: backupData.encrypted_backup,
        salt: backupData.salt,
        deviceId: deviceResult.device_id,
      })

      // Verify master verify key is the SAME as before device loss
      expect(recoveryResult.masterVerifyPublicKey).toEqual(aliceMasterVerifyKey)
      expect(recoveryResult.deviceId).toBe(deviceResult.device_id)

      // Upload key bundle for the new device
      const keyBundleResult = await alice.page.evaluate(
        async ({ server, deviceId, keys }) => {
          const token = localStorage.getItem('mercury_access_token')
          function toBase64(arr: number[]): string {
            const bytes = new Uint8Array(arr)
            let binary = ''
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
            return btoa(binary)
          }
          const res = await fetch(`${server}/devices/${deviceId}/keys`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              identity_key: toBase64(keys.deviceIdentityEd25519PublicKey),
              signed_prekey: toBase64(keys.signedPreKey.publicKey),
              signed_prekey_id: keys.signedPreKey.keyId,
              prekey_signature: toBase64(keys.signedPreKey.signature),
              one_time_prekeys: keys.oneTimePreKeys.map(
                (pk: { keyId: number; publicKey: number[] }) => ({
                  key_id: pk.keyId,
                  prekey: toBase64(pk.publicKey),
                }),
              ),
            }),
          })
          return { status: res.status, ok: res.ok }
        },
        {
          server: SERVER,
          deviceId: deviceResult.device_id,
          keys: recoveryResult,
        },
      )
      expect(keyBundleResult.ok).toBe(true)

      // Upload signed device list (same master verify key — TOFU should accept)
      const deviceListResult = await alice.page.evaluate(
        async ({ server, sdl }) => {
          const token = localStorage.getItem('mercury_access_token')
          function toBase64(arr: number[]): string {
            const bytes = new Uint8Array(arr)
            let binary = ''
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
            return btoa(binary)
          }
          const res = await fetch(`${server}/users/me/device-list`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              signed_list: toBase64(sdl.signedList),
              master_verify_key: toBase64(sdl.masterVerifyKey),
              signature: toBase64(sdl.signature),
            }),
          })
          return { status: res.status, ok: res.ok }
        },
        { server: SERVER, sdl: recoveryResult.signedDeviceList },
      )
      // Server accepts because master verify key matches TOFU record
      expect(deviceListResult.ok).toBe(true)
    })

    test('After restore: Alice can send new E2E messages to Bob', async () => {
      // Clear auth tokens so the app shows the login page on relaunch.
      // The device_id is preserved so ensureDeviceRegistered() is a no-op.
      await alice.page.evaluate(() => {
        localStorage.removeItem('mercury_access_token')
        localStorage.removeItem('mercury_refresh_token')
      })

      // Close and relaunch to get a fresh Electron + crypto worker with proper
      // MessagePort bridge (page.reload doesn't re-send the crypto port).
      const savedDir = alice.userDataDir
      await alice.app.close()

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

      // Login via UI to trigger full initialization: WS connect, initializeDevice
      // (idempotent — finds existing keys from recovery and returns early).
      await expect(alice.page.getByRole('heading', { name: 'Welcome back!' })).toBeVisible({ timeout: 10_000 })

      await alice.page.getByPlaceholder('you@example.com').fill(alice.email)
      await alice.page.locator('input[type="password"]').fill(PASSWORD)
      await alice.page.getByRole('button', { name: 'Log In' }).click()

      // Should land on main UI after full initialization
      await expect(alice.page.getByTitle('Create Server')).toBeVisible({ timeout: 15_000 })

      // Navigate to DMs
      await alice.page.getByTitle('Direct Messages').click()

      // Start a new DM with Bob (old DM channel not visible since local DB was lost)
      await alice.page.getByTitle('New Direct Message').click()
      await expect(alice.page.getByText('New Direct Message')).toBeVisible()
      await alice.page.getByPlaceholder('Enter user ID').fill(bob.userId)
      await alice.page.getByRole('button', { name: 'Start Chat' }).click()
      await expect(alice.page.getByText('Encrypted')).toBeVisible({ timeout: 5_000 })

      // Alice sends a post-recovery message
      const aliceInput = alice.page.locator('textarea')
      await expect(aliceInput).toBeVisible({ timeout: 5_000 })
      await aliceInput.fill('hello after recovery')
      await aliceInput.press('Enter')
      await expect(alice.page.getByText('hello after recovery')).toBeVisible({ timeout: 15_000 })

      // Bob receives and decrypts Alice's post-recovery message
      await expect(bob.page.getByText('hello after recovery')).toBeVisible({ timeout: 15_000 })
    })

    test('After restore: Bob can send messages that Alice decrypts', async () => {
      const bobInput = bob.page.locator('textarea')
      await expect(bobInput).toBeVisible({ timeout: 5_000 })
      await bobInput.fill('welcome back alice')
      await bobInput.press('Enter')

      await expect(alice.page.getByText('welcome back alice')).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe('Edge cases', () => {
    test('Wrong mnemonic returns clear error, no crash', async () => {
      // Use a fresh app instance to test wrong-mnemonic decoding
      const ctx = await launchApp('wrong_mnemonic')
      await registerUser(ctx)
      await exposeCryptoService(ctx.page)

      // Generate a valid recovery key + backup
      const keyResult = await cryptoOp<{ recoveryKey: number[]; mnemonic: string[] }>(
        ctx.page,
        'generateRecoveryKey',
      )
      const backup = await cryptoOp<{ encrypted_backup: number[]; salt: number[] }>(
        ctx.page,
        'createBackup',
        keyResult.recoveryKey,
      )

      // Generate a DIFFERENT recovery key (wrong mnemonic)
      const wrongKeyResult = await cryptoOp<{ recoveryKey: number[]; mnemonic: string[] }>(
        ctx.page,
        'generateRecoveryKey',
      )

      // Attempt restore with wrong key — should throw BackupDecryptionError
      const restoreResult = await ctx.page.evaluate(
        async ({ wrongKey, backup }) => {
          const svc = (window as any).__mercury_crypto_service__
          try {
            await svc.restoreFromBackup({
              recoveryKey: wrongKey,
              encrypted_backup: backup.encrypted_backup,
              salt: backup.salt,
            })
            return { error: null }
          } catch (err: any) {
            return { error: err.message }
          }
        },
        { wrongKey: wrongKeyResult.recoveryKey, backup },
      )
      expect(restoreResult.error).toBeTruthy()
      expect(restoreResult.error).toContain('Backup decryption failed')

      // App should still be responsive (no crash)
      const isAlive = await ctx.page.evaluate(() => document.title)
      expect(isAlive).toBeTruthy()

      await ctx.app.close()
      rmSync(ctx.userDataDir, { recursive: true, force: true })
    })

    test('Restore when no backup exists returns 404', async () => {
      // Register a new user who never uploaded a backup
      const ctx = await launchApp('no_backup')
      await registerUser(ctx)

      const result = await ctx.page.evaluate(async (server) => {
        const token = localStorage.getItem('mercury_access_token')
        const res = await fetch(`${server}/users/me/key-backup`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        return { status: res.status }
      }, SERVER)

      expect(result.status).toBe(404)

      await ctx.app.close()
      rmSync(ctx.userDataDir, { recursive: true, force: true })
    })

    test('Invalid mnemonic words are rejected', async () => {
      const ctx = await launchApp('bad_words')
      await registerUser(ctx)
      await exposeCryptoService(ctx.page)

      // Try decoding with invalid words
      const result = await ctx.page.evaluate(async () => {
        const svc = (window as any).__mercury_crypto_service__
        try {
          await svc.decodeMnemonic([
            'notaword', 'invalid', 'mnemonic', 'test', 'words', 'here',
            'notaword', 'invalid', 'mnemonic', 'test', 'words', 'here',
            'notaword', 'invalid', 'mnemonic', 'test', 'words', 'here',
            'notaword', 'invalid', 'mnemonic', 'test', 'words', 'here',
          ])
          return { error: null }
        } catch (err: any) {
          return { error: err.message }
        }
      })
      expect(result.error).toBeTruthy()
      expect(result.error).toContain('Unknown word')

      await ctx.app.close()
      rmSync(ctx.userDataDir, { recursive: true, force: true })
    })

    test('Wrong word count is rejected', async () => {
      const ctx = await launchApp('wrong_count')
      await registerUser(ctx)
      await exposeCryptoService(ctx.page)

      const result = await ctx.page.evaluate(async () => {
        const svc = (window as any).__mercury_crypto_service__
        try {
          await svc.decodeMnemonic(['abandon', 'ability', 'able'])
          return { error: null }
        } catch (err: any) {
          return { error: err.message }
        }
      })
      expect(result.error).toBeTruthy()
      expect(result.error).toContain('Expected 24 words')

      await ctx.app.close()
      rmSync(ctx.userDataDir, { recursive: true, force: true })
    })
  })

  test.afterAll(async () => {
    await alice?.app?.close()
    await bob?.app?.close()
    if (alice?.userDataDir) rmSync(alice.userDataDir, { recursive: true, force: true })
    if (bob?.userDataDir) rmSync(bob.userDataDir, { recursive: true, force: true })
  })
})
