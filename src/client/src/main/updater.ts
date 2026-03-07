import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../shared/ipc-channels'

const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours

let updateAvailable = false

export function initAutoUpdater(mainWindow: BrowserWindow): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', () => {
    updateAvailable = true
    mainWindow.webContents.send(IPC.UPDATER_STATUS, {
      status: 'available',
      message: 'Update available — restart to apply',
    })
  })

  autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send(IPC.UPDATER_STATUS, {
      status: 'downloaded',
      message: 'Update downloaded — restart to apply',
    })
  })

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message)
  })

  // IPC: renderer can query update status and trigger restart
  ipcMain.handle(IPC.UPDATER_CHECK, async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return { updateAvailable: !!result?.updateInfo }
    } catch {
      return { updateAvailable: false }
    }
  })

  ipcMain.on(IPC.UPDATER_RESTART, () => {
    if (updateAvailable) {
      autoUpdater.quitAndInstall(false, true)
    }
  })

  // Check for updates on launch
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[Updater] Initial check failed:', err.message)
  })

  // Periodic update checks
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Updater] Periodic check failed:', err.message)
    })
  }, UPDATE_CHECK_INTERVAL)
}
