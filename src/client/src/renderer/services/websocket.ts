import { encode, decode } from '@msgpack/msgpack'
import type {
  ServerMessage,
  ServerEventType,
  WSEventMap,
  ReadyEvent,
  MessageCreateEvent,
  PresenceUpdateEvent,
  MemberAddEvent,
  MemberRemoveEvent,
} from '../types/ws'
import { getServerUrl } from './api'

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING'

type EventCallback<T = unknown> = (data: T) => void

const RECONNECT_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitterFactor: 0.2,
}

// Close code the server sends when a resume session is expired/invalid
const CLOSE_SESSION_EXPIRED = 4009

export function calculateBackoff(attempt: number): number {
  const exponential = Math.min(
    RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt),
    RECONNECT_CONFIG.maxDelayMs
  )

  // Apply +/-20% jitter
  const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_CONFIG.jitterFactor
  return Math.round(exponential * jitter)
}

export class WebSocketManager {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<EventCallback>>()
  private stateListeners = new Set<EventCallback<ConnectionState>>()
  private state: ConnectionState = 'DISCONNECTED'
  private seq = 0
  private sessionId: string | null = null
  private heartbeatInterval: number = 30
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastHeartbeatAck = true
  private missedHeartbeats = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private token: string | null = null
  private deviceId: string | null = null
  private retryAfterMs: number | null = null

  connect(token: string): void {
    this.token = token
    this.deviceId = this.getOrCreateDeviceId()
    this.reconnectAttempt = 0
    this.doConnect()
  }

  disconnect(): void {
    this.cleanup()
    this.setState('DISCONNECTED')
  }

