import type { CallConfig, SimulcastLayer } from '../types/call'
import type { CallConfigEvent, WebRTCSignalEvent } from '../types/ws'
import type { MediaKeyRing } from './media-key-ring'
import { createSenderTransform, createReceiverTransform } from './frame-crypto'

type RemoteTrackCallback = (userId: string, track: MediaStreamTrack, stream: MediaStream) => void
type RemoteTrackRemovedCallback = (userId: string, trackId: string) => void
type ConnectionStateCallback = (state: RTCPeerConnectionState) => void
type DiagnosticCallback = () => void

const CALL_CONFIG_TIMEOUT_MS = 10_000
const CONNECTION_FAILURE_DELAY_MS = 10_000

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null
  private localAudioTrack: MediaStreamTrack | null = null
  private localVideoTrack: MediaStreamTrack | null = null
  private callConfig: CallConfig | null = null
  private connectionFailedTimer: ReturnType<typeof setTimeout> | null = null
  private roomId: string | null = null
  private sendSignalFn: ((signal: { type: string; sdp?: string; candidate?: string }) => void) | null = null
  private keyRing: MediaKeyRing | null = null

  private remoteTrackCallbacks = new Set<RemoteTrackCallback>()
  private remoteTrackRemovedCallbacks = new Set<RemoteTrackRemovedCallback>()
  private connectionStateCallbacks = new Set<ConnectionStateCallback>()
  private diagnosticCallbacks = new Set<DiagnosticCallback>()

  // Track userId associations from signaling metadata
  private pendingTrackUserMap = new Map<string, string>() // mid → userId

  // Negotiation queue to serialize offer/answer exchanges
  private negotiationQueue: Promise<void> = Promise.resolve()

  onRemoteTrack(cb: RemoteTrackCallback): () => void {
    this.remoteTrackCallbacks.add(cb)
    return () => { this.remoteTrackCallbacks.delete(cb) }
  }

  onRemoteTrackRemoved(cb: RemoteTrackRemovedCallback): () => void {
    this.remoteTrackRemovedCallbacks.add(cb)
    return () => { this.remoteTrackRemovedCallbacks.delete(cb) }
  }

  onConnectionStateChange(cb: ConnectionStateCallback): () => void {
    this.connectionStateCallbacks.add(cb)
    return () => { this.connectionStateCallbacks.delete(cb) }
  }

  onDiagnosticTimeout(cb: DiagnosticCallback): () => void {
    this.diagnosticCallbacks.add(cb)
    return () => { this.diagnosticCallbacks.delete(cb) }
  }

  setMediaKeyRing(keyRing: MediaKeyRing): void {
    this.keyRing = keyRing
  }

  getMediaKeyRing(): MediaKeyRing | null {
    return this.keyRing
  }

  /**
   * Apply an encryption transform to an outgoing sender using Insertable Streams.
   * Must be called after addTrack() and before negotiation completes.
   */
  applySenderTransform(sender: RTCRtpSender): void {
    if (!this.keyRing) return
    // createEncodedStreams() returns { readable, writable } for encoded frames
    const senderStreams = (sender as RTCRtpSender & {
      createEncodedStreams: () => { readable: ReadableStream; writable: WritableStream }
    }).createEncodedStreams()

    const transform = createSenderTransform(this.keyRing)
    senderStreams.readable.pipeThrough(transform).pipeTo(senderStreams.writable)
  }

  /**
   * Apply a decryption transform to an incoming receiver using Insertable Streams.
   */
  applyReceiverTransform(receiver: RTCRtpReceiver): void {
    if (!this.keyRing) return
    const receiverStreams = (receiver as RTCRtpReceiver & {
      createEncodedStreams: () => { readable: ReadableStream; writable: WritableStream }
    }).createEncodedStreams()

    const transform = createReceiverTransform(this.keyRing)
    receiverStreams.readable.pipeThrough(transform).pipeTo(receiverStreams.writable)
  }

  handleCallConfig(event: CallConfigEvent): CallConfig {
    const config: CallConfig = {
      roomId: event.room_id,
      turnUrls: event.turn_urls,
      stunUrls: event.stun_urls,
      username: event.username,
      credential: event.credential,
      ttl: event.ttl,
      audio: {
        maxBitrateKbps: event.audio.max_bitrate_kbps,
        preferredBitrateKbps: event.audio.preferred_bitrate_kbps,
      },
      video: {
        maxBitrateKbps: event.video.max_bitrate_kbps,
        maxResolution: event.video.max_resolution,
        maxFramerate: event.video.max_framerate,
        simulcastEnabled: event.video.simulcast_enabled,
        simulcastLayers: event.video.simulcast_layers?.map((l) => ({
          rid: l.rid,
          maxBitrateKbps: l.max_bitrate_kbps,
          scaleDown: l.scale_down,
        })),
      },
    }
    this.callConfig = config
    return config
  }

  /**
   * Extract mid→userId mappings from WEBRTC_SIGNAL events.
   * The SFU embeds the source userId in each signal. When we receive an
   * answer or offer, we parse the SDP to discover which mids map to which
   * remote user. For ICE candidates, we associate the sdpMid with the user.
   */
  updateTrackMappingFromSignal(signal: WebRTCSignalEvent): void {
    const fromUser = signal.from_user
    if (!fromUser) return

    if ((signal.signal.type === 'answer' || signal.signal.type === 'offer') && signal.signal.sdp) {
      // Parse SDP for m= lines to extract mid values.
      // Each m= section has an a=mid:<value> line.
      const sdp = signal.signal.sdp
      const midMatches = sdp.matchAll(/^a=mid:(.+)$/gm)
      for (const match of midMatches) {
        const mid = match[1].trim()
        // Map this mid to the from_user (the SFU relays on behalf of this user)
        this.pendingTrackUserMap.set(mid, fromUser)
      }
    } else if (signal.signal.type === 'ice_candidate' && signal.signal.candidate) {
      // For ICE candidates, associate via sdpMid if present
      try {
        const parsed = JSON.parse(signal.signal.candidate) as { sdpMid?: string }
        if (parsed.sdpMid) {
          this.pendingTrackUserMap.set(parsed.sdpMid, fromUser)
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  async createPeerConnection(
    config: CallConfig,
    sendSignal: (signal: { type: string; sdp?: string; candidate?: string }) => void
  ): Promise<RTCPeerConnection> {
    const iceServers: RTCIceServer[] = []

    if (config.stunUrls.length > 0) {
      iceServers.push({ urls: config.stunUrls })
    }
    if (config.turnUrls.length > 0) {
      iceServers.push({
        urls: config.turnUrls,
        username: config.username,
        credential: config.credential,
      })
    }

    const pc = new RTCPeerConnection({ iceServers })
    this.pc = pc
    this.roomId = config.roomId
    this.sendSignalFn = sendSignal

    // Expose PeerConnection for E2E test introspection via getStats()
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__mercury_pc = pc
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'ice_candidate',
          candidate: JSON.stringify(event.candidate.toJSON()),
        })
      }
    }

    pc.ontrack = (event) => {
      // Apply decryption transform to incoming receiver
      this.applyReceiverTransform(event.receiver)

      const stream = event.streams[0] || new MediaStream([event.track])
      // Derive userId from signaling metadata (mid → userId mapping)
      const mid = event.transceiver.mid
      const userId = (mid && this.pendingTrackUserMap.get(mid)) || 'unknown'

      for (const cb of this.remoteTrackCallbacks) {
        try {
          cb(userId, event.track, stream)
        } catch {
          // ignore listener errors
        }
      }

      // Handle track ended
      event.track.onended = () => {
        for (const cb of this.remoteTrackRemovedCallbacks) {
          try {
            cb(userId, event.track.id)
          } catch {
            // ignore
          }
        }
      }
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      this.handleConnectionStateChange(state, pc)
      for (const cb of this.connectionStateCallbacks) {
        try {
          cb(state)
        } catch {
          // ignore
        }
      }
    }

    return pc
  }

  async enableMicrophone(deviceId?: string): Promise<MediaStreamTrack> {
    const constraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true }
    if (deviceId) {
      constraints.deviceId = { exact: deviceId }
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
    const track = stream.getAudioTracks()[0]
    this.localAudioTrack = track

    if (this.pc) {
      const sender = this.pc.addTrack(track, stream)
      this.applySenderTransform(sender as unknown as RTCRtpSender)
      await this.applyAudioBitrate()
    }

    return track
  }

  disableMicrophone(): void {
    if (this.localAudioTrack) {
      this.localAudioTrack.stop()
      if (this.pc) {
        const sender = this.findSender(this.localAudioTrack)
        if (sender) {
          this.pc.removeTrack(sender)
        }
      }
      this.localAudioTrack = null
    }
  }

  async enableCamera(
    deviceId?: string,
    sendSignal?: (signal: { type: string; sdp?: string }) => void
  ): Promise<MediaStreamTrack> {
    const constraints: MediaTrackConstraints = {}
    if (deviceId) {
      constraints.deviceId = { exact: deviceId }
    }

    // Apply video constraints from CALL_CONFIG
    if (this.callConfig?.video) {
      const res = this.callConfig.video.maxResolution
      if (res) {
        const [w, h] = res.split('x').map(Number)
        if (w && h) {
          constraints.width = { max: w }
          constraints.height = { max: h }
        }
      }
      if (this.callConfig.video.maxFramerate) {
        constraints.frameRate = { max: this.callConfig.video.maxFramerate }
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia({ video: constraints })
    const track = stream.getVideoTracks()[0]
    this.localVideoTrack = track

    if (this.pc) {
      const sender = this.pc.addTrack(track, stream)
      this.applySenderTransform(sender as unknown as RTCRtpSender)
      await this.configureSimulcast()

      // Video add requires renegotiation — serialized through queue
      if (sendSignal) {
        await this.enqueueNegotiation(() => this.renegotiate(sendSignal))
      }
    }

    return track
  }

  async disableCamera(
    sendSignal?: (signal: { type: string; sdp?: string }) => void
  ): Promise<void> {
    if (this.localVideoTrack) {
      this.localVideoTrack.stop()
      if (this.pc) {
        const sender = this.findSender(this.localVideoTrack)
        if (sender) {
          this.pc.removeTrack(sender)
        }

        // Video remove requires renegotiation — serialized through queue
        if (sendSignal) {
          await this.enqueueNegotiation(() => this.renegotiate(sendSignal))
        }
      }
      this.localVideoTrack = null
    }
  }

  setMuted(muted: boolean): void {
    if (this.localAudioTrack) {
      this.localAudioTrack.enabled = !muted
    }
  }

  setRemoteAudioEnabled(enabled: boolean): void {
    if (!this.pc) return
    for (const receiver of this.pc.getReceivers()) {
      if (receiver.track && receiver.track.kind === 'audio') {
        receiver.track.enabled = enabled
      }
    }
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) throw new Error('No PeerConnection')
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    return offer
  }

  /**
   * Handle an incoming signal from the SFU. Supports answer, offer
   * (SFU-initiated renegotiation), and ICE candidates.
   */
  async handleSignal(signal: { type: string; sdp?: string; candidate?: string }): Promise<void> {
    if (!this.pc) return

    if (signal.type === 'answer' && signal.sdp) {
      await this.pc.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: signal.sdp,
      }))
    } else if (signal.type === 'offer' && signal.sdp) {
      // SFU-initiated renegotiation: new participant tracks available
      await this.enqueueNegotiation(async () => {
        if (!this.pc) return
        await this.pc.setRemoteDescription(new RTCSessionDescription({
          type: 'offer',
          sdp: signal.sdp!,
        }))
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        if (this.sendSignalFn) {
          this.sendSignalFn({ type: 'answer', sdp: answer.sdp })
        }
      })
    } else if (signal.type === 'ice_candidate' && signal.candidate) {
      const candidateInit = JSON.parse(signal.candidate) as RTCIceCandidateInit
      await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit))
    }
  }

  async restartIce(
    sendSignal: (signal: { type: string; sdp?: string }) => void
  ): Promise<void> {
    if (!this.pc) return
    this.pc.restartIce()
    const offer = await this.pc.createOffer({ iceRestart: true })
    await this.pc.setLocalDescription(offer)
    sendSignal({ type: 'offer', sdp: offer.sdp })
  }

  setPreferredVideoQuality(quality: 'high' | 'medium' | 'low'): void {
    if (!this.pc) return

    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) continue

      for (const encoding of params.encodings) {
        if (encoding.rid === quality) {
          encoding.active = true
        } else if (encoding.rid) {
          // Deactivate layers above the preferred quality
          const order = ['low', 'medium', 'high']
          const preferredIdx = order.indexOf(quality)
          const thisIdx = order.indexOf(encoding.rid)
          encoding.active = thisIdx <= preferredIdx
        }
      }
      sender.setParameters(params)
    }
  }

  async getConnectionStats(): Promise<RTCStatsReport | null> {
    if (!this.pc) return null
    return this.pc.getStats()
  }

  setTrackUserMapping(mid: string, userId: string): void {
    this.pendingTrackUserMap.set(mid, userId)
  }

  getRoomId(): string | null {
    return this.roomId
  }

  getCallConfig(): CallConfig | null {
    return this.callConfig
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.pc
  }

  getLocalAudioTrack(): MediaStreamTrack | null {
    return this.localAudioTrack
  }

  getLocalVideoTrack(): MediaStreamTrack | null {
    return this.localVideoTrack
  }

  leaveCall(): void {
    this.clearConnectionFailedTimer()

    if (this.localAudioTrack) {
      this.localAudioTrack.stop()
      this.localAudioTrack = null
    }
    if (this.localVideoTrack) {
      this.localVideoTrack.stop()
      this.localVideoTrack = null
    }
    if (this.pc) {
      this.pc.onicecandidate = null
      this.pc.ontrack = null
      this.pc.onconnectionstatechange = null
      this.pc.close()
      this.pc = null
      // Clean up dev exposure
      if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__mercury_pc) {
        delete (window as unknown as Record<string, unknown>).__mercury_pc
      }
    }
    if (this.keyRing) {
      this.keyRing.destroy()
      this.keyRing = null
    }

    this.roomId = null
    this.callConfig = null
    this.sendSignalFn = null
    this.pendingTrackUserMap.clear()
    this.negotiationQueue = Promise.resolve()
  }

  private handleConnectionStateChange(state: RTCPeerConnectionState, pc: RTCPeerConnection): void {
    this.clearConnectionFailedTimer()

    if (state === 'disconnected') {
      // Attempt ICE restart after brief delay — the connection may recover on its own
      this.connectionFailedTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected') {
          pc.restartIce()
        }
      }, 3000)
    } else if (state === 'failed') {
      // Wait 10 seconds; if still failed, fire diagnostic callbacks
      this.connectionFailedTimer = setTimeout(() => {
        if (pc.connectionState === 'failed') {
          for (const cb of this.diagnosticCallbacks) {
            try {
              cb()
            } catch {
              // ignore
            }
          }
        }
      }, CONNECTION_FAILURE_DELAY_MS)
    }
  }

  private clearConnectionFailedTimer(): void {
    if (this.connectionFailedTimer) {
      clearTimeout(this.connectionFailedTimer)
      this.connectionFailedTimer = null
    }
  }

  private findSender(track: MediaStreamTrack): RTCRtpSender | undefined {
    return this.pc?.getSenders().find((s) => s.track === track)
  }

  private async applyAudioBitrate(): Promise<void> {
    if (!this.pc || !this.callConfig?.audio) return

    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== 'audio') continue
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}]
      }
      params.encodings[0].maxBitrate = this.callConfig.audio.maxBitrateKbps * 1000
      await sender.setParameters(params)
    }
  }

  private async configureSimulcast(): Promise<void> {
    if (!this.pc || !this.callConfig?.video?.simulcastEnabled) return

    const layers = this.callConfig.video.simulcastLayers
    if (!layers || layers.length === 0) return

    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue
      const params = sender.getParameters()
      params.encodings = layers.map((layer: SimulcastLayer) => ({
        rid: layer.rid,
        maxBitrate: layer.maxBitrateKbps * 1000,
        scaleResolutionDownBy: layer.scaleDown,
        active: true,
      }))
      await sender.setParameters(params)
    }
  }

  private async renegotiate(
    sendSignal: (signal: { type: string; sdp?: string }) => void
  ): Promise<void> {
    if (!this.pc) return
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    sendSignal({ type: 'offer', sdp: offer.sdp })
  }

  /**
   * Enqueue an async negotiation operation to prevent overlapping
   * SDP offer/answer exchanges that would corrupt PeerConnection state.
   */
  private enqueueNegotiation(fn: () => Promise<void>): Promise<void> {
    this.negotiationQueue = this.negotiationQueue.then(fn, fn)
    return this.negotiationQueue
  }
}

// Singleton instance
export const webRTCManager = new WebRTCManager()

export { CALL_CONFIG_TIMEOUT_MS, CONNECTION_FAILURE_DELAY_MS }
