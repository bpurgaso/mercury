import { create } from 'zustand'
import type { User, AuthTokens } from '../types/models'
import { auth as authApi, users as usersApi, devices as devicesApi, deviceList as deviceListApi, setTokenProvider } from '../services/api'
import { wsManager } from '../services/websocket'
import { cryptoService } from '../services/crypto'

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
          isLoading: false,
        })
        persistTokens(response.access_token, response.refresh_token)

        // Fetch user profile
        const user = await usersApi.me()
        set({ user })

        // Ensure device is registered on the server (needed before WS identify)
        await ensureDeviceRegistered()

        // Connect WebSocket (uses device ID from localStorage)
        wsManager.connect(response.access_token)

        // Initialize crypto device if needed (idempotent for returning users)
        await initializeDevice()

        // Now flip authenticated — UI renders ServerPage
        set({ isAuthenticated: true })
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
          isLoading: false,
        })
        persistTokens(response.access_token, response.refresh_token)

        // Fetch user profile
        const user = await usersApi.me()
        set({ user })

        // Register device on server (must happen before WS identify)
        await ensureDeviceRegistered()

        // Connect WebSocket (uses device ID from localStorage)
        wsManager.connect(response.access_token)

        // Initialize crypto device (generate keys + upload bundles + device list)
        await initializeDevice()

        // Now flip authenticated — UI renders ServerPage
        set({ isAuthenticated: true })
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

/** Convert a number[] to base64 string. */
function numberArrayToBase64(arr: number[]): string {
  const bytes = new Uint8Array(arr)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Wait for the WebSocket to reach CONNECTED state (READY received from server). */
function waitForWsConnected(timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (wsManager.getState() === 'CONNECTED') {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('WebSocket connection timed out'))
    }, timeoutMs)
    const unsub = wsManager.onStateChange((state) => {
      if (state === 'CONNECTED') {
        clearTimeout(timer)
        unsub()
        resolve()
      }
    })
  })
}

/**
 * Ensure this client has a device registered on the server.
 * On first run, calls POST /devices to create one and stores the
 * server-assigned device_id in localStorage. On subsequent runs,
 * the existing device_id is reused.
 */
async function ensureDeviceRegistered(): Promise<void> {
  const existing = localStorage.getItem('mercury_device_id')
  if (existing) return // Already registered

  const resp = await devicesApi.register('Mercury Desktop')
  localStorage.setItem('mercury_device_id', resp.device_id)
}

/**
 * Initialize the crypto device after login/register.
 * Generates key material and uploads the key bundle + signed device list
 * to the server. Idempotent — skips if keys already exist.
 */
async function initializeDevice(): Promise<void> {
  const deviceId = localStorage.getItem('mercury_device_id')
  if (!deviceId) return

  // Check if keys already exist (returning user)
  try {
    await cryptoService.getPublicKeys()
    return // Keys exist — device list should already be on server
  } catch {
    // No keys — proceed with full initialization
  }

  // 1. Generate all crypto keys
  const keys = await cryptoService.generateAllKeys(deviceId)

  // 2. Wait for WS connection (server needs to know our device before we upload keys)
  await waitForWsConnected()

  // 3. Upload key bundle to server
  const identityKeyB64 = numberArrayToBase64(keys.deviceIdentityEd25519PublicKey)
  await devicesApi.uploadKeyBundle(deviceId, {
    identity_key: identityKeyB64,
    signed_prekey: numberArrayToBase64(keys.signedPreKey.publicKey),
    signed_prekey_id: keys.signedPreKey.keyId,
    prekey_signature: numberArrayToBase64(keys.signedPreKey.signature),
    one_time_prekeys: keys.oneTimePreKeys.map((pk) => ({
      key_id: pk.keyId,
      prekey: numberArrayToBase64(pk.publicKey),
    })),
  })

  // 4. Create and upload signed device list
  const signedList = await cryptoService.createSignedDeviceList(deviceId, identityKeyB64)
  await deviceListApi.upload({
    signed_list: numberArrayToBase64(signedList.signedList),
    master_verify_key: numberArrayToBase64(signedList.masterVerifyKey),
    signature: numberArrayToBase64(signedList.signature),
  })
}
