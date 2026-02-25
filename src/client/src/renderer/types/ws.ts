import type { User, Server, Channel, DmChannel, PresenceStatus } from './models'

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
  | 'SENDER_KEY_DISTRIBUTION'
  | 'MEDIA_KEY'
  | 'ERROR'
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
  | 'sender_key_distribute'
  | 'media_key_distribute'
  | 'ice_diagnostic'

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
  dm_channels: DmChannel[]
  session_id: string
  heartbeat_interval: number
}

export interface ResumedEvent {
  replayed_events: number
}

export interface MessageCreateEvent {
  id: string
  channel_id?: string        // present for standard/private channel messages
  dm_channel_id?: string     // present for DM messages
  sender_id: string
  sender_device_id?: string  // present for DM/private channel messages
  content?: string | null    // present for standard messages only
  ciphertext?: Uint8Array    // present for DM messages (from MessagePack binary frame)
  ratchet_header?: Uint8Array // serialized Double Ratchet header
  x3dh_header?: {
    sender_identity_key: Uint8Array
    ephemeral_key: Uint8Array
    prekey_id: number
  }
  encrypted?: {              // present for private channel messages
    ciphertext: Uint8Array
    nonce: Uint8Array
    signature: Uint8Array
    sender_device_id: string
    iteration: number
    epoch: number
  }
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

export interface SenderKeyDistributionEvent {
  channel_id: string
  sender_id: string
  sender_device_id: string
  ciphertext: Uint8Array
}

export interface HeartbeatAckEvent {
  // empty
}

export interface ServerErrorEvent {
  code: string    // e.g. 'STALE_SENDER_KEY'
  message: string
}

export interface VoiceStateUpdateEvent {
  user_id: string
  channel_id: string | null
  self_mute: boolean
  self_deaf: boolean
}

export interface CallStartedEvent {
  room_id: string
  channel_id: string
  initiator_id: string
}

export interface CallEndedEvent {
  room_id: string
}

export interface WebRTCSignalEvent {
  from_user: string
  signal: {
    type: 'offer' | 'answer' | 'ice_candidate'
    sdp?: string
    candidate?: string
  }
}

export interface MediaKeyEvent {
  room_id: string
  sender_id: string
  sender_device_id: string
  ciphertext: number[]  // DR-encrypted payload containing key + epoch
}

export interface CallConfigEvent {
  room_id: string
  turn_urls: string[]
  stun_urls: string[]
  username: string
  credential: string
  ttl: number
  audio: {
    max_bitrate_kbps: number
    preferred_bitrate_kbps: number
  }
  video: {
    max_bitrate_kbps: number
    max_resolution: string
    max_framerate: number
    simulcast_enabled?: boolean
    simulcast_layers?: {
      rid: string
      max_bitrate_kbps: number
      scale_down: number
    }[]
  }
}

export interface IceDiagnosticPayload {
  call_id: string
  stun: boolean
  turn_udp: boolean
  turn_tcp: boolean
  time_to_connected_ms: number | null
}

// Typed event map for the WebSocket manager
export interface WSEventMap {
  READY: ReadyEvent
  RESUMED: ResumedEvent
  MESSAGE_CREATE: MessageCreateEvent
  TYPING_START: TypingStartEvent
  PRESENCE_UPDATE: PresenceUpdateEvent
  VOICE_STATE_UPDATE: VoiceStateUpdateEvent
  CALL_STARTED: CallStartedEvent
  CALL_ENDED: CallEndedEvent
  WEBRTC_SIGNAL: WebRTCSignalEvent
  CALL_CONFIG: CallConfigEvent
  CHANNEL_CREATE: ChannelCreateEvent
  CHANNEL_UPDATE: ChannelUpdateEvent
  CHANNEL_DELETE: ChannelDeleteEvent
  MEMBER_ADD: MemberAddEvent
  MEMBER_REMOVE: MemberRemoveEvent
  SENDER_KEY_DISTRIBUTION: SenderKeyDistributionEvent
  MEDIA_KEY: MediaKeyEvent
  HEARTBEAT_ACK: HeartbeatAckEvent
  ERROR: ServerErrorEvent
}
