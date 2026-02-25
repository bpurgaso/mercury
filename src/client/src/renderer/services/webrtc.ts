import type { CallConfig, SimulcastLayer } from '../types/call'
import type { CallConfigEvent } from '../types/ws'

type RemoteTrackCallback = (userId: string, track: MediaStreamTrack, stream: MediaStream) => void
type RemoteTrackRemovedCallback = (userId: string, trackId: string) => void
type ConnectionStateCallback = (state: RTCPeerConnectionState) => void

const CALL_CONFIG_TIMEOUT_MS = 10_000
const CONNECTION_FAILURE_DELAY_MS = 10_000

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null
  private localAudioTrack: MediaStreamTrack | null = null
  private localVideoTrack: MediaStreamTrack | null = null
  private callConfig: CallConfig | null = null
  private connectionFailedTimer: ReturnType<typeof setTimeout> | null = null
  private roomId: string | null = null

  private remoteTrackCallbacks = new Set<RemoteTrackCallback>()
  private remoteTrackRemovedCallbacks = new Set<RemoteTrackRemovedCallback>()
  private connectionStateCallbacks = new Set<ConnectionStateCallback>()

  // Track userId associations from signaling metadata
  private pendingTrackUserMap = new Map<string, string>() // mid → userId

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

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'ice_candidate',
          candidate: JSON.stringify(event.candidate.toJSON()),
        })
      }
    }

    pc.ontrack = (event) => {
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
      this.pc.addTrack(track, stream)
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
      this.pc.addTrack(track, stream)
      await this.configureSimulcast()

      // Video add requires renegotiation
      if (sendSignal) {
        await this.renegotiate(sendSignal)
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

        // Video remove requires renegotiation
        if (sendSignal) {
          await this.renegotiate(sendSignal)
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

  async handleSignal(signal: { type: string; sdp?: string; candidate?: string }): Promise<void> {
    if (!this.pc) return

    if (signal.type === 'answer' && signal.sdp) {
      await this.pc.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: signal.sdp,
      }))
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
    }

    this.roomId = null
    this.callConfig = null
    this.pendingTrackUserMap.clear()
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
      // Set a timer; if still failed after 10s, the call UI should show diagnostics
      this.connectionFailedTimer = setTimeout(() => {
        // Timer fires — diagnostics state is handled by callStore via the callback
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
}

// Singleton instance
export const webRTCManager = new WebRTCManager()

export { CALL_CONFIG_TIMEOUT_MS, CONNECTION_FAILURE_DELAY_MS }
