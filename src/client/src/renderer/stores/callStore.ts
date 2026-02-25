import { create } from 'zustand'
import type { ActiveCall, CallConfig, ParticipantState } from '../types/call'
import type {
  VoiceStateUpdateEvent,
  CallStartedEvent,
  CallEndedEvent,
  WebRTCSignalEvent,
  CallConfigEvent,
  MediaKeyEvent,
} from '../types/ws'
import { wsManager } from '../services/websocket'
import { webRTCManager, CALL_CONFIG_TIMEOUT_MS } from '../services/webrtc'
import { MediaKeyRing } from '../services/media-key-ring'
import { generateMediaKey, exportMediaKey, importMediaKey } from '../services/frame-crypto'
import { cryptoService } from '../services/crypto'
import { useAuthStore } from './authStore'
import { activeSpeakerDetector } from '../services/active-speaker'
import { audioCuePlayer } from '../services/audio-cues'

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
  // Track which channels have active calls (channelId → roomId)
  activeChannelCalls: Map<string, string>
  // Track who is speaking
  speakingUsers: Map<string, boolean>
  activeSpeakerId: string | null
  // Track voice channel participants globally (channelId → Set<userId>)
  voiceChannelParticipants: Map<string, Set<string>>

  joinCall(channelId: string): Promise<void>
  leaveCall(): Promise<void>
  toggleMute(): void
  toggleDeafen(): void
  toggleCamera(): Promise<void>
}

