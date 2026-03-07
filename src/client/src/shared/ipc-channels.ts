// Explicit allowlist of IPC channel names — no wildcards
export const IPC = {
  // App lifecycle
  APP_MINIMIZE: 'app:minimize',
  APP_MAXIMIZE: 'app:maximize',
  APP_CLOSE: 'app:close',
  APP_GET_VERSION: 'app:get-version',
  APP_GET_PLATFORM: 'app:get-platform',

  // Crypto Worker MessagePort transfer
  CRYPTO_PORT: 'crypto:port',

  // SafeStorage proxy (Worker → Main)
  SAFE_STORAGE_ENCRYPT: 'safeStorage:encrypt',
  SAFE_STORAGE_DECRYPT: 'safeStorage:decrypt',
  SAFE_STORAGE_RESULT: 'safeStorage:result',
  SAFE_STORAGE_IS_AVAILABLE: 'safeStorage:isAvailable',

  // Auto-updater
  UPDATER_STATUS: 'updater:status',
  UPDATER_CHECK: 'updater:check',
  UPDATER_RESTART: 'updater:restart',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// Channels the renderer is allowed to receive messages on
export const RENDERER_RECEIVE_CHANNELS: readonly string[] = [
  IPC.CRYPTO_PORT,
  IPC.APP_GET_VERSION,
  IPC.APP_GET_PLATFORM,
  IPC.UPDATER_STATUS,
] as const

// Channels the renderer is allowed to send messages on
export const RENDERER_SEND_CHANNELS: readonly string[] = [
  IPC.APP_MINIMIZE,
  IPC.APP_MAXIMIZE,
  IPC.APP_CLOSE,
  IPC.APP_GET_VERSION,
  IPC.APP_GET_PLATFORM,
  IPC.SAFE_STORAGE_IS_AVAILABLE,
  IPC.UPDATER_CHECK,
  IPC.UPDATER_RESTART,
] as const
