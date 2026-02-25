export type CheckStatus = 'pending' | 'pass' | 'fail'

export interface DiagnosticResult {
  websocket: CheckStatus
  stun: CheckStatus
  turnUdp: CheckStatus
  turnTcp: CheckStatus
  timeToConnectedMs: number | null
}

type ProgressCallback = (result: DiagnosticResult) => void

const CHECK_TIMEOUT_MS = 5000

export class IceDiagnosticRunner {
  private callbacks = new Set<ProgressCallback>()
  private aborted = false

  onProgress(cb: ProgressCallback): () => void {
    this.callbacks.add(cb)
    return () => { this.callbacks.delete(cb) }
  }

  abort(): void {
    this.aborted = true
  }

  async run(opts: {
    wsConnected: boolean
    stunUrls: string[]
    turnUrls: string[]
    turnUsername: string
    turnCredential: string
    connectStartTime: number | null
  }): Promise<DiagnosticResult> {
    this.aborted = false

    const result: DiagnosticResult = {
      websocket: 'pending',
      stun: 'pending',
      turnUdp: 'pending',
      turnTcp: 'pending',
      timeToConnectedMs: opts.connectStartTime
        ? Date.now() - opts.connectStartTime
        : null,
    }

    this.emit(result)

    // Check 1: WebSocket
    result.websocket = opts.wsConnected ? 'pass' : 'fail'
    this.emit(result)
    if (this.aborted) return result

    // Check 2: STUN binding
    if (opts.stunUrls.length > 0) {
      result.stun = await this.checkStun(opts.stunUrls) ? 'pass' : 'fail'
    } else {
      result.stun = 'fail'
    }
    this.emit(result)
    if (this.aborted) return result

    // Check 3: TURN UDP
    const udpUrls = opts.turnUrls.filter((u) => !u.includes('transport=tcp'))
    if (udpUrls.length > 0) {
      result.turnUdp = await this.checkTurn(udpUrls, opts.turnUsername, opts.turnCredential) ? 'pass' : 'fail'
    } else {
      result.turnUdp = 'fail'
    }
    this.emit(result)
    if (this.aborted) return result

    // Check 4: TURN TCP
    const tcpUrls = opts.turnUrls.filter((u) => u.includes('transport=tcp'))
    if (tcpUrls.length > 0) {
      result.turnTcp = await this.checkTurn(tcpUrls, opts.turnUsername, opts.turnCredential) ? 'pass' : 'fail'
    } else {
      result.turnTcp = 'fail'
    }
    this.emit(result)

    return result
  }

  private emit(result: DiagnosticResult): void {
    for (const cb of this.callbacks) {
      try {
        cb({ ...result })
      } catch {
        // ignore
      }
    }
  }

  private checkStun(stunUrls: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false
      const pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrls }] })

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          pc.close()
          resolve(false)
        }
      }, CHECK_TIMEOUT_MS)

      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.type === 'srflx' && !resolved) {
          resolved = true
          clearTimeout(timer)
          pc.close()
          resolve(true)
        }
      }

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && !resolved) {
          resolved = true
          clearTimeout(timer)
          pc.close()
          resolve(false)
        }
      }

      // Need a media section to trigger ICE gathering
      pc.createDataChannel('diag')
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            pc.close()
            resolve(false)
          }
        })
    })
  }

  private checkTurn(turnUrls: string[], username: string, credential: string): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: turnUrls, username, credential }],
        iceTransportPolicy: 'relay', // force relay to test TURN only
      })

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          pc.close()
          resolve(false)
        }
      }, CHECK_TIMEOUT_MS)

      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.type === 'relay' && !resolved) {
          resolved = true
          clearTimeout(timer)
          pc.close()
          resolve(true)
        }
      }

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && !resolved) {
          resolved = true
          clearTimeout(timer)
          pc.close()
          resolve(false)
        }
      }

      pc.createDataChannel('diag')
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            pc.close()
            resolve(false)
          }
        })
    })
  }
}
