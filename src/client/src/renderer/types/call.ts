export interface ActiveCall {
  roomId: string
  channelId: string
}

export interface ParticipantState {
  userId: string
  selfMute: boolean
  selfDeaf: boolean
  hasAudio: boolean
  hasVideo: boolean
}

export interface CallConfig {
  roomId: string
  turnUrls: string[]
  stunUrls: string[]
  username: string
  credential: string
  ttl: number
  audio: {
    maxBitrateKbps: number
    preferredBitrateKbps: number
  }
  video: {
    maxBitrateKbps: number
    maxResolution: string
    maxFramerate: number
    simulcastEnabled?: boolean
    simulcastLayers?: SimulcastLayer[]
  }
}

export interface SimulcastLayer {
  rid: string
  maxBitrateKbps: number
  scaleDown: number
}

export interface WebRTCSignalData {
  type: 'offer' | 'answer' | 'ice_candidate'
  sdp?: string
  candidate?: string
}
