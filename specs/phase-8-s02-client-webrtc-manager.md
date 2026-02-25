# Phase 8, Session 2: Client-Side WebRTC Manager

## Problem Statement

Mercury has server-side call signaling (Phase 8 SFU Media Engine) and WebSocket event types defined (VOICE_STATE_UPDATE, CALL_STARTED, CALL_ENDED, WEBRTC_SIGNAL, CALL_CONFIG), but no client-side WebRTC layer. Users cannot join voice/video calls because there is no PeerConnection lifecycle management, track handling, or call state store.

**Who has this problem?** Every Mercury user wanting voice/video communication.

## Proposed Solution

Build three components:
1. **callStore** (Zustand) — call state management (active call, streams, participants, mute/deafen/camera)
2. **WebRTCManager** service — PeerConnection lifecycle, track management, ICE handling, quality adaptation
3. **WebSocket event handlers** — extend the existing wsManager to route voice/call events to callStore and WebRTCManager

No E2E media encryption (Insertable Streams) — that comes in Session 3. No UI components — that comes in Session 4.

## Goals

1. Users can join a voice channel via `callStore.joinCall(channelId)` which orchestrates the full WebRTC flow
2. Users can leave cleanly via `callStore.leaveCall()` with full resource cleanup
3. Mute/deafen/camera toggles work correctly with proper signaling
4. Remote tracks from other participants are associated with userIds and stored in callStore
5. ICE candidates are relayed bidirectionally
6. CALL_CONFIG is parsed and applied to PeerConnection, getUserMedia constraints, and simulcast layers
7. Connection failures trigger diagnostic state (for Session 4 UI)
8. All specified Vitest unit tests pass

## Non-Goals

- E2E media encryption (Session 3)
- Voice/video UI components (Session 4)
- Screen sharing
- Device selection UI (future)
- Speaking indicators / audio level detection (future)

## Detailed Design

### 1. Types (`src/renderer/types/call.ts`)

```typescript
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
```

### 2. WebSocket Type Extensions (`src/renderer/types/ws.ts`)

Add typed event interfaces to WSEventMap:

```typescript
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
```

### 3. WebRTCManager Service (`src/renderer/services/webrtc.ts`)

Singleton class following the same pattern as WebSocketManager:

**State:**
- `pc: RTCPeerConnection | null`
- `localAudioTrack: MediaStreamTrack | null`
- `localVideoTrack: MediaStreamTrack | null`
- `callConfig: CallConfig | null`
- `connectionFailedTimer: ReturnType<typeof setTimeout> | null`
- Remote track/remove callbacks

**Methods:**

- `joinCall(roomId, channelId)`: Create RTCPeerConnection with ICE servers from callConfig, get local audio, add tracks, create offer, send via webrtc_signal
- `leaveCall()`: Stop all local tracks, close PC, clear state
- `enableMicrophone(deviceId?)`: getUserMedia audio, add track to PC
- `disableMicrophone()`: Stop audio track, remove from PC
- `enableCamera(deviceId?)`: getUserMedia video, add track to PC, renegotiate
- `disableCamera()`: Stop video track, remove from PC, renegotiate
- `handleSignal(signal)`: Process incoming SDP answer or ICE candidate
- `handleCallConfig(config)`: Store config, build ICE server array
- `setPreferredVideoQuality(quality)`: Adjust simulcast layer via sender.setParameters()
- `getConnectionStats()`: Return pc.getStats()

**PeerConnection event handlers:**
- `onicecandidate` → send candidate to server via webrtc_signal
- `ontrack` → associate with userId from signaling metadata, notify callStore
- `onconnectionstatechange` → handle connected/failed/disconnected states

**Track management rules:**
- Audio: mute/unmute via `track.enabled` (no renegotiation)
- Video: add/remove track dynamically (requires renegotiation via new offer/answer)
- Simulcast: if config has simulcast_enabled, configure 3 encoding layers on video sender

### 4. callStore (`src/renderer/stores/callStore.ts`)

Zustand store following existing patterns:

**State:**
- `activeCall: ActiveCall | null`
- `localStream: MediaStream | null`
- `remoteStreams: Map<string, MediaStream>` (userId → stream)
- `isMuted: boolean`
- `isDeafened: boolean`
- `isCameraOn: boolean`
- `participants: Map<string, ParticipantState>`
- `callConfig: CallConfig | null`
- `connectionState: string | null` ('new'|'connecting'|'connected'|'disconnected'|'failed')
- `diagnosticState: { failed: boolean; timestamp: number } | null`

