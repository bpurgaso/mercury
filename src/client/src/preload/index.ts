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

const api: MercuryAPI = {
  app: {
    minimize: () => safeSend(IPC.APP_MINIMIZE),
    maximize: () => safeSend(IPC.APP_MAXIMIZE),
    close: () => safeSend(IPC.APP_CLOSE),
    getVersion: () => '0.1.0',
    getPlatform: () => process.platform,
  },

  onCryptoPort(callback: (port: MessagePort) => void): void {
    ipcRenderer.on(IPC.CRYPTO_PORT, (event) => {
      const [port] = event.ports
      if (port) {
        callback(port)
      }
    })
  },
}

contextBridge.exposeInMainWorld('mercury', api)
