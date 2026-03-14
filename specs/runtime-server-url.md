# Runtime-Configurable Server URL

## Problem Statement

The Mercury desktop client currently has its server URL baked in at build time via `VITE_SERVER_URL`, falling back to `https://localhost:8443`. This means:

- Every deployment targeting a different server requires a separate client build
- Users cannot point a pre-built client at their own Mercury server
- There is no way to switch servers without rebuilding the app

This is fine for development, but blocks real-world deployment where a single distributed binary needs to connect to an operator's server.

## Proposed Solution

Add a server URL configuration step **before** the login/register screen. The URL is persisted in `localStorage` and used by the API client and WebSocket manager at runtime. The existing `VITE_SERVER_URL` / `localhost:8443` default is preserved for development.

## Goals

- Users can enter a server URL and the client connects to it without rebuilding
- The configured URL persists across app restarts
- The client validates the URL before accepting it (format check + reachability probe)
- Development workflow is unchanged — `localhost:8443` remains the default
- Changing servers clears auth state (tokens are server-specific)

## Non-Goals

- Multi-server support (connecting to multiple servers simultaneously)
- Server discovery protocol (mDNS, DNS SRV, etc.)
- Server-side changes — this is purely a client feature
- Invite links that encode a server URL (future feature)

## Detailed Design

### 1. Server URL Storage

A new module `src/client/src/renderer/services/serverUrl.ts` manages the configured URL:

```typescript
const STORAGE_KEY = 'mercury_server_url'
const DEFAULT_URL = import.meta.env.VITE_SERVER_URL || 'https://localhost:8443'

export function getConfiguredServerUrl(): string {
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_URL
}

export function setConfiguredServerUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, url)
}

export function clearConfiguredServerUrl(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function hasConfiguredServerUrl(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null
}
```

### 2. API Client Changes

In `api.ts`, replace the static `SERVER_URL` constant with a function call:

```typescript
// Before:
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'https://localhost:8443'

// After:
import { getConfiguredServerUrl } from './serverUrl'

// getServerUrl() already exists and is exported — update it to read from the new source:
export function getServerUrl(): string {
  return getConfiguredServerUrl()
}
```

The `request()` function already calls `getServerUrl()` indirectly via the `SERVER_URL` variable — change it to call `getServerUrl()` directly so it picks up runtime changes:

```typescript
async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const url = `${getServerUrl()}${path}`
  // ... rest unchanged
}
```

Similarly update `doRefresh()` which directly references `SERVER_URL`.

### 3. WebSocket Changes

`websocket.ts` already calls `getServerUrl()` from `api.ts` on each `doConnect()`, so it will automatically use the new runtime URL. No changes needed.

### 4. Connection Screen UI

A new page `ServerConnectPage.tsx` is shown when no server URL is configured (i.e., first launch or after disconnect):

**Layout:**
- Centered card (same style as LoginPage)
- Title: "Connect to Server"
- URL input field (pre-filled with default URL in dev, empty in production builds)
- "Connect" button
- Status/error display area

**Flow:**
1. User enters a URL (e.g., `https://mercury.example.com:8443`)
2. Client normalizes the URL: strips trailing slashes, ensures `https://` prefix
3. Client probes the server with a `GET /health` request (lightweight endpoint)
4. On success: saves the URL, transitions to login/register screen
5. On failure: shows error ("Could not reach server", "Invalid URL", etc.)

### 5. Health Check Endpoint

The client probes `GET {serverUrl}/health` to verify reachability. This is a quick connectivity + compatibility check before committing to the URL.

If the server doesn't have a `/health` endpoint yet, the client can fall back to attempting a connection and catching the error at login time. The probe is best-effort — its absence shouldn't block the flow.

### 6. App Navigation Flow

Updated flow in `App.tsx`:

```
App mounts
  → Has configured server URL?
    → No  → Show ServerConnectPage
    → Yes → Has stored auth tokens?
      → Yes → Hydrate and show ServerPage
      → No  → Show Login/Register
```

The `App.tsx` state machine adds a new top-level state:

```typescript
type AppView = 'connect' | 'login' | 'register' | 'app'
```

### 7. Changing / Disconnecting from Server

Add a "Change Server" option accessible from:
- The login/register screen (small link below the form, like "Switch to Register")
- A future settings panel (out of scope for now, but the function exists)

"Change Server" does:
1. Disconnect WebSocket
2. Clear auth tokens from localStorage
3. Clear the stored server URL
4. Return to `ServerConnectPage`

### 8. Auth State Isolation

When the server URL changes, all server-specific state must be cleared:
- Auth tokens (`mercury_access_token`, `mercury_refresh_token`)
- Device ID (`mercury_device_id`)
- Any crypto keys (they are tied to a device registration on a specific server)

This prevents token/key confusion between servers.

## Edge Cases

| Scenario | Behavior |
|---|---|
| User enters URL without `https://` | Auto-prepend `https://` |
| User enters URL with trailing slash | Strip trailing slash |
| User enters URL with path (e.g., `/api`) | Accept as-is (operator may reverse-proxy) |
| Server is unreachable at connect time | Show error, keep user on connect screen |
| Server becomes unreachable after login | Existing WebSocket reconnect logic handles this |
| User enters `http://` URL | Allow it (local/dev networks may not use TLS) |
| URL contains port | Accept as-is (`:8443`, `:443`, etc.) |
| VITE_SERVER_URL is set at build time | Used as the default in the URL input field |
| User clears localStorage externally | Falls back to default URL, shows connect screen |
| Crypto keys exist from a different server | Cleared on server URL change to prevent cross-server key reuse |

## Acceptance Criteria

1. **First launch**: App shows server connection screen before login
2. **URL persistence**: Configured URL survives app restart
3. **Validation**: Invalid URLs (empty, malformed) are rejected with clear error messages
4. **Reachability**: Client probes the server before accepting the URL
5. **Auth isolation**: Changing servers clears all auth and crypto state
6. **Dev unchanged**: With `VITE_SERVER_URL` set or on `localhost`, the default URL pre-fills and dev workflow is unaffected
7. **WebSocket**: After configuring a remote URL, WebSocket connects to the correct host
8. **Change server**: User can return to the connection screen from the login page
