const CUE_VOLUME = 0.3
const NOTE_DURATION = 0.1
const COOLDOWN_MS = 200

// Frequencies: C5 = 523.25 Hz, E5 = 659.25 Hz
const NOTE_C5 = 523.25
const NOTE_E5 = 659.25

export class AudioCuePlayer {
  private ctx: AudioContext | null = null
  private lastPlayTime = 0

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
    }
    return this.ctx
  }

  playJoin(): void {
    if (!this.canPlay()) return
    this.playTwoTone(NOTE_C5, NOTE_E5)
  }

  playLeave(): void {
    if (!this.canPlay()) return
    this.playTwoTone(NOTE_E5, NOTE_C5)
  }

  dispose(): void {
    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
    }
  }

  private canPlay(): boolean {
    const now = Date.now()
    if (now - this.lastPlayTime < COOLDOWN_MS) return false
    this.lastPlayTime = now
    return true
  }

  private playTwoTone(freq1: number, freq2: number): void {
    const ctx = this.ensureContext()
    const now = ctx.currentTime

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(CUE_VOLUME, now)
    gain.gain.linearRampToValueAtTime(0, now + NOTE_DURATION * 2 + 0.05)
    gain.connect(ctx.destination)

    // First note
    const osc1 = ctx.createOscillator()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(freq1, now)
    osc1.connect(gain)
    osc1.start(now)
    osc1.stop(now + NOTE_DURATION)

    // Second note
    const osc2 = ctx.createOscillator()
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(freq2, now + NOTE_DURATION)
    osc2.connect(gain)
    osc2.start(now + NOTE_DURATION)
    osc2.stop(now + NOTE_DURATION * 2)
  }
}

export const audioCuePlayer = new AudioCuePlayer()
