export interface User {
  id: string
  username: string
  display_name: string
  email: string
  avatar_url: string | null
  status: string | null
  created_at: string | null
}

export interface Server {
  id: string
  name: string
  description: string | null
  icon_url: string | null
  owner_id: string
  invite_code: string
  max_members: number | null
  created_at: string | null
}

export interface Channel {
  id: string
  server_id: string
  name: string
  channel_type: 'text' | 'voice' | 'video'
  encryption_mode: 'standard' | 'private'
  sender_key_epoch?: number  // present for private channels
  position: number
  topic: string | null
  created_at: string | null
}

export interface Message {
  id: string
  channel_id: string | null
  dm_channel_id?: string     // present for DM messages
  sender_id: string
  content: string | null
  message_type: string | null
  created_at: string | null
  edited_at: string | null
  // Set when decryption fails
  decrypt_error?: 'NO_SESSION' | 'DECRYPT_FAILED' | 'MISSING_SENDER_KEY'
  // Populated client-side from user data
  sender_username?: string
  sender_avatar_url?: string | null
}

export interface DmChannel {
  id: string
  recipient: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
  }
  created_at: string | null
}

export interface ServerMember {
  user_id: string
  server_id: string
  nickname: string | null
  is_moderator: boolean
  joined_at: string | null
}

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

export interface UserPresence {
  user_id: string
  status: PresenceStatus
  last_seen?: string
}

export interface AuthTokens {
  access_token: string
  refresh_token: string
}

// Moderation types

export type ReportCategory = 'spam' | 'harassment' | 'illegal' | 'csam' | 'other'

export interface Report {
  id: string
  server_id: string
  reporter_id: string
  reported_user_id: string
  message_id?: string
  channel_id?: string
  category: ReportCategory
  description: string
  evidence_blob?: string  // base64-encoded encrypted evidence
  status: 'pending' | 'reviewed' | 'dismissed'
  action_taken?: string
  created_at: string
  reviewed_at?: string
}

export interface AbuseSignal {
  id: string
  server_id: string
  user_id: string
  signal_type: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  details: string  // JSON string — parse for display
  auto_action?: string
  reviewed: boolean
  created_at: string
}

export interface Ban {
  server_id: string
  user_id: string
  reason: string
  banned_by: string
  expires_at?: string
  created_at: string
}

export interface AuditLogEntry {
  id: string
  server_id: string
  actor_id: string
  action: string
  target_user_id?: string
  reason?: string
  metadata?: Record<string, unknown>
  created_at: string
}

export interface ReportSubmission {
  reportedUserId: string
  messageId?: string
  channelId?: string
  serverId?: string
  category: ReportCategory
  description: string
  includeEvidence: boolean
  evidenceBlob?: string  // base64-encoded encrypted evidence
}

export interface UserModerationMetadata {
  user_id: string
  username: string
  account_created_at: string
  server_joined_at: string
  message_count_30d: number
  report_count_total: number
  report_count_recent: number
  active_abuse_signals: number
  previous_actions: AuditLogEntry[]
}