**Actions:**
- `joinCall(channelId)`: Full flow — send voice_state_update → wait for CALL_CONFIG → create PC → getUserMedia → create offer → exchange SDP/ICE → connected
- `leaveCall()`: Close tracks → close PC → send voice_state_update { channel_id: null } → clear state
- `toggleMute()`: Toggle localAudioTrack.enabled → send voice_state_update
- `toggleDeafen()`: Mute all remote audio tracks → also self-mute → send voice_state_update
- `toggleCamera()`: Add/remove video track → renegotiate if needed
- `addRemoteStream(userId, stream)`: Update remoteStreams map
- `removeRemoteStream(userId)`: Remove from remoteStreams map
- `updateParticipant(userId, state)`: Update participants map
- `removeParticipant(userId)`: Remove from participants + remoteStreams
- `setConnectionState(state)`: Update connectionState, set diagnosticState on failure

### 5. WebSocket Event Handlers

Wire up in callStore initialization (subscribe to wsManager events):

- `VOICE_STATE_UPDATE` → update callStore.participants. If channel_id is null, remove participant.
- `CALL_STARTED` → if user is in that channel, update callStore (informational)
- `CALL_ENDED` → if user is in that call, clean up callStore
- `WEBRTC_SIGNAL` → route to webRTCManager.handleSignal()
- `CALL_CONFIG` → route to webRTCManager.handleCallConfig(), then callStore creates PC and begins offer

### 6. joinCall Detailed Flow

```
1. callStore.joinCall(channelId) called
2. Send voice_state_update { channel_id, self_mute: false, self_deaf: false } via wsManager
3. Wait for CALL_CONFIG event (with timeout)
4. Parse CALL_CONFIG → store in callStore, pass to webRTCManager
5. webRTCManager creates RTCPeerConnection with ICE servers:
   - STUN urls from config
   - TURN urls with username/credential from config
6. Get local audio: navigator.mediaDevices.getUserMedia({ audio: constraints })
   - Apply max bitrate from config
7. Add audio track to PeerConnection
8. Create SDP offer → send via webrtc_signal { room_id, signal: { type: 'offer', sdp } }
9. Receive WEBRTC_SIGNAL with answer → pc.setRemoteDescription(answer)
10. Exchange ICE candidates:
    - pc.onicecandidate → send via webrtc_signal
    - WEBRTC_SIGNAL with candidate → pc.addIceCandidate()
11. pc.onconnectionstatechange → 'connected' → update callStore
12. pc.ontrack → associate with userId → update callStore.remoteStreams
```

### 7. leaveCall Detailed Flow

```
1. callStore.leaveCall() called
2. webRTCManager.leaveCall():
   a. Stop all local tracks (audio + video)
   b. Close PeerConnection
   c. Clear PC reference and state
3. Send voice_state_update { channel_id: null } via wsManager
4. Clear callStore: activeCall=null, localStream=null, remoteStreams cleared,
   participants cleared, isMuted/isDeafened/isCameraOn reset
```

### 8. ICE Failure Handling

- `connectionState === 'failed'` after 10 seconds → set diagnosticState
- `connectionState === 'disconnected'` → attempt ICE restart via pc.restartIce()
- ICE restart: create new offer with iceRestart=true, send via webrtc_signal

## Edge Cases

1. **joinCall while already in a call**: Leave current call first, then join new one
2. **CALL_CONFIG timeout**: If no CALL_CONFIG received within 10 seconds, reject joinCall promise with error
3. **getUserMedia permission denied**: Catch error, leave call, surface error in callStore
4. **PeerConnection creation failure**: Catch error, send voice_state_update leave, surface error
5. **Camera toggle during no active call**: No-op
6. **Deafen then unmute**: Undeafening restores previous mute state
7. **Multiple rapid toggle calls**: Each toggle is synchronous on track.enabled, safe for rapid calls
8. **WebSocket disconnect during call**: Call continues (media flows via SFU), reconnect WS, re-sync state
9. **Remote participant leaves**: VOICE_STATE_UPDATE with null channel_id → remove from participants + remoteStreams

## Acceptance Criteria

1. callStore.joinCall() sends voice_state_update and creates PeerConnection with correct ICE servers from CALL_CONFIG
2. callStore.leaveCall() stops tracks, closes PC, sends voice_state_update with null channel_id
3. toggleMute() toggles track.enabled and sends voice_state_update
4. toggleDeafen() mutes all remote tracks + self, sends voice_state_update
5. toggleCamera() adds/removes video track with renegotiation
6. Remote tracks are associated with correct userId in callStore.remoteStreams
7. ICE candidates are relayed bidirectionally
8. CALL_CONFIG is parsed correctly and applied to ICE servers, audio/video constraints
9. Connection failure sets diagnosticState
10. All Vitest unit tests pass
