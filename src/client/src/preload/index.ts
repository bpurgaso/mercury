import { contextBridge, ipcRenderer } from 'electron'
import { IPC, RENDERER_SEND_CHANNELS } from '../shared/ipc-channels'
import type { MercuryAPI } from '../shared/ipc-types'

// Validate that we only send on explicitly allowed channels
function safeSend(channel: string, ...args: unknown[]): void {
  if (RENDERER_SEND_CHANNELS.includes(channel)) {
    ipcRenderer.send(channel, ...args)
  } else {
    console.error(`[Preload] Blocked send on disallowed channel: ${channel}`)
  }
}

// --- Crypto port handling (stays in preload context) ---
// The MessagePort cannot be reliably transferred through contextBridge,
// so we keep it in the preload and expose send/receive functions.

let cryptoPort: MessagePort | null = null
let messageHandler: ((data: unknown) => void) | null = null
const readyCallbacks: Array<() => void> = []

// Listen for the crypto port IMMEDIATELY (before renderer registers)
ipcRenderer.on(IPC.CRYPTO_PORT, (event) => {
  const [port] = event.ports
  if (port) {
    cryptoPort = port
    port.onmessage = (e: MessageEvent) => {
      messageHandler?.(e.data)
    }
    // Notify waiting code that the port is ready
    for (const cb of readyCallbacks) cb()
    readyCallbacks.length = 0
  }
})

const api: MercuryAPI = {
  app: {
    minimize: () => safeSend(IPC.APP_MINIMIZE),
    maximize: () => safeSend(IPC.APP_MAXIMIZE),
    close: () => safeSend(IPC.APP_CLOSE),
    getVersion: () => '0.1.0',
    getPlatform: () => process.platform,
  },

  // Legacy — kept for backward compatibility
  onCryptoPort(callback: (port: MessagePort) => void): void {
    ipcRenderer.on(IPC.CRYPTO_PORT, (event) => {
      const [port] = event.ports
      if (port) {
        callback(port)
      }
    })
  },

  crypto: {
    send(data: unknown): void {
      cryptoPort?.postMessage(data)
    },
    onMessage(callback: (data: unknown) => void): void {
      messageHandler = callback
    },
    onReady(callback: () => void): void {
      if (cryptoPort) {
        callback()
      } else {
        readyCallbacks.push(callback)
      }
    },
  },
}

contextBridge.exposeInMainWorld('mercury', api)
