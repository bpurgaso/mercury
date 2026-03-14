const STORAGE_KEY = 'mercury_server_url'
const DEFAULT_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_SERVER_URL || 'https://localhost:8443'

const storage = typeof localStorage !== 'undefined' ? localStorage : null

export function getConfiguredServerUrl(): string {
  return storage?.getItem(STORAGE_KEY) || DEFAULT_URL
}

export function setConfiguredServerUrl(url: string): void {
  storage?.setItem(STORAGE_KEY, url)
}

export function clearConfiguredServerUrl(): void {
  storage?.removeItem(STORAGE_KEY)
}

export function hasConfiguredServerUrl(): boolean {
  return storage?.getItem(STORAGE_KEY) !== null && storage?.getItem(STORAGE_KEY) !== undefined
}

export function getDefaultServerUrl(): string {
  return DEFAULT_URL
}

/**
 * Normalize a user-entered URL: ensure https:// prefix, strip trailing slashes.
 */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim()
  if (!url) return url

  // Add https:// if no protocol specified
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`
  }

  // Strip trailing slashes
  url = url.replace(/\/+$/, '')

  return url
}

/**
 * Probe the server's /health endpoint to check reachability.
 * Returns the server version string on success, or throws on failure.
 */
export async function probeServer(url: string): Promise<{ version: string; status: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(`${url}/health`, {
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`)
    }

    const data = await response.json() as { version?: string; status?: string }
    return {
      version: data.version || 'unknown',
      status: data.status || 'unknown',
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Connection timed out')
    }
    if (err instanceof TypeError) {
      throw new Error('Could not reach server')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Clear all server-specific state from localStorage.
 * Called when switching servers to prevent cross-server token/key reuse.
 */
export function clearServerState(): void {
  if (!storage) return
  storage.removeItem('mercury_access_token')
  storage.removeItem('mercury_refresh_token')
  storage.removeItem('mercury_device_id')
  // Clear crypto keys — they are bound to a device on a specific server
  const keysToRemove: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key && (key.startsWith('mercury_crypto_') || key.startsWith('mercury_sender_key_'))) {
      keysToRemove.push(key)
    }
  }
  keysToRemove.forEach((key) => storage!.removeItem(key))
}
