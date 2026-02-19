// Linux safeStorage fallback — must run BEFORE app.whenReady()
import { app } from 'electron'

export function configureLinuxKeychain(): void {
  if (process.platform !== 'linux') return

  const desktop = process.env.XDG_CURRENT_DESKTOP?.toLowerCase() || ''
  if (
    desktop.includes('gnome') ||
    desktop.includes('unity') ||
    desktop.includes('cinnamon')
  ) {
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
  } else if (desktop.includes('kde') || desktop.includes('plasma')) {
    app.commandLine.appendSwitch('password-store', 'kwallet5')
  }
  // If neither detected, Electron will try its default detection
}
