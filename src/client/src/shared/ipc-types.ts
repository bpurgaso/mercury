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

export interface WorkerInitPort {
  op: 'init:port'
}

export interface WorkerPing {
  op: 'ping'
  data?: string
}

export interface WorkerPong {
  op: 'pong'
  data?: string
}

export type WorkerMessage = WorkerInitPort | WorkerPing | WorkerPong | SafeStorageRequest | SafeStorageResponse

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
