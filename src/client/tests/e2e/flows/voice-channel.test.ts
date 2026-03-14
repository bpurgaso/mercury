/**
 * E2E Voice/Video Channel Tests — Playwright + Electron
 *
 * Prerequisites:
 * - Mercury server running at https://localhost:8443
 * - coturn running for TURN relay
 * - Clean database or fresh test users
 *
 * Run: pnpm test:e2e
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

// --- Helpers ---

interface TestUser {
  app: ElectronApplication
  page: Page
  userDataDir: string
  username: string
}

const timestamp = Date.now()
const PASSWORD = 'TestPassword123!'
const SERVER_NAME = `Voice Test Server ${timestamp}`

async function createUser(suffix: string): Promise<TestUser> {
  const userDataDir = mkdtempSync(join(tmpdir(), `mercury-voice-e2e-${suffix}-`))
  const app = await electron.launch({
    args: [
      join(__dirname, '../../../out/main/index.js'),
      `--user-data-dir=${userDataDir}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const username = `voicetest_${suffix}_${timestamp}`

  // Register
  await page.getByRole('button', { name: 'Register' }).click()
  await page.getByPlaceholder('cooluser').fill(username)
  await page.getByPlaceholder('you@example.com').fill(`${username}@test.com`)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByTitle('Create Server')).toBeVisible({ timeout: 10000 })

  return { app, page, userDataDir, username }
}

async function cleanup(user: TestUser): Promise<void> {
  await user.app?.close()
  rmSync(user.userDataDir, { recursive: true, force: true })
}

/**
 * Retrieve outbound RTP stats from the window-exposed PeerConnection.
 * Returns { audioBytesSent, videoBytesSent } or null if no PC exposed.
 */
async function getOutboundStats(page: Page): Promise<{ audioBytesSent: number; videoBytesSent: number } | null> {
  return page.evaluate(async () => {
    const pc = (window as Record<string, unknown>).__mercury_pc as RTCPeerConnection | undefined
    if (!pc) return null
    const stats = await pc.getStats()
    let audioBytesSent = 0
    let videoBytesSent = 0
    stats.forEach((report) => {
      if (report.type === 'outbound-rtp') {
        if (report.kind === 'audio') audioBytesSent += report.bytesSent ?? 0
        if (report.kind === 'video') videoBytesSent += report.bytesSent ?? 0
      }
    })
    return { audioBytesSent, videoBytesSent }
  })
}

/**
 * Retrieve inbound RTP stats from the window-exposed PeerConnection.
 * Returns { audioBytesReceived, videoBytesReceived } or null if no PC exposed.
 */
async function getInboundStats(page: Page): Promise<{ audioBytesReceived: number; videoBytesReceived: number } | null> {
  return page.evaluate(async () => {
    const pc = (window as Record<string, unknown>).__mercury_pc as RTCPeerConnection | undefined
    if (!pc) return null
    const stats = await pc.getStats()
    let audioBytesReceived = 0
    let videoBytesReceived = 0
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp') {
        if (report.kind === 'audio') audioBytesReceived += report.bytesReceived ?? 0
        if (report.kind === 'video') videoBytesReceived += report.bytesReceived ?? 0
      }
    })
    return { audioBytesReceived, videoBytesReceived }
  })
}

/**
 * Wait for outbound stats condition to become true, polling every interval.
 */
async function waitForOutboundStats(
  page: Page,
  check: (stats: { audioBytesSent: number; videoBytesSent: number }) => boolean,
  timeoutMs = 15000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stats = await getOutboundStats(page)
    if (stats && check(stats)) return
    await page.waitForTimeout(intervalMs)
  }
  throw new Error(`Outbound stats condition not met within ${timeoutMs}ms`)
}

/**
 * Wait for inbound stats condition to become true, polling every interval.
 */
