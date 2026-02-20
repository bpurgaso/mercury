// Type definitions for IPC messages between processes

export interface SafeStorageRequest {
  op: 'safeStorage:encrypt' | 'safeStorage:decrypt'
  id: string
  data: string | Buffer
}

export interface SafeStorageResponse {
  op: 'safeStorage:result'
  id: string
  data: Buffer | string | null
  error?: string
}

export interface WorkerInitReady {
  op: 'init:ready'
  dataDir?: string
}

export interface WorkerInitPort {
  op: 'init:port'
}

// Crypto operation request (Renderer → Worker via Main bridge)
export interface CryptoRequest {
  op: string // 'crypto:generateAllKeys' | 'crypto:generateOneTimePreKeys' | 'crypto:getPublicKeys' | etc.
  id: string
  data?: Record<string, unknown>
}

// Crypto operation result (Worker → Renderer via Main bridge)
export interface CryptoResult {
  op: 'crypto:result'
  id: string
  data: unknown
}

// Crypto operation error (Worker → Renderer via Main bridge)
export interface CryptoError {
  op: 'crypto:error'
  id: string
  error: string
}

export interface WorkerPing {
  op: 'ping'
  data?: string
}

export interface WorkerPong {
  op: 'pong'
  data?: string
}

export type WorkerMessage =
  | WorkerInitReady
  | WorkerInitPort
  | WorkerPing
  | WorkerPong
  | SafeStorageRequest
  | SafeStorageResponse
  | CryptoRequest
  | CryptoResult
  | CryptoError

// MercuryAPI exposed to renderer via contextBridge
export interface MercuryAPI {
  app: {
    minimize(): void
    maximize(): void
    close(): void
    getVersion(): string
    getPlatform(): string
  }
  onCryptoPort(callback: (port: MessagePort) => void): void
}

declare global {
  interface Window {
    mercury: MercuryAPI
  }
}
