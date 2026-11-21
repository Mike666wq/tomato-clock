// preload：通过 contextBridge 暴露最小 API，界面不碰 Node。
//
// 计时状态由主进程持有，这里只做两件事：读快照、发动作。

import { contextBridge, ipcRenderer } from 'electron'
import type { TimerState } from '../shared/types'

const api = {
  timer: {
    /** 取当前状态快照 */
    getState: (): Promise<TimerState> => ipcRenderer.invoke('timer:get-state'),
    /** 发动作：toggle / start / pause / skip / reset */
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
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    /** 关闭按钮：收进托盘，不退出 */
    close: (): void => ipcRenderer.send('window:close'),
    show: (): void => ipcRenderer.send('window:show')
  }
}

// 开发期专用：快速把计时器摆到指定阶段，用来验证阶段流转。
// import.meta.env.DEV 在打包时为 false，这段会被整段摇掉。
if (import.meta.env.DEV) {
  ;(api.timer as unknown as Record<string, unknown>)['devSeed'] = (
    phase: 'focus' | 'short' | 'long',
    elapsed: number
  ): Promise<void> => ipcRenderer.invoke('timer:dev-seed', phase, elapsed)
}

export type PreloadApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('pomodoro', api)
} else {
  ;(window as unknown as { pomodoro: PreloadApi }).pomodoro = api
}
