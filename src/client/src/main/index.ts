// Linux safeStorage fallback — must run before app.whenReady()
import { configureLinuxKeychain } from './safe-storage'
configureLinuxKeychain()

import { app, BrowserWindow, ipcMain, safeStorage, session, MessageChannelMain } from 'electron'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { IPC } from '../shared/ipc-channels'
import { createTray, destroyTray } from './tray'

const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL

// Accept self-signed certs in development only
if (isDev) {
  app.commandLine.appendSwitch('ignore-certificate-errors')
}

let mainWindow: BrowserWindow | null = null
let cryptoWorker: Worker | null = null

// Single instance lock — skip in dev when MERCURY_DEV_MULTI_INSTANCE=1
const skipSingleInstance = isDev && process.env.MERCURY_DEV_MULTI_INSTANCE === '1'
if (!skipSingleInstance) {
  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 940,
    minHeight: 500,
    show: false,
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  })

  // Show window when ready to avoid white flash
  win.once('ready-to-show', () => {
    win.show()
  })

  // Hide to tray instead of closing on macOS/Linux
  win.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function spawnCryptoWorker(): Worker {
  const workerPath = join(__dirname, 'workers/crypto-worker.js')
  const worker = new Worker(workerPath)

  worker.on('error', (err) => {
    console.error('[Main] Crypto worker error:', err)
  })

  worker.on('exit', (code) => {
    console.log(`[Main] Crypto worker exited with code ${code}`)
    cryptoWorker = null
  })

  // Handle safeStorage proxy requests from the worker
  worker.on('message', (msg: { op: string; id?: string; data?: string }) => {
    if (msg.op === 'safeStorage:encrypt' && msg.id && msg.data) {
      try {
        const encrypted = safeStorage.encryptString(msg.data)
        worker.postMessage({
          op: 'safeStorage:result',
          id: msg.id,
          data: encrypted,
        })
      } catch (err) {
        worker.postMessage({
          op: 'safeStorage:result',
          id: msg.id,
          data: null,
          error: String(err),
        })
      }
    } else if (msg.op === 'safeStorage:decrypt' && msg.id && msg.data) {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(msg.data))
        worker.postMessage({
          op: 'safeStorage:result',
          id: msg.id,
          data: decrypted,
        })
      } catch (err) {
        worker.postMessage({
          op: 'safeStorage:result',
          id: msg.id,
          data: null,
          error: String(err),
        })
      }
    }
  })

  return worker
}

function setupMessagePort(win: BrowserWindow, worker: Worker): void {
  // Electron MessageChannelMain ports can only be transferred to renderer processes,
  // not to Node.js worker_threads. So Main bridges between the two worlds:
  //   Renderer ↔ (Electron MessagePort) ↔ Main ↔ (parentPort) ↔ Worker
  //
  // Phase 6+ optimization: for large binary payloads, this bridge can be replaced
  // with a shared ArrayBuffer approach to avoid copies.

  const { port1: rendererPort, port2: mainPort } = new MessageChannelMain()

  // Send one Electron port to the renderer
  win.webContents.postMessage(IPC.CRYPTO_PORT, null, [rendererPort])

  // Bridge: Renderer → Main → Worker
  mainPort.on('message', (event: Electron.MessageEvent) => {
    worker.postMessage(event.data)
  })
  mainPort.start()

  // Bridge: Worker → Main → Renderer
  worker.on('message', (msg: { op: string; [key: string]: unknown }) => {
    // Only forward worker crypto responses to renderer, not safeStorage requests
    if (msg.op === 'pong' || msg.op === 'crypto:result' || msg.op === 'crypto:error') {
      mainPort.postMessage(msg)
    }
  })

  // Tell the worker it's ready and provide the data directory for databases
  worker.postMessage({ op: 'init:ready', dataDir: app.getPath('userData') })
}

function registerIpcHandlers(): void {
  ipcMain.on(IPC.APP_MINIMIZE, () => mainWindow?.minimize())
  ipcMain.on(IPC.APP_MAXIMIZE, () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.on(IPC.APP_CLOSE, () => mainWindow?.close())
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion())
  ipcMain.handle(IPC.APP_GET_PLATFORM, () => process.platform)
  ipcMain.handle(IPC.SAFE_STORAGE_IS_AVAILABLE, () => safeStorage.isEncryptionAvailable())
}

// Extend app with isQuitting flag for tray hide behavior
declare module 'electron' {
  interface App {
    isQuitting?: boolean
  }
}

app.on('before-quit', () => {
  app.isQuitting = true
})

app.whenReady().then(() => {
  // In development, accept self-signed certificates for localhost.
  // The command-line switch alone is insufficient — Chromium's network stack
  // in the renderer process uses the session's certificate verifier for fetch().
  if (isDev) {
    session.defaultSession.setCertificateVerifyProc((_request, callback) => {
      callback(0) // 0 = accept
    })
  }

  // Set CSP dynamically — permissive in dev (Vite HMR needs ws:// and http://),
  // strict in production.
  const csp = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src ws: wss: http: https:; img-src 'self' data: https://*;"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src wss://* https://*; img-src 'self' data: https://*;"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })

  registerIpcHandlers()

  mainWindow = createWindow()
  createTray(mainWindow)

  // Spawn the crypto worker thread
  cryptoWorker = spawnCryptoWorker()

  // Set up the direct MessagePort after the window content is loaded
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && cryptoWorker) {
      setupMessagePort(mainWindow, cryptoWorker)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  // Gracefully shut down the crypto worker
  if (cryptoWorker) {
    cryptoWorker.postMessage({ op: 'shutdown' })
    cryptoWorker = null
  }
  destroyTray()
})
