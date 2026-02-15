import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('mercury', {
  platform: process.platform,
})