export const useCallStore = create<CallState>((set, get) => {
  // Internal state: was the user manually muted before deafening?
  let wasMutedBeforeDeafen = false

  // beforeunload handler reference for cleanup
  let beforeUnloadHandler: (() => void) | null = null

  // Send a webrtc_signal through the WebSocket
  function sendSignal(roomId: string, signal: { type: string; sdp?: string; candidate?: string }): void {
    wsManager.send('webrtc_signal', { room_id: roomId, signal })
  }

  // Helper to fully clean up call state (used by leaveCall and disconnect handler)
  function cleanUpCall(): void {
    const { activeCall } = get()

    // Stop active speaker detection
    activeSpeakerDetector.stop()

    webRTCManager.leaveCall()

    if (activeCall) {
      wsManager.send('voice_state_update', { channel_id: null })
    }

    // Remove beforeunload handler
    if (beforeUnloadHandler) {
      window.removeEventListener('beforeunload', beforeUnloadHandler)
      beforeUnloadHandler = null
    }

    wasMutedBeforeDeafen = false

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
      speakingUsers: new Map(),
      activeSpeakerId: null,
    })
  }

  // Encrypt a media key via DR and send the per-device payloads over WS
  function distributeMediaKeyViaWs(roomId: string, recipientIds: string[], key: number[], epoch: number): void {
    cryptoService.distributeMediaKey({ roomId, recipientIds, key, epoch })
      .then((res) => {
        if (res.recipients.length > 0) {
          wsManager.send('media_key_distribute', {
            room_id: roomId,
            recipients: res.recipients,
          })
        }
      })
      .catch(() => {
        // Silent — media key distribution is best-effort
      })
  }

  // Generate a new media key, rotate the keyRing, and distribute to all participants
  function rotateAndDistributeMediaKey(): void {
    const { activeCall, participants } = get()
    if (!activeCall) return

    const keyRing = webRTCManager.getMediaKeyRing()
    if (!keyRing) return

    generateMediaKey()
      .then(async (newKey) => {
        keyRing.rotateKey(newKey)
        const rawKey = await exportMediaKey(newKey)
        const participantIds = Array.from(participants.keys())
        if (participantIds.length > 0) {
          distributeMediaKeyViaWs(
            activeCall.roomId,
            participantIds,
            Array.from(rawKey),
            keyRing.currentEpoch,
          )
        }
      })
      .catch(() => {
        // Silent — rotation failure is non-fatal
      })
  }

  // Subscribe to WebSocket events for voice/call
  function setupWsListeners(): void {
    wsManager.on('VOICE_STATE_UPDATE', (data: VoiceStateUpdateEvent) => {
      const localUserId = useAuthStore.getState().user?.id
      // Skip events about ourselves
      if (data.user_id === localUserId) return

      // Update global voice channel participants tracking
      set((state) => {
        const voiceChannelParticipants = new Map(state.voiceChannelParticipants)

        // Remove user from all channels first
        for (const [chId, users] of voiceChannelParticipants) {
          const newSet = new Set(users)
          if (newSet.delete(data.user_id)) {
            if (newSet.size === 0) {
              voiceChannelParticipants.delete(chId)
            } else {
              voiceChannelParticipants.set(chId, newSet)
            }
          }
        }

        // Add to the new channel if not null
        if (data.channel_id !== null) {
          const existing = voiceChannelParticipants.get(data.channel_id) ?? new Set()
          const updated = new Set(existing)
          updated.add(data.user_id)
          voiceChannelParticipants.set(data.channel_id, updated)
        }

        return { voiceChannelParticipants }
      })

      const { activeCall } = get()
      if (!activeCall) return

      if (data.channel_id === null || data.channel_id !== activeCall.channelId) {
        // Participant left this call
        const wasInCall = get().participants.has(data.user_id)

        set((state) => {
          const participants = new Map(state.participants)
          participants.delete(data.user_id)
          const remoteStreams = new Map(state.remoteStreams)
          remoteStreams.delete(data.user_id)
          return { participants, remoteStreams }
        })

        // Play leave sound
        if (wasInCall) {
          audioCuePlayer.playLeave()
        }

        // Rotate key so the leaver cannot decrypt future frames
        if (localUserId) {
          const remainingIds = Array.from(get().participants.keys())
          const allIds = [...remainingIds, localUserId]
          allIds.sort()
          if (allIds[0] === localUserId) {
            rotateAndDistributeMediaKey()
          }
        }
      } else {
        // Participant joined or updated state in this call
        const isNewParticipant = !get().participants.has(data.user_id)

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

        // Play join sound for new participants
        if (isNewParticipant) {
          audioCuePlayer.playJoin()
        }

        // When a new participant joins, rotate key so they get a fresh key
        if (isNewParticipant) {
          if (localUserId) {
            const participantIds = Array.from(get().participants.keys())
            const allIds = [...participantIds, localUserId]
            allIds.sort()
            if (allIds[0] === localUserId) {
              rotateAndDistributeMediaKey()
            }
          }
        }
      }
    })

    wsManager.on('CALL_STARTED', (data: CallStartedEvent) => {
      set((state) => {
        const activeChannelCalls = new Map(state.activeChannelCalls)
        activeChannelCalls.set(data.channel_id, data.room_id)
        return { activeChannelCalls }
      })
    })

    wsManager.on('CALL_ENDED', (data: CallEndedEvent) => {
      const { activeCall } = get()

      // Remove from activeChannelCalls
      set((state) => {
        const activeChannelCalls = new Map(state.activeChannelCalls)
        // Find and remove the channel with this room_id
        for (const [channelId, roomId] of activeChannelCalls) {
          if (roomId === data.room_id) {
            activeChannelCalls.delete(channelId)
            break
          }
        }
        return { activeChannelCalls }
      })

      if (activeCall && activeCall.roomId === data.room_id) {
        activeSpeakerDetector.stop()
        webRTCManager.leaveCall()
        wasMutedBeforeDeafen = false

        if (beforeUnloadHandler) {
          window.removeEventListener('beforeunload', beforeUnloadHandler)
          beforeUnloadHandler = null
        }

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
          speakingUsers: new Map(),
          activeSpeakerId: null,
        })
      }
    })

    wsManager.on('WEBRTC_SIGNAL', (data: WebRTCSignalEvent) => {
      // Update track mapping from signaling metadata before handling the signal
      webRTCManager.updateTrackMappingFromSignal(data)
      webRTCManager.handleSignal(data.signal)
    })

    // Handle incoming media key distribution (DR-encrypted)
    wsManager.on('MEDIA_KEY', (data: MediaKeyEvent) => {
      const { activeCall } = get()
      if (!activeCall || activeCall.roomId !== data.room_id) return

      const keyRing = webRTCManager.getMediaKeyRing()
      if (!keyRing) return

      cryptoService.decryptMediaKey({
        senderId: data.sender_id,
        senderDeviceId: data.sender_device_id,
        ciphertext: data.ciphertext,
      }).then((res) => {
        if (res.error || !res.key) return
        return importMediaKey(new Uint8Array(res.key)).then((cryptoKey) => {
          if (keyRing.currentKey === null) {
            keyRing.setInitialKey(cryptoKey, res.epoch ?? 0)
          } else {
            keyRing.rotateKey(cryptoKey)
          }
        })
      }).catch(() => {
        // Failed to decrypt/import media key — ignore
      })
    })

    // Terminate call when WebSocket disconnects
    wsManager.onStateChange((state) => {
      if (state === 'DISCONNECTED') {
        const { activeCall } = get()
        if (activeCall) {
          activeSpeakerDetector.stop()
          webRTCManager.leaveCall()
          wasMutedBeforeDeafen = false

          if (beforeUnloadHandler) {
            window.removeEventListener('beforeunload', beforeUnloadHandler)
            beforeUnloadHandler = null
          }

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
            error: 'WebSocket disconnected',
            speakingUsers: new Map(),
            activeSpeakerId: null,
          })
        }
      }
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

      // Clear diagnosticState when connection recovers
      if (state === 'connected') {
        set({ diagnosticState: null })
      }
    })

    // Fire diagnosticState after the 10-second delay inside webRTCManager
    webRTCManager.onDiagnosticTimeout(() => {
      const currentCall = get().activeCall
      if (!currentCall) return

      set({
        diagnosticState: { failed: true, timestamp: Date.now() },
      })
    })
  }

  // Set up active speaker detection listener
  function setupSpeakerDetection(): void {
    activeSpeakerDetector.onSpeakingChange((speakers, loudestId) => {
      set({
        speakingUsers: speakers,
        activeSpeakerId: loudestId,
      })
    })
  }

  // Initialize listeners
  setupWsListeners()
  setupRemoteTrackListeners()
  setupSpeakerDetection()

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
    activeChannelCalls: new Map(),
    speakingUsers: new Map(),
    activeSpeakerId: null,
    voiceChannelParticipants: new Map(),

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

      // Step 3b: Set up media E2E encryption
      const keyRing = new MediaKeyRing()
      webRTCManager.setMediaKeyRing(keyRing)

      try {
        const mediaKey = await generateMediaKey()
        keyRing.setInitialKey(mediaKey, 0)

        // Distribute initial key to all current participants via DR-encrypted WS
        const participantIds = Array.from(get().participants.keys())
        if (participantIds.length > 0) {
          const rawKey = await exportMediaKey(mediaKey)
          distributeMediaKeyViaWs(roomId, participantIds, Array.from(rawKey), 0)
        }
      } catch {
        // Key generation/distribution failure is non-fatal for call setup.
        // Frames will be dropped until a key is established.
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

      // Step 5: Create and send SDP offer (wrapped in try/catch to prevent resource leak)
      try {
        const offer = await webRTCManager.createOffer()
        sendSignal(roomId, { type: 'offer', sdp: offer.sdp! })
      } catch (err) {
        webRTCManager.leaveCall()
        wsManager.send('voice_state_update', { channel_id: null })
        const message = err instanceof Error ? err.message : 'SDP offer creation failed'
        set({ error: message })
        throw err
      }

      // Step 6: Update store state
      set({
        activeCall: { roomId, channelId, joinedAt: Date.now() },
        localStream,
        connectionState: pc.connectionState,
      })

      // Step 7: Start active speaker detection
      const localUserId = useAuthStore.getState().user?.id
      if (localUserId) {
        activeSpeakerDetector.start(localUserId, () => ({
          localStream: get().localStream,
          remoteStreams: get().remoteStreams,
        }))
      }

      // Step 8: Register beforeunload handler
      beforeUnloadHandler = () => {
        cleanUpCall()
      }
      window.addEventListener('beforeunload', beforeUnloadHandler)
    },

    async leaveCall() {
      cleanUpCall()
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
      const { isDeafened, isMuted, activeCall } = get()
      if (!activeCall) return

      const newDeafened = !isDeafened

      if (newDeafened) {
        // Deafening: save current mute state, then mute self + disable remote audio
        wasMutedBeforeDeafen = isMuted
        webRTCManager.setRemoteAudioEnabled(false)
        webRTCManager.setMuted(true)
        set({ isDeafened: true, isMuted: true })

        wsManager.send('voice_state_update', {
          channel_id: activeCall.channelId,
          self_mute: true,
          self_deaf: true,
        })
      } else {
        // Undeafening: restore remote audio and previous mute state
        webRTCManager.setRemoteAudioEnabled(true)
        const restoreMuted = wasMutedBeforeDeafen
        webRTCManager.setMuted(restoreMuted)
        set({ isDeafened: false, isMuted: restoreMuted })
        wasMutedBeforeDeafen = false

        wsManager.send('voice_state_update', {
          channel_id: activeCall.channelId,
          self_mute: restoreMuted,
          self_deaf: false,
        })
      }
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
