type SpeakingCallback = (speakers: Map<string, boolean>, activeSpeakerId: string | null) => void

const POLL_INTERVAL_MS = 100
const SPEAKING_THRESHOLD = 0.015
const SPEAKING_DURATION_MS = 200

interface SpeakerState {
  level: number
  aboveSince: number | null // timestamp when level first exceeded threshold
}

export class ActiveSpeakerDetector {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private speakerStates = new Map<string, SpeakerState>()
  private callbacks = new Set<SpeakingCallback>()
  private audioCtx: AudioContext | null = null
  private analysers = new Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>()
  private localUserId: string | null = null

  start(localUserId: string, getStreams: () => { localStream: MediaStream | null; remoteStreams: Map<string, MediaStream> }): void {
    this.stop()
    this.localUserId = localUserId
    this.audioCtx = new AudioContext()

    this.intervalId = setInterval(() => {
      const { localStream, remoteStreams } = getStreams()
      this.poll(localUserId, localStream, remoteStreams)
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    for (const { source } of this.analysers.values()) {
      source.disconnect()
    }
    this.analysers.clear()
    this.speakerStates.clear()
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {})
      this.audioCtx = null
    }
    this.localUserId = null
  }

  onSpeakingChange(cb: SpeakingCallback): () => void {
    this.callbacks.add(cb)
    return () => { this.callbacks.delete(cb) }
  }

  private getOrCreateAnalyser(userId: string, stream: MediaStream): AnalyserNode | null {
    if (!this.audioCtx) return null
    if (stream.getAudioTracks().length === 0) return null

    const existing = this.analysers.get(userId)
    if (existing) return existing.analyser

    const source = this.audioCtx.createMediaStreamSource(stream)
    const analyser = this.audioCtx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    this.analysers.set(userId, { analyser, source })
    return analyser
  }

  private getAudioLevel(analyser: AnalyserNode): number {
    const data = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(data)
    // Compute RMS of the waveform (centered at 128)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128
      sum += normalized * normalized
    }
    return Math.sqrt(sum / data.length)
  }

  private poll(localUserId: string, localStream: MediaStream | null, remoteStreams: Map<string, MediaStream>): void {
    const now = Date.now()

    // Clean up analysers for users no longer present
    const activeUserIds = new Set<string>()
    if (localStream) activeUserIds.add(localUserId)
    for (const userId of remoteStreams.keys()) activeUserIds.add(userId)
    for (const userId of this.analysers.keys()) {
      if (!activeUserIds.has(userId)) {
        const entry = this.analysers.get(userId)
        if (entry) entry.source.disconnect()
        this.analysers.delete(userId)
        this.speakerStates.delete(userId)
      }
    }

    // Measure levels for all participants
    const levels = new Map<string, number>()

    if (localStream) {
      const analyser = this.getOrCreateAnalyser(localUserId, localStream)
      if (analyser) {
        levels.set(localUserId, this.getAudioLevel(analyser))
      }
    }

    for (const [userId, stream] of remoteStreams) {
      const analyser = this.getOrCreateAnalyser(userId, stream)
      if (analyser) {
        levels.set(userId, this.getAudioLevel(analyser))
      }
    }

    // Update speaking state
    const speaking = new Map<string, boolean>()
    let loudestLevel = 0
    let loudestUserId: string | null = null

    for (const [userId, level] of levels) {
      let state = this.speakerStates.get(userId)
      if (!state) {
        state = { level: 0, aboveSince: null }
        this.speakerStates.set(userId, state)
      }
      state.level = level

      if (level > SPEAKING_THRESHOLD) {
        if (state.aboveSince === null) {
          state.aboveSince = now
        }
        const isSpeaking = now - state.aboveSince >= SPEAKING_DURATION_MS
        speaking.set(userId, isSpeaking)

        if (isSpeaking && level > loudestLevel) {
          loudestLevel = level
          loudestUserId = userId
        }
      } else {
        state.aboveSince = null
        speaking.set(userId, false)
      }
    }

    for (const cb of this.callbacks) {
      try {
        cb(speaking, loudestUserId)
      } catch {
        // ignore listener errors
      }
    }
  }
}

export const activeSpeakerDetector = new ActiveSpeakerDetector()
