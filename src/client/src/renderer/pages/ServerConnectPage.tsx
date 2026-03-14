import React, { useState } from 'react'
import {
  getDefaultServerUrl,
  normalizeServerUrl,
  probeServer,
  setConfiguredServerUrl,
} from '../services/serverUrl'

interface ServerConnectPageProps {
  onConnected: () => void
}

export function ServerConnectPage({ onConnected }: ServerConnectPageProps): React.ReactElement {
  const [url, setUrl] = useState(getDefaultServerUrl())
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverInfo, setServerInfo] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setServerInfo(null)

    const normalized = normalizeServerUrl(url)
    if (!normalized) {
      setError('Please enter a server URL')
      return
    }

    // Basic URL validation
    try {
      new URL(normalized)
    } catch {
      setError('Invalid URL format')
      return
    }

    setIsConnecting(true)
    try {
      const info = await probeServer(normalized)
      setServerInfo(`Connected — v${info.version} (${info.status})`)
      setConfiguredServerUrl(normalized)
      onConnected()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to server')
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg-primary">
      <div className="w-full max-w-md rounded-lg bg-bg-secondary p-8 shadow-lg">
        <h1 className="mb-2 text-center text-2xl font-bold text-text-primary">Connect to Server</h1>
        <p className="mb-6 text-center text-text-muted">
          Enter the URL of your Mercury server
        </p>

        {error && (
          <div className="mb-4 rounded bg-bg-danger/20 px-4 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {serverInfo && (
          <div className="mb-4 rounded bg-green-900/20 px-4 py-2 text-sm text-green-400">
            {serverInfo}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-2 block text-xs font-bold uppercase text-text-secondary">
              Server URL
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              className="w-full rounded bg-bg-input px-3 py-2 text-text-primary outline-none focus:ring-2 focus:ring-bg-accent"
              placeholder="https://mercury.example.com:8443"
            />
          </div>

          <button
            type="submit"
            disabled={isConnecting}
            className="w-full rounded bg-bg-accent py-2 font-medium text-white transition-colors hover:bg-bg-accent-hover disabled:opacity-50"
          >
            {isConnecting ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  )
}
