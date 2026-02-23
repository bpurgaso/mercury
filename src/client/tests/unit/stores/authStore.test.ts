import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the api module before importing the store
vi.mock('../../../src/renderer/services/api', () => ({
  auth: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  },
  users: {
    me: vi.fn(),
  },
  devices: {
    register: vi.fn().mockResolvedValue({ device_id: 'mock-device-id' }),
    uploadKeyBundle: vi.fn().mockResolvedValue({}),
  },
  deviceList: {
    upload: vi.fn().mockResolvedValue({}),
  },
  setTokenProvider: vi.fn(),
}))

// Mock the websocket module
vi.mock('../../../src/renderer/services/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getState: vi.fn(() => 'CONNECTED'),
    onStateChange: vi.fn(),
  },
}))

// Mock the crypto service (initializeDevice calls getPublicKeys on startup)
vi.mock('../../../src/renderer/services/crypto', () => ({
  cryptoService: {
    getPublicKeys: vi.fn().mockResolvedValue({}),
    generateAllKeys: vi.fn(),
    createSignedDeviceList: vi.fn(),
  },
  initCryptoPort: vi.fn(),
}))

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

import { useAuthStore } from '../../../src/renderer/stores/authStore'
import { auth as authApi, users as usersApi } from '../../../src/renderer/services/api'
import { wsManager } from '../../../src/renderer/services/websocket'

describe('authStore', () => {
  beforeEach(() => {
    // Reset the store state
    useAuthStore.setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    })
    vi.clearAllMocks()
    localStorageMock.clear()
  })

  it('login sets tokens, user, and connects websocket', async () => {
    const mockAuthResponse = {
      user_id: 'user-1',
      access_token: 'access-123',
      refresh_token: 'refresh-456',
    }
    const mockUser = {
      id: 'user-1',
      username: 'testuser',
      display_name: 'Test User',
      email: 'test@example.com',
      avatar_url: null,
      status: null,
      created_at: null,
    }

    vi.mocked(authApi.login).mockResolvedValue(mockAuthResponse)
    vi.mocked(usersApi.me).mockResolvedValue(mockUser)

    await useAuthStore.getState().login('test@example.com', 'password123')

    const state = useAuthStore.getState()
    expect(state.accessToken).toBe('access-123')
    expect(state.refreshToken).toBe('refresh-456')
    expect(state.isAuthenticated).toBe(true)
    expect(state.user).toEqual(mockUser)
    expect(wsManager.connect).toHaveBeenCalledWith('access-123')
    expect(localStorageMock.setItem).toHaveBeenCalledWith('mercury_access_token', 'access-123')
    expect(localStorageMock.setItem).toHaveBeenCalledWith('mercury_refresh_token', 'refresh-456')
  })

  it('login sets error on failure', async () => {
    vi.mocked(authApi.login).mockRejectedValue(new Error('Invalid credentials'))

    await expect(useAuthStore.getState().login('bad@email.com', 'wrong')).rejects.toThrow()

    const state = useAuthStore.getState()
    expect(state.isAuthenticated).toBe(false)
    expect(state.error).toBe('Invalid credentials')
    expect(state.isLoading).toBe(false)
  })

  it('logout clears tokens, user, and disconnects websocket', async () => {
    // Set up authenticated state
    useAuthStore.setState({
      user: { id: 'u1', username: 'test', display_name: 'Test', email: 'e', avatar_url: null, status: null, created_at: null },
      accessToken: 'tok',
      refreshToken: 'ref',
      isAuthenticated: true,
    })
    vi.mocked(authApi.logout).mockResolvedValue(undefined)

    await useAuthStore.getState().logout()

    const state = useAuthStore.getState()
    expect(state.accessToken).toBeNull()
    expect(state.refreshToken).toBeNull()
    expect(state.isAuthenticated).toBe(false)
    expect(state.user).toBeNull()
    expect(wsManager.disconnect).toHaveBeenCalled()
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('mercury_access_token')
  })

  it('register sets tokens and connects', async () => {
    const mockAuthResponse = {
      user_id: 'user-2',
      access_token: 'new-access',
      refresh_token: 'new-refresh',
    }
    const mockUser = {
      id: 'user-2',
      username: 'newuser',
      display_name: 'newuser',
      email: 'new@example.com',
      avatar_url: null,
      status: null,
      created_at: null,
    }

    vi.mocked(authApi.register).mockResolvedValue(mockAuthResponse)
    vi.mocked(usersApi.me).mockResolvedValue(mockUser)

    await useAuthStore.getState().register('newuser', 'new@example.com', 'password123')

    const state = useAuthStore.getState()
    expect(state.accessToken).toBe('new-access')
    expect(state.refreshToken).toBe('new-refresh')
    expect(state.isAuthenticated).toBe(true)
    expect(state.user?.username).toBe('newuser')
  })

  it('setTokens persists tokens to localStorage', () => {
    useAuthStore.getState().setTokens({ access_token: 'a', refresh_token: 'r' })

    const state = useAuthStore.getState()
    expect(state.accessToken).toBe('a')
    expect(state.refreshToken).toBe('r')
    expect(state.isAuthenticated).toBe(true)
    expect(localStorageMock.setItem).toHaveBeenCalledWith('mercury_access_token', 'a')
    expect(localStorageMock.setItem).toHaveBeenCalledWith('mercury_refresh_token', 'r')
  })
})
