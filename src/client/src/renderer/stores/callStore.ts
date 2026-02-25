import { create } from 'zustand'
import type { ActiveCall, CallConfig, ParticipantState } from '../types/call'
import type {
  VoiceStateUpdateEvent,
  CallStartedEvent,
  CallEndedEvent,
  WebRTCSignalEvent,
  CallConfigEvent,
} from '../types/ws'
import { wsManager } from '../services/websocket'
import { webRTCManager, CALL_CONFIG_TIMEOUT_MS } from '../services/webrtc'

interface DiagnosticState {
  failed: boolean
  timestamp: number
}

interface CallState {
  activeCall: ActiveCall | null
  localStream: MediaStream | null
  remoteStreams: Map<string, MediaStream>
  isMuted: boolean
  isDeafened: boolean
  isCameraOn: boolean
  participants: Map<string, ParticipantState>
  callConfig: CallConfig | null
  connectionState: RTCPeerConnectionState | null
  diagnosticState: DiagnosticState | null
  error: string | null

  joinCall(channelId: string): Promise<void>
  leaveCall(): Promise<void>
  toggleMute(): void
  toggleDeafen(): void
  toggleCamera(): Promise<void>
}

export const useCallStore = create<CallState>((set, get) => {
  // Send a webrtc_signal through the WebSocket
  function sendSignal(roomId: string, signal: { type: string; sdp?: string; candidate?: string }): void {
    wsManager.send('webrtc_signal', { room_id: roomId, signal })
  }

  // Subscribe to WebSocket events for voice/call
  function setupWsListeners(): void {
    wsManager.on('VOICE_STATE_UPDATE', (data: VoiceStateUpdateEvent) => {
      const { activeCall } = get()
      if (!activeCall) return

      if (data.channel_id === null || data.channel_id !== activeCall.channelId) {
        // Participant left this call
        set((state) => {
          const participants = new Map(state.participants)
          participants.delete(data.user_id)
          const remoteStreams = new Map(state.remoteStreams)
          remoteStreams.delete(data.user_id)
          return { participants, remoteStreams }
        })
      } else {
        // Participant updated state in this call
        set((state) => {
          const participants = new Map(state.participants)
          const existing = participants.get(data.user_id)
          participants.set(data.user_id, {
            userId: data.user_id,
            selfMute: data.self_mute,
            selfDeaf: data.self_deaf,
            hasAudio: existing?.hasAudio ?? false,
            hasVideo: existing?.hasVideo ?? false,
          })
          return { participants }
        })
      }
    })

    wsManager.on('CALL_ENDED', (data: CallEndedEvent) => {
      const { activeCall } = get()
      if (activeCall && activeCall.roomId === data.room_id) {
        webRTCManager.leaveCall()
        set({
          activeCall: null,
          localStream: null,
          remoteStreams: new Map(),
          isMuted: false,
          isDeafened: false,
          isCameraOn: false,
          participants: new Map(),
          callConfig: null,
          connectionState: null,
          diagnosticState: null,
          error: null,
        })
      }
    })

    wsManager.on('WEBRTC_SIGNAL', (data: WebRTCSignalEvent) => {
      webRTCManager.handleSignal(data.signal)
    })
  }

  // Set up remote track handling
  function setupRemoteTrackListeners(): void {
    webRTCManager.onRemoteTrack((userId, track, stream) => {
      set((state) => {
        const remoteStreams = new Map(state.remoteStreams)
        const existing = remoteStreams.get(userId)
        if (existing) {
          existing.addTrack(track)
        } else {
          remoteStreams.set(userId, stream)
        }

        // Update participant hasAudio/hasVideo
        const participants = new Map(state.participants)
        const participant = participants.get(userId)
        if (participant) {
          participants.set(userId, {
            ...participant,
            hasAudio: participant.hasAudio || track.kind === 'audio',
            hasVideo: participant.hasVideo || track.kind === 'video',
          })
        }

        // If deafened, mute incoming audio tracks
        if (state.isDeafened && track.kind === 'audio') {
          track.enabled = false
        }

        return { remoteStreams, participants }
      })
    })

    webRTCManager.onRemoteTrackRemoved((userId, _trackId) => {
      set((state) => {
        const remoteStreams = new Map(state.remoteStreams)
        const stream = remoteStreams.get(userId)
        if (stream && stream.getTracks().length === 0) {
          remoteStreams.delete(userId)
        }
        return { remoteStreams }
      })
    })

    webRTCManager.onConnectionStateChange((state) => {
      const currentCall = get().activeCall
      if (!currentCall) return

      set({ connectionState: state })

      if (state === 'failed') {
        set({
          diagnosticState: { failed: true, timestamp: Date.now() },
        })
      } else if (state === 'connected') {
        set({ diagnosticState: null })
      }
    })
  }

  // Initialize listeners
  setupWsListeners()
  setupRemoteTrackListeners()

  return {
    activeCall: null,
    localStream: null,
    remoteStreams: new Map(),
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    participants: new Map(),
    callConfig: null,
    connectionState: null,
    diagnosticState: null,
    error: null,

    async joinCall(channelId: string) {
      const { activeCall } = get()

      // If already in a call, leave first
      if (activeCall) {
        await get().leaveCall()
      }

      set({ error: null })

      // Step 1: Send voice_state_update to join
      wsManager.send('voice_state_update', {
        channel_id: channelId,
        self_mute: false,
        self_deaf: false,
      })

      // Step 2: Wait for CALL_CONFIG
      let config: CallConfig
      try {
        config = await new Promise<CallConfig>((resolve, reject) => {
          const timer = setTimeout(() => {
            unsub()
            reject(new Error('CALL_CONFIG timeout'))
          }, CALL_CONFIG_TIMEOUT_MS)

          const unsub = wsManager.on('CALL_CONFIG', (data: CallConfigEvent) => {
            clearTimeout(timer)
            unsub()
            const parsed = webRTCManager.handleCallConfig(data)
            resolve(parsed)
          })
        })
      } catch (err) {
        // Timeout — send leave and surface error
        wsManager.send('voice_state_update', { channel_id: null })
        const message = err instanceof Error ? err.message : 'CALL_CONFIG timeout'
        set({ error: message })
        throw err
      }

      set({ callConfig: config })

      // Step 3: Create PeerConnection
      const roomId = config.roomId
      const signalFn = (signal: { type: string; sdp?: string; candidate?: string }) => {
        sendSignal(roomId, signal)
      }

      let pc: RTCPeerConnection
      try {
        pc = await webRTCManager.createPeerConnection(config, signalFn)
      } catch (err) {
        wsManager.send('voice_state_update', { channel_id: null })
        const message = err instanceof Error ? err.message : 'PeerConnection creation failed'
        set({ error: message })
        throw err
      }

      // Step 4: Get local audio
      let audioTrack: MediaStreamTrack
      try {
        audioTrack = await webRTCManager.enableMicrophone()
      } catch (err) {
        webRTCManager.leaveCall()
        wsManager.send('voice_state_update', { channel_id: null })
        const message = err instanceof Error ? err.message : 'Microphone access denied'
        set({ error: message })
        throw err
      }

      const localStream = new MediaStream([audioTrack])

      // Step 5: Create and send SDP offer
      const offer = await webRTCManager.createOffer()
      sendSignal(roomId, { type: 'offer', sdp: offer.sdp! })

      // Step 6: Update store state
      set({
        activeCall: { roomId, channelId },
        localStream,
        connectionState: pc.connectionState,
      })
    },

    async leaveCall() {
      const { activeCall } = get()

      // Clean up WebRTC resources
      webRTCManager.leaveCall()

      // Notify server
      if (activeCall) {
        wsManager.send('voice_state_update', { channel_id: null })
      }

      // Clear store state
      set({
        activeCall: null,
        localStream: null,
        remoteStreams: new Map(),
        isMuted: false,
        isDeafened: false,
        isCameraOn: false,
        participants: new Map(),
        callConfig: null,
        connectionState: null,
        diagnosticState: null,
        error: null,
      })
    },

    toggleMute() {
      const { isMuted, isDeafened, activeCall } = get()
      if (!activeCall) return

      const newMuted = !isMuted
      webRTCManager.setMuted(newMuted)
      set({ isMuted: newMuted })

      wsManager.send('voice_state_update', {
        channel_id: activeCall.channelId,
        self_mute: newMuted,
        self_deaf: isDeafened,
      })
    },

    toggleDeafen() {
      const { isDeafened, activeCall } = get()
      if (!activeCall) return

      const newDeafened = !isDeafened

      // When deafening: also mute self. When undeafening: unmute self.
      webRTCManager.setRemoteAudioEnabled(!newDeafened)
      webRTCManager.setMuted(newDeafened)

      set({
        isDeafened: newDeafened,
        isMuted: newDeafened ? true : get().isMuted,
      })

      // If undeafening, restore isMuted to false (spec: deafen also mutes,
      // undeafen restores unmuted)
      if (!newDeafened) {
        set({ isMuted: false })
        webRTCManager.setMuted(false)
      }

      wsManager.send('voice_state_update', {
        channel_id: activeCall.channelId,
        self_mute: newDeafened ? true : false,
        self_deaf: newDeafened,
      })
    },

    async toggleCamera() {
      const { isCameraOn, activeCall } = get()
      if (!activeCall) return

      const roomId = activeCall.roomId
      const signalFn = (signal: { type: string; sdp?: string }) => {
        sendSignal(roomId, signal)
      }

      if (isCameraOn) {
        await webRTCManager.disableCamera(signalFn)
        set((state) => {
          const localStream = state.localStream
          if (localStream) {
            // Remove video tracks from localStream
            for (const t of localStream.getVideoTracks()) {
              localStream.removeTrack(t)
            }
          }
          return { isCameraOn: false, localStream }
        })
      } else {
        const videoTrack = await webRTCManager.enableCamera(undefined, signalFn)
        set((state) => {
          const localStream = state.localStream || new MediaStream()
          localStream.addTrack(videoTrack)
          return { isCameraOn: true, localStream }
        })
      }
    },
  }
})
