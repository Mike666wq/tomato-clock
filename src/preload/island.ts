// 灵动岛专用 preload：只暴露它自己用得到的那几个口子。
//
// 主窗口的 preload（src/preload/index.ts）那套 API 一概不给，
// 避免浮层上误触到主窗口专属的动作。

import { contextBridge, ipcRenderer } from 'electron'
import type { TimerState } from '../shared/types'
import type { IslandMode } from '../shared/island'

const api = {
  timer: {
    /** 取当前状态快照 */
    getState: (): Promise<TimerState> => ipcRenderer.invoke('timer:get-state'),
    /** 发动作：toggle / start / pause / skip / reset（和主窗口同一个状态机） */
    action: (action: 'toggle' | 'start' | 'pause' | 'skip' | 'reset'): void =>
      ipcRenderer.send('timer:action', action),
    /** 订阅状态变化，返回取消订阅函数 */
    onState: (cb: (state: TimerState) => void): (() => void) => {
      const listener = (_e: unknown, state: TimerState): void => cb(state)
      ipcRenderer.on('timer:state', listener)
      return () => {
        ipcRenderer.removeListener('timer:state', listener)
      }
    }
  },
  island: {
    /** 收起 / 展开（主进程据此改窗口大小并重新贴顶居中） */
    setMode: (mode: IslandMode): void => ipcRenderer.send('island:set-mode', mode),
    /** 打开主窗口（完整界面） */
    openMain: (): void => ipcRenderer.send('island:open-main')
  }
}

export type IslandApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('island', api)
} else {
  ;(window as unknown as { island: IslandApi }).island = api
}