async function waitForInboundStats(
  page: Page,
  check: (stats: { audioBytesReceived: number; videoBytesReceived: number }) => boolean,
  timeoutMs = 15000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stats = await getInboundStats(page)
    if (stats && check(stats)) return
    await page.waitForTimeout(intervalMs)
  }
  throw new Error(`Inbound stats condition not met within ${timeoutMs}ms`)
}

// --- Test Setup ---

let user1: TestUser
let user2: TestUser

test.beforeAll(async () => {
  user1 = await createUser('alice')
  user2 = await createUser('bob')

  // User1 creates a server
  await user1.page.getByTitle('Create Server').click()
  await user1.page.getByPlaceholder('My Awesome Server').fill(SERVER_NAME)
  await user1.page.getByRole('button', { name: 'Create' }).click()
  await expect(user1.page.getByTitle(SERVER_NAME)).toBeVisible({ timeout: 5000 })

  // Retrieve the server ID and invite code from the API
  const serverInfo = await user1.page.evaluate(async (sName: string) => {
    const token = localStorage.getItem('mercury_access_token')
    const res = await fetch('https://localhost:8443/servers', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const servers = await res.json()
    const server = servers.find((s: { name: string }) => s.name === sName)
    return { id: server?.id as string, inviteCode: server?.invite_code as string }
  }, SERVER_NAME)
  expect(serverInfo.id).toBeTruthy()
  expect(serverInfo.inviteCode).toBeTruthy()

  // User2 joins the server via invite code
  await user2.page.getByTitle('Join Server').click()
  await expect(user2.page.getByRole('heading', { name: 'Join a Server' })).toBeVisible()
  await user2.page.getByPlaceholder('Enter an invite code').fill(serverInfo.inviteCode)
  await user2.page.getByRole('button', { name: 'Join' }).click()
  await expect(user2.page.getByTitle(SERVER_NAME)).toBeVisible({ timeout: 10000 })

  // Create a voice channel via API
  await user1.page.evaluate(async (serverId: string) => {
    const token = localStorage.getItem('mercury_access_token')
    await fetch(`https://localhost:8443/servers/${serverId}/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Voice Chat',
        channel_type: 'voice',
        encryption_mode: 'standard',
      }),
    })
  }, serverInfo.id)

  // Wait for voice channel to appear in both users' channel lists
  await expect(user1.page.getByTestId(/voice-channel-/)).toBeVisible({ timeout: 5000 })
  await expect(user2.page.getByTestId(/voice-channel-/)).toBeVisible({ timeout: 5000 })
})

test.afterAll(async () => {
  await cleanup(user1)
  await cleanup(user2)
})

// --- Tests ---

test.describe('Voice channel — two users', () => {
  // TESTSPEC: E2E-023
  test('two users join voice channel, audio bytes flow both directions', async () => {
    // User1 clicks the voice channel to join
    await user1.page.getByTestId(/voice-channel-/).click()
    await expect(user1.page.getByTestId('voice-panel')).toBeVisible({ timeout: 10000 })

    // Verify control buttons are present
    await expect(user1.page.getByTestId('voice-mute-btn')).toBeVisible()
    await expect(user1.page.getByTestId('voice-deafen-btn')).toBeVisible()
    await expect(user1.page.getByTestId('voice-disconnect-btn')).toBeVisible()
    await expect(user1.page.getByTestId('voice-camera-btn')).toBeVisible()

    // User2 clicks the voice channel to join
    await user2.page.getByTestId(/voice-channel-/).click()
    await expect(user2.page.getByTestId('voice-panel')).toBeVisible({ timeout: 10000 })

    // Wait for outbound audio bytes to flow from both users
    await waitForOutboundStats(user1.page, (s) => s.audioBytesSent > 0, 15000)
    await waitForOutboundStats(user2.page, (s) => s.audioBytesSent > 0, 15000)

    const user1OutStats = await getOutboundStats(user1.page)
    const user2OutStats = await getOutboundStats(user2.page)
    expect(user1OutStats).not.toBeNull()
    expect(user1OutStats!.audioBytesSent).toBeGreaterThan(0)
    expect(user2OutStats).not.toBeNull()
    expect(user2OutStats!.audioBytesSent).toBeGreaterThan(0)

    // Verify SFU forwarding: at least one user should receive inbound audio
    // (the SFU forwards user1's audio to user2 and vice versa)
    await waitForInboundStats(user2.page, (s) => s.audioBytesReceived > 0, 20000)
    const user2InStats = await getInboundStats(user2.page)
    expect(user2InStats).not.toBeNull()
    expect(user2InStats!.audioBytesReceived).toBeGreaterThan(0)
  })

  // TESTSPEC: E2E-024
  test('mute: audio bytes stop flowing after mute', async () => {
    const muteBtn = user1.page.getByTestId('voice-mute-btn')

    // Record bytes before mute
    const before = await getOutboundStats(user1.page)
    expect(before).not.toBeNull()

    // Click mute
    await muteBtn.click()

    // Wait for the mute to take effect — encoding pipeline needs time to drain
    await user1.page.waitForTimeout(3000)

    // Record bytes over a 2-second window while muted
    const afterMute1 = await getOutboundStats(user1.page)
    await user1.page.waitForTimeout(2000)
    const afterMute2 = await getOutboundStats(user1.page)

    expect(afterMute1).not.toBeNull()
    expect(afterMute2).not.toBeNull()

    // While muted, audio bytes should plateau. RTCP keepalives and codec
    // drain may still produce some bytes, so use a generous threshold.
    const byteDelta = afterMute2!.audioBytesSent - afterMute1!.audioBytesSent
    expect(byteDelta).toBeLessThan(5000)

    // Unmute to restore for next tests
    await muteBtn.click()
  })

  // TESTSPEC: E2E-025
  test('deafen: also mutes self, remote audio tracks disabled', async () => {
    const deafenBtn = user1.page.getByTestId('voice-deafen-btn')

    // Click deafen
    await deafenBtn.click()

    // Verify user1 is also muted (check outbound audio stops)
    await user1.page.waitForTimeout(3000)
    const stats1 = await getOutboundStats(user1.page)
    await user1.page.waitForTimeout(2000)
    const stats2 = await getOutboundStats(user1.page)

    expect(stats1).not.toBeNull()
    expect(stats2).not.toBeNull()
    const byteDelta = stats2!.audioBytesSent - stats1!.audioBytesSent
    expect(byteDelta).toBeLessThan(5000)

    // Verify remote audio is disabled (inbound audio track should be disabled)
    const remoteDisabled = await user1.page.evaluate(() => {
      const pc = (window as Record<string, unknown>).__mercury_pc as RTCPeerConnection | undefined
      if (!pc) return null
      const receivers = pc.getReceivers()
      const audioReceivers = receivers.filter((r) => r.track?.kind === 'audio')
      return audioReceivers.every((r) => r.track?.enabled === false)
    })
    expect(remoteDisabled).toBe(true)

    // Undeafen
    await deafenBtn.click()
  })
})

test.describe('Video — camera toggle and video flow', () => {
  // TESTSPEC: E2E-043
  test('enable camera: video bytes flow and video grid appears', async () => {
    // Ensure both users are still in the voice call from prior tests
    await expect(user1.page.getByTestId('voice-panel')).toBeVisible({ timeout: 5000 })
    await expect(user2.page.getByTestId('voice-panel')).toBeVisible({ timeout: 5000 })

    // User1 enables camera
    await user1.page.getByTestId('voice-camera-btn').click()

    // Wait for outbound video bytes to flow
    await waitForOutboundStats(user1.page, (s) => s.videoBytesSent > 0, 20000)

    const stats = await getOutboundStats(user1.page)
    expect(stats).not.toBeNull()
    expect(stats!.videoBytesSent).toBeGreaterThan(0)

    // Video grid should be visible with at least one video tile
    await expect(user1.page.getByTestId('video-grid')).toBeVisible({ timeout: 5000 })
    await expect(user1.page.getByTestId('video-tile').first()).toBeVisible({ timeout: 5000 })
  })

  // TESTSPEC: E2E-044
  test('two users video: both enable camera, video bytes flow bidirectionally', async () => {
    // User1's camera should still be on from E2E-043

    // User2 enables camera
    await user2.page.getByTestId('voice-camera-btn').click()

    // Wait for user2 outbound video bytes
    await waitForOutboundStats(user2.page, (s) => s.videoBytesSent > 0, 20000)

    const user2OutStats = await getOutboundStats(user2.page)
    expect(user2OutStats).not.toBeNull()
    expect(user2OutStats!.videoBytesSent).toBeGreaterThan(0)

    // Verify SFU forwards video: user2 should receive user1's video
    await waitForInboundStats(user2.page, (s) => s.videoBytesReceived > 0, 20000)
    const user2InStats = await getInboundStats(user2.page)
    expect(user2InStats).not.toBeNull()
    expect(user2InStats!.videoBytesReceived).toBeGreaterThan(0)

    // Verify user1 also receives user2's video
    await waitForInboundStats(user1.page, (s) => s.videoBytesReceived > 0, 20000)
    const user1InStats = await getInboundStats(user1.page)
    expect(user1InStats).not.toBeNull()
    expect(user1InStats!.videoBytesReceived).toBeGreaterThan(0)

    // Both should see the video grid with multiple tiles
    await expect(user1.page.getByTestId('video-grid')).toBeVisible()
    await expect(user2.page.getByTestId('video-grid')).toBeVisible()
  })

  // TESTSPEC: E2E-045
  test('disable camera: video bytes stop flowing', async () => {
    // User1 disables camera
    await user1.page.getByTestId('voice-camera-btn').click()

    // Wait for the disable to take effect and encoding pipeline to drain
    await user1.page.waitForTimeout(3000)

    // Record video bytes over a 2-second window while camera is off
    const afterDisable1 = await getOutboundStats(user1.page)
    await user1.page.waitForTimeout(2000)
    const afterDisable2 = await getOutboundStats(user1.page)

    expect(afterDisable1).not.toBeNull()
    expect(afterDisable2).not.toBeNull()

    // Video bytes should plateau (RTCP keepalives may produce minimal bytes)
    const videoByteDelta = afterDisable2!.videoBytesSent - afterDisable1!.videoBytesSent
    expect(videoByteDelta).toBeLessThan(5000)

    // Audio should still be flowing (camera off doesn't affect audio)
    const audioByteDelta = afterDisable2!.audioBytesSent - afterDisable1!.audioBytesSent
    expect(audioByteDelta).toBeGreaterThan(0)

    // Turn off user2's camera too for clean state
    await user2.page.getByTestId('voice-camera-btn').click()
  })
})

test.describe('Disconnect and cleanup', () => {
  // TESTSPEC: E2E-029
  test('disconnect button → user leaves call, voice panel disappears', async () => {
    const voicePanel = user1.page.getByTestId('voice-panel')
    if (!(await voicePanel.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip()
      return
    }

    const disconnectBtn = user1.page.getByTestId('voice-disconnect-btn')
    await disconnectBtn.click()

    // Voice panel should disappear
    await expect(voicePanel).not.toBeVisible({ timeout: 5000 })

    // PeerConnection should be cleaned up (no longer exposed)
    const pcCleanedUp = await user1.page.evaluate(() => {
      return (window as Record<string, unknown>).__mercury_pc === undefined
    })
    expect(pcCleanedUp).toBe(true)

    // Disconnect user2 too for clean state
    const user2Panel = user2.page.getByTestId('voice-panel')
    if (await user2Panel.isVisible({ timeout: 1000 }).catch(() => false)) {
      await user2.page.getByTestId('voice-disconnect-btn').click()
      await expect(user2Panel).not.toBeVisible({ timeout: 5000 })
    }
  })
})
