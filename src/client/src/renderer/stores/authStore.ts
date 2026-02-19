import { create } from 'zustand'
import type { User, AuthTokens } from '../types/models'
import { auth as authApi, users as usersApi, setTokenProvider } from '../services/api'
import { wsManager } from '../services/websocket'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

  login(email: string, password: string): Promise<void>
  register(username: string, email: string, password: string): Promise<void>
  logout(): Promise<void>
  refreshTokens(): Promise<void>
  setTokens(tokens: AuthTokens): void
  clearError(): void
  hydrateFromStorage(): void
}

export const useAuthStore = create<AuthState>((set, get) => {
  // Wire up the token provider for the API client
  setTokenProvider({
    getAccessToken: () => get().accessToken,
    getRefreshToken: () => get().refreshToken,
    onTokenRefreshed: (access, refresh) => {
      set({ accessToken: access, refreshToken: refresh })
      persistTokens(access, refresh)
    },
    onAuthFailed: () => {
      get().logout()
    },
  })

  return {
    user: null,
    accessToken: null,
    refreshToken: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,

    async login(email: string, password: string) {
      set({ isLoading: true, error: null })
      try {
        const response = await authApi.login({ email, password })
        set({
          accessToken: response.access_token,
          refreshToken: response.refresh_token,
          isAuthenticated: true,
          isLoading: false,
        })
        persistTokens(response.access_token, response.refresh_token)

        // Fetch user profile
        const user = await usersApi.me()
        set({ user })

        // Connect WebSocket
        wsManager.connect(response.access_token)
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : 'Login failed',
        })
        throw err
      }
    },

    async register(username: string, email: string, password: string) {
      set({ isLoading: true, error: null })
      try {
        const response = await authApi.register({ username, email, password })
        set({
          accessToken: response.access_token,
          refreshToken: response.refresh_token,
          isAuthenticated: true,
          isLoading: false,
        })
        persistTokens(response.access_token, response.refresh_token)

        // Fetch user profile
        const user = await usersApi.me()
        set({ user })

        // Connect WebSocket
        wsManager.connect(response.access_token)
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : 'Registration failed',
        })
        throw err
      }
    },

    async logout() {
      try {
        await authApi.logout()
      } catch {
        // ignore logout errors
      }
      wsManager.disconnect()
      set({
        user: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        error: null,
      })
      clearPersistedTokens()
    },

    async refreshTokens() {
      const { refreshToken } = get()
      if (!refreshToken) return

      try {
        const response = await authApi.refresh(refreshToken)
        set({
          accessToken: response.access_token,
          refreshToken: response.refresh_token,
        })
        persistTokens(response.access_token, response.refresh_token)
      } catch {
        get().logout()
      }
    },

    setTokens(tokens: AuthTokens) {
      set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        isAuthenticated: true,
      })
      persistTokens(tokens.access_token, tokens.refresh_token)
    },

    clearError() {
      set({ error: null })
    },

    hydrateFromStorage() {
      const accessToken = localStorage.getItem('mercury_access_token')
      const refreshToken = localStorage.getItem('mercury_refresh_token')
      if (accessToken && refreshToken) {
        set({ accessToken, refreshToken, isAuthenticated: true })
        // Fetch user and connect WS
        usersApi
          .me()
          .then((user) => {
            set({ user })
            wsManager.connect(accessToken)
          })
          .catch(() => {
            // Token may be expired, try refresh
            get().refreshTokens()
          })
      }
    },
  }
})

function persistTokens(access: string, refresh: string): void {
  localStorage.setItem('mercury_access_token', access)
  localStorage.setItem('mercury_refresh_token', refresh)
}

function clearPersistedTokens(): void {
  localStorage.removeItem('mercury_access_token')
  localStorage.removeItem('mercury_refresh_token')
}
