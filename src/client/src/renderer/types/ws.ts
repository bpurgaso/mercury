import type { User, Server, Channel, PresenceStatus } from './models'

// Server → Client event names
export type ServerEventType =
  | 'READY'
  | 'RESUMED'
  | 'MESSAGE_CREATE'
  | 'TYPING_START'
  | 'PRESENCE_UPDATE'
  | 'VOICE_STATE_UPDATE'
  | 'CALL_STARTED'
  | 'CALL_ENDED'
  | 'WEBRTC_SIGNAL'
  | 'CALL_CONFIG'
  | 'HEARTBEAT_ACK'
  | 'KEY_BUNDLE_UPDATE'
  | 'DEVICE_LIST_UPDATE'
  | 'CHANNEL_CREATE'
  | 'CHANNEL_UPDATE'
  | 'CHANNEL_DELETE'
  | 'MEMBER_ADD'
  | 'MEMBER_REMOVE'
  | 'USER_BANNED'
  | 'USER_KICKED'
  | 'USER_MUTED'
  | 'USER_UNMUTED'
  | 'REPORT_CREATED'
  | 'ABUSE_SIGNAL'
  | 'ICE_DIAGNOSTIC'

// Client → Server op codes
export type ClientOp =
  | 'heartbeat'
  | 'identify'
  | 'resume'
  | 'message_send'
  | 'typing_start'
  | 'voice_state_update'
  | 'webrtc_signal'
  | 'presence_update'

// Server → Client message envelope
export interface ServerMessage {
  t: ServerEventType
  d: unknown
  seq: number | null
}

// Client → Server message envelope
export interface ClientMessage {
  op: ClientOp
  d: unknown
}

// Specific event payloads
export interface ReadyEvent {
  user: User
  servers: Server[]
  channels: Channel[]
  dm_channels: unknown[]
  session_id: string
  heartbeat_interval: number
}

export interface ResumedEvent {
  replayed_events: number
}

export interface MessageCreateEvent {
  id: string
  channel_id: string
  sender_id: string
  content: string | null
  created_at: string
}

export interface TypingStartEvent {
  channel_id: string
  user_id: string
}

export interface PresenceUpdateEvent {
  user_id: string
  status: PresenceStatus
}

export interface ChannelCreateEvent {
  id: string
  server_id: string
  name: string
  channel_type: 'text' | 'voice' | 'video'
  encryption_mode: 'standard' | 'private'
  position: number
  topic: string | null
  created_at: string | null
}

export interface ChannelUpdateEvent {
  id: string
  server_id: string
  name: string
  channel_type: 'text' | 'voice' | 'video'
  encryption_mode: 'standard' | 'private'
  position: number
  topic: string | null
  created_at: string | null
}

export interface ChannelDeleteEvent {
  id: string
  server_id: string
}

export interface MemberAddEvent {
  server_id: string
  user_id: string
}

export interface MemberRemoveEvent {
  server_id: string
  user_id: string
}

export interface HeartbeatAckEvent {
  // empty
}

// Typed event map for the WebSocket manager
export interface WSEventMap {
  READY: ReadyEvent
  RESUMED: ResumedEvent
  MESSAGE_CREATE: MessageCreateEvent
  TYPING_START: TypingStartEvent
  PRESENCE_UPDATE: PresenceUpdateEvent
  CHANNEL_CREATE: ChannelCreateEvent
  CHANNEL_UPDATE: ChannelUpdateEvent
  CHANNEL_DELETE: ChannelDeleteEvent
  MEMBER_ADD: MemberAddEvent
  MEMBER_REMOVE: MemberRemoveEvent
  HEARTBEAT_ACK: HeartbeatAckEvent
}
