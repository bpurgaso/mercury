import type {
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  RefreshResponse,
  CreateServerRequest,
  UpdateServerRequest,
  JoinServerRequest,
  ServerResponse,
  CreateChannelRequest,
  UpdateChannelRequest,
  ChannelResponse,
  MessageHistoryParams,
  MessageResponse,
  UserResponse,
  DmChannelResponse,
  DmMessageResponse,
  UserKeyBundlesResponse,
  ClaimOtpResponse,
  DeviceListResponse,
  BlockedUsersResponse,
  ReportRequest,
  ReportResponse,
  ReportsListResponse,
  AuditLogResponse,
  ModerationKeyResponse,
  BansListResponse,
  AbuseSignalsResponse,
  UserModerationMetadataResponse,
} from '../types/api'

import { getConfiguredServerUrl } from './serverUrl'

type TokenProvider = {
  getAccessToken: () => string | null
  getRefreshToken: () => string | null
  onTokenRefreshed: (access: string, refresh: string) => void
  onAuthFailed: () => void
}

let tokenProvider: TokenProvider | null = null
let isRefreshing = false
let refreshPromise: Promise<boolean> | null = null

export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true
): Promise<T> {
  const url = `${getServerUrl()}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  const accessToken = tokenProvider?.getAccessToken()
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }

  const response = await fetch(url, {
    ...options,
    headers,
  })

  if (response.status === 401 && retry && tokenProvider) {
    const refreshed = await attemptRefresh()
    if (refreshed) {
      return request<T>(path, options, false)
    }
    tokenProvider.onAuthFailed()
    throw new ApiError('Authentication failed', 401)
  }

  if (!response.ok) {
    let errorBody: string
    try {
      const json = await response.json()
      errorBody = json.error || json.message || response.statusText
    } catch {
      errorBody = response.statusText
    }
    throw new ApiError(errorBody, response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

async function attemptRefresh(): Promise<boolean> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise
  }

  isRefreshing = true
  refreshPromise = doRefresh()
  const result = await refreshPromise
  isRefreshing = false
  refreshPromise = null
  return result
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = tokenProvider?.getRefreshToken()
  if (!refreshToken) return false

  try {
    const response = await fetch(`${getServerUrl()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    if (!response.ok) return false

    const data = (await response.json()) as RefreshResponse
    tokenProvider?.onTokenRefreshed(data.access_token, data.refresh_token)
    return true
  } catch {
    return false
  }
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// Auth endpoints
export const auth = {
  register: (data: RegisterRequest) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }, false),

  login: (data: LoginRequest) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }, false),

  refresh: (refreshToken: string) =>
    request<RefreshResponse>(
      '/auth/refresh',
      {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
      false
    ),

  logout: () =>
    request<void>('/auth/logout', { method: 'POST' }),
}

// User endpoints
export const users = {
  me: () => request<UserResponse>('/users/me'),
}

