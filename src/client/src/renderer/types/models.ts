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
  decrypt_error?: 'NO_SESSION' | 'DECRYPT_FAILED'
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
