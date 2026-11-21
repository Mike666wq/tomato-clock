// preload：通过 contextBridge 暴露最小 API，界面不碰 Node。

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    close: (): void => ipcRenderer.send('window:close')
  }
}

export type PreloadApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('pomodoro', api)
} else {
  ;(window as unknown as { pomodoro: PreloadApi }).pomodoro = api
}