// Server endpoints
export const servers = {
  create: (data: CreateServerRequest) =>
    request<ServerResponse>('/servers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  list: () => request<ServerResponse[]>('/servers'),

  get: (id: string) => request<ServerResponse>(`/servers/${id}`),

  update: (id: string, data: UpdateServerRequest) =>
    request<ServerResponse>(`/servers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<void>(`/servers/${id}`, { method: 'DELETE' }),

  join: (data: JoinServerRequest) =>
    request<ServerResponse>('/servers/join', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  leave: (id: string) =>
    request<void>(`/servers/${id}/members/me`, { method: 'DELETE' }),

  listMembers: (id: string) =>
    request<Array<{ user_id: string }>>(`/servers/${id}/members`),
}

// Channel endpoints
export const channels = {
  create: (serverId: string, data: CreateChannelRequest) =>
    request<ChannelResponse>(`/servers/${serverId}/channels`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  list: (serverId: string) =>
    request<ChannelResponse[]>(`/servers/${serverId}/channels`),

  update: (id: string, data: UpdateChannelRequest) =>
    request<ChannelResponse>(`/channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<void>(`/channels/${id}`, { method: 'DELETE' }),
}

// Device / key bundle endpoints
export const devices = {
  register: (deviceName: string) =>
    request<{ device_id: string; device_name: string }>('/devices', {
      method: 'POST',
      body: JSON.stringify({ device_name: deviceName }),
    }),

  uploadKeyBundle: (deviceId: string, bundle: unknown) =>
    request<void>(`/devices/${deviceId}/keys`, {
      method: 'PUT',
      body: JSON.stringify(bundle),
    }),

  fetchKeyBundle: (userId: string, deviceId: string) =>
    request<unknown>(`/users/${userId}/devices/${deviceId}/keys`),
}

// Message endpoints
export const messages = {
  getHistory: (channelId: string, params?: MessageHistoryParams) => {
    const searchParams = new URLSearchParams()
    if (params?.before) searchParams.set('before', params.before)
    if (params?.after) searchParams.set('after', params.after)
    if (params?.limit) searchParams.set('limit', String(params.limit))
    const qs = searchParams.toString()
    const path = `/channels/${channelId}/messages${qs ? `?${qs}` : ''}`
    return request<MessageResponse[]>(path)
  },
}

// DM endpoints
export const dm = {
  create: (recipientId: string) =>
    request<DmChannelResponse>('/dm', {
      method: 'POST',
      body: JSON.stringify({ recipient_id: recipientId }),
    }),

  list: () => request<DmChannelResponse[]>('/dm'),

  getHistory: (dmChannelId: string, params?: MessageHistoryParams) => {
    const searchParams = new URLSearchParams()
    if (params?.before) searchParams.set('before', params.before)
    if (params?.after) searchParams.set('after', params.after)
    if (params?.limit) searchParams.set('limit', String(params.limit))
    const qs = searchParams.toString()
    const path = `/dm/${dmChannelId}/messages${qs ? `?${qs}` : ''}`
    return request<DmMessageResponse[]>(path)
  },
}

// Device list endpoints
export const deviceList = {
  fetch: (userId: string) =>
    request<DeviceListResponse>(`/users/${userId}/device-list`),

  upload: (data: { signed_list: string; master_verify_key: string; signature: string }) =>
    request<void>('/users/me/device-list', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
}

// Key bundle endpoints
export const keyBundles = {
  fetchAllForUser: (userId: string) =>
    request<UserKeyBundlesResponse>(`/users/${userId}/keys`),

  claimOtp: (userId: string, deviceId: string) =>
    request<ClaimOtpResponse>(`/users/${userId}/devices/${deviceId}/keys/one-time`, {
      method: 'POST',
    }),
}

// Sender key endpoints
export const senderKeys = {
  getPending: () =>
    request<Array<{
      message_id: string
      channel_id: string
      sender_id: string
      ciphertext: string
      created_at: string | null
    }>>('/sender-keys/pending'),

  acknowledge: (messageIds: string[]) =>
    request<void>('/sender-keys/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ message_ids: messageIds }),
    }),
}

// Moderation endpoints
export const moderation = {
  // User-level blocks
  getBlocks: () =>
    request<BlockedUsersResponse>('/users/me/blocks'),

  blockUser: (userId: string) =>
    request<void>(`/users/me/blocks/${userId}`, { method: 'PUT' }),

  unblockUser: (userId: string) =>
    request<void>(`/users/me/blocks/${userId}`, { method: 'DELETE' }),

  // DM policy
  setDmPolicy: (policy: string) =>
    request<void>('/users/me/dm-policy', {
      method: 'PUT',
      body: JSON.stringify({ dm_policy: policy }),
    }),

  // Reports
  submitReport: (data: ReportRequest) =>
    request<ReportResponse>('/reports', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getReports: (serverId: string) =>
    request<ReportsListResponse>(`/servers/${serverId}/reports`),

  reviewReport: (reportId: string, action: string) =>
    request<void>(`/reports/${reportId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    }),

  // Bans
  getBans: (serverId: string) =>
    request<BansListResponse>(`/servers/${serverId}/bans`),

  banUser: (serverId: string, userId: string, reason: string, expiresAt?: string) =>
    request<void>(`/servers/${serverId}/bans/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ reason, expires_at: expiresAt }),
    }),

  unbanUser: (serverId: string, userId: string) =>
    request<void>(`/servers/${serverId}/bans/${userId}`, { method: 'DELETE' }),

  // Kick
  kickUser: (serverId: string, userId: string, reason: string) =>
    request<void>(`/servers/${serverId}/kicks/${userId}`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // Mute
  muteInChannel: (channelId: string, userId: string, duration?: number) =>
    request<void>(`/channels/${channelId}/mutes/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ duration }),
    }),

  unmuteInChannel: (channelId: string, userId: string) =>
    request<void>(`/channels/${channelId}/mutes/${userId}`, { method: 'DELETE' }),

  // Audit log
  getAuditLog: (serverId: string) =>
    request<AuditLogResponse>(`/servers/${serverId}/audit-log`),

  // Abuse signals
  getAbuseSignals: (serverId: string) =>
    request<AbuseSignalsResponse>(`/servers/${serverId}/abuse-signals`),

  markAbuseSignalReviewed: (signalId: string) =>
    request<void>(`/abuse-signals/${signalId}/reviewed`, { method: 'POST' }),

  // Single report (for evidence blob)
  getReport: (reportId: string) =>
    request<ReportResponse>(`/reports/${reportId}`),

  // User moderation metadata
  getUserMetadata: (serverId: string, userId: string) =>
    request<UserModerationMetadataResponse>(`/servers/${serverId}/users/${userId}/moderation-metadata`),

  // Moderation key
  getModerationKey: (serverId: string) =>
    request<ModerationKeyResponse>(`/servers/${serverId}/moderation-key`),

  setModerationKey: (serverId: string, publicKey: string) =>
    request<void>(`/servers/${serverId}/moderation-key`, {
      method: 'PUT',
      body: JSON.stringify({ public_key: publicKey }),
    }),
}

export function getServerUrl(): string {
  return getConfiguredServerUrl()
}