  send(op: string, data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Use MessagePack binary framing for ops with binary payload data:
      // - sender_key_distribute always carries binary ciphertext
      // - message_send only when it's a DM (dm_channel_id) or private channel (encrypted)
      //   Standard channel messages (channel_id + content) remain JSON for server compat
      const useBinary =
        op === 'sender_key_distribute' ||
        (op === 'message_send' &&
          data != null &&
          typeof data === 'object' &&
          ('dm_channel_id' in data || 'encrypted' in data))

      if (useBinary) {
        const encoded = encode({ op, d: data })
        this.ws.send(encoded)
      } else {
        this.ws.send(JSON.stringify({ op, d: data }))
      }
    }
  }

  on<K extends keyof WSEventMap>(event: K, cb: EventCallback<WSEventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(cb as EventCallback)
    return () => {
      this.listeners.get(event)?.delete(cb as EventCallback)
    }
  }

  onStateChange(cb: EventCallback<ConnectionState>): () => void {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  getState(): ConnectionState {
    return this.state
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  getSeq(): number {
    return this.seq
  }

  private doConnect(): void {
    // Detach handlers from old socket BEFORE closing to prevent its onclose
    // from scheduling a duplicate reconnect.
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }

    this.setState('CONNECTING')

    const serverUrl = getServerUrl().replace(/^http/, 'ws')
    const wsUrl = `${serverUrl}/ws?token=${this.token}`

    console.log('[WS] Connecting...', this.sessionId ? '(will attempt resume)' : '(fresh identify)')

    try {
      this.ws = new WebSocket(wsUrl)
      this.ws.binaryType = 'arraybuffer'
    } catch (err) {
      console.error('[WS] WebSocket constructor threw:', err)
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      console.log('[WS] Connection opened')
      this.reconnectAttempt = 0
      this.retryAfterMs = null

      // Attempt resume first, fall back to identify
      if (this.sessionId) {
        console.log('[WS] Sending resume (session_id=%s, seq=%d)', this.sessionId, this.seq)
        this.send('resume', {
          token: this.token,
          session_id: this.sessionId,
          seq: this.seq,
        })
      } else {
        console.log('[WS] Sending identify')
        this.send('identify', {
          token: this.token,
          device_id: this.deviceId,
        })
      }
    }

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event)
    }

    this.ws.onclose = (event: CloseEvent) => {
      console.log('[WS] Connection closed (code=%d, reason=%s)', event.code, event.reason || 'none')
      this.stopHeartbeat()

      // Session expired / invalid resume — clear session so next attempt does fresh identify
      if (event.code === CLOSE_SESSION_EXPIRED) {
        console.log('[WS] Session expired, will use fresh identify on next attempt')
        this.sessionId = null
        this.seq = 0
      }

      // Check for Retry-After in close reason (server may encode it)
      if (event.code === 1013 || event.reason?.includes('Retry-After')) {
        const match = event.reason?.match(/Retry-After:\s*(\d+)/)
        if (match) {
          this.retryAfterMs = parseInt(match[1], 10) * 1000
        }
      }

      if (this.state !== 'DISCONNECTED') {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror — no action needed here
    }
  }

  private handleMessage(event: MessageEvent): void {
    let envelope: ServerMessage
    if (event.data instanceof ArrayBuffer) {
      // Binary frame → MessagePack
      try {
        envelope = decode(new Uint8Array(event.data)) as ServerMessage
      } catch {
        return
      }
    } else {
      // Text frame → JSON
      try {
        envelope = JSON.parse(event.data as string)
      } catch {
        return
      }
    }

    if (envelope.seq != null) {
      this.seq = envelope.seq
    }

    switch (envelope.t) {
      case 'READY': {
        const data = envelope.d as ReadyEvent
        this.sessionId = data.session_id
        this.heartbeatInterval = data.heartbeat_interval || 30
        console.log('[WS] READY received (session_id=%s)', this.sessionId)
        this.setState('CONNECTED')
        this.startHeartbeat()
        this.emit('READY', data)
        break
      }
      case 'RESUMED': {
        console.log('[WS] RESUMED received')
        this.setState('CONNECTED')
        this.startHeartbeat()
        this.emit('RESUMED', envelope.d)
        break
      }
      case 'HEARTBEAT_ACK': {
        this.lastHeartbeatAck = true
        this.missedHeartbeats = 0
        break
      }
      case 'MESSAGE_CREATE': {
        this.emit('MESSAGE_CREATE', envelope.d as MessageCreateEvent)
        break
      }
      case 'PRESENCE_UPDATE': {
        this.emit('PRESENCE_UPDATE', envelope.d as PresenceUpdateEvent)
        break
      }
      case 'MEMBER_ADD': {
        this.emit('MEMBER_ADD', envelope.d as MemberAddEvent)
        break
      }
      case 'MEMBER_REMOVE': {
        this.emit('MEMBER_REMOVE', envelope.d as MemberRemoveEvent)
        break
      }
      default: {
        // Forward any unhandled events (CHANNEL_CREATE, etc.)
        if (envelope.t) {
          this.emit(envelope.t, envelope.d)
        }
      }
    }
  }

  private emit(event: string, data: unknown): void {
    const listeners = this.listeners.get(event)
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb(data)
        } catch (err) {
          console.error(`[WS] Error in ${event} listener:`, err)
        }
      }
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state
    for (const cb of this.stateListeners) {
      try {
        cb(state)
      } catch {
        // ignore
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastHeartbeatAck = true
    this.missedHeartbeats = 0

    this.heartbeatTimer = setInterval(() => {
      if (!this.lastHeartbeatAck) {
        this.missedHeartbeats++
        if (this.missedHeartbeats >= 3) {
          console.log('[WS] 3 missed heartbeat ACKs, closing connection')
          this.ws?.close()
          return
        }
      }
      this.lastHeartbeatAck = false
      this.send('heartbeat', { seq: this.seq })
    }, this.heartbeatInterval * 1000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleReconnect(): void {
    // Cancel any existing reconnect timer to prevent duplicates
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.setState('RECONNECTING')

    let delay: number
    if (this.retryAfterMs) {
      delay = this.retryAfterMs
      this.retryAfterMs = null
    } else {
      delay = calculateBackoff(this.reconnectAttempt)
    }

    this.reconnectAttempt++

    console.log('[WS] Reconnecting in %dms (attempt %d)', delay, this.reconnectAttempt)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect()
    }, delay)
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    this.sessionId = null
    this.seq = 0
    this.reconnectAttempt = 0
    this.token = null
  }

  private getOrCreateDeviceId(): string {
    const key = 'mercury_device_id'
    let deviceId = localStorage.getItem(key)
    if (!deviceId) {
      deviceId = crypto.randomUUID()
      localStorage.setItem(key, deviceId)
    }
    return deviceId
  }
}

// Singleton instance
export const wsManager = new WebSocketManager()
