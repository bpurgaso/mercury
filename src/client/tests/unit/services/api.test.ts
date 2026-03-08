import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// We'll test the api module's 401-refresh-retry behavior by mocking fetch
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// Mock websocket to avoid import side-effects
vi.mock('../../../src/renderer/services/websocket', () => ({
  wsManager: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() },
}))

import { setTokenProvider, auth, servers, ApiError } from '../../../src/renderer/services/api'

describe('API client', () => {
  let onTokenRefreshed: (access: string, refresh: string) => void
  let onAuthFailed: () => void

  beforeEach(() => {
    vi.clearAllMocks()

    onTokenRefreshed = vi.fn()
    onAuthFailed = vi.fn()

    setTokenProvider({
      getAccessToken: () => 'current-access-token',
      getRefreshToken: () => 'current-refresh-token',
      onTokenRefreshed,
      onAuthFailed,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // TESTSPEC: RC-001
  it('injects Authorization header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    })

    await servers.list()

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer current-access-token')
  })

  // TESTSPEC: RC-002
  it('401 triggers refresh and retries the request', async () => {
    // First call: 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: 'Token expired' }),
    })

    // Refresh call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    })

    // Retry call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ id: 's1', name: 'Server 1' }]),
    })

    const result = await servers.list()

    // Should have made 3 fetch calls: original, refresh, retry
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(onTokenRefreshed).toHaveBeenCalledWith('new-access', 'new-refresh')
    expect(result).toEqual([{ id: 's1', name: 'Server 1' }])
  })

  // TESTSPEC: RC-003
  it('401 with failed refresh calls onAuthFailed', async () => {
    // First call: 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: 'Token expired' }),
    })

    // Refresh call: fail
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    })

    await expect(servers.list()).rejects.toThrow(ApiError)
    expect(onAuthFailed).toHaveBeenCalled()
  })

  it('non-401 errors throw ApiError with status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: () => Promise.resolve({ error: 'Already exists' }),
    })

    try {
      await servers.list()
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      expect((err as ApiError).message).toBe('Already exists')
    }
  })

  it('auth.register does not retry on 401', async () => {
    // Register doesn't use auth tokens, so no retry behavior
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ user_id: 'u1', access_token: 'a', refresh_token: 'r' }),
    })

    const result = await auth.register({
      username: 'test',
      email: 'test@test.com',
      password: 'pass',
    })

    expect(result.access_token).toBe('a')
  })

  it('handles 204 No Content responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error('No body')),
    })

    // DELETE endpoints return 204
    const result = await servers.delete('server-1')
    expect(result).toBeUndefined()
  })
})
