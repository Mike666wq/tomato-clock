// 灵动岛专用 preload：只暴露它自己用得到的那几个口子。
//
// 主窗口的 preload（src/preload/index.ts）那套 API 一概不给，
// 避免浮层上误触到主窗口专属的动作。

import { contextBridge, ipcRenderer } from 'electron'
import type { MediaSnapshot, Settings, TimerState } from '../shared/types'
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
    },
    /** 设置当前这一段的任务名（就地编辑） */
    setTask: (text: string): void => ipcRenderer.send('timer:set-task', text)
  },
  island: {
    /** 收起 / 展开（主进程据此改窗口大小并重新贴顶居中） */
    setMode: (mode: IslandMode, music?: boolean): void => {
      // music 决定展开态下面要不要多一行音乐控制，窗口高度跟着它变
      if (typeof music === 'boolean') ipcRenderer.send('island:set-mode', mode, music)
      else ipcRenderer.send('island:set-mode', mode)
    },
    /** 打开主窗口（完整界面） */
    openMain: (): void => ipcRenderer.send('island:open-main'),
    /** 主动要键盘焦点（就地编辑任务名之前必须调，否则输入跑到主窗口去了） */
    focus: (): void => ipcRenderer.send('island:focus')
  },
  media: {
    /** 当前在放什么；null = 没有音乐在放 */
    getState: (): Promise<MediaSnapshot | null> => ipcRenderer.invoke('media:get-state'),
    /** 发控制命令 */
    command: (cmd: 'play' | 'pause' | 'next' | 'prev'): void => ipcRenderer.send('media:command', cmd),
    onState: (cb: (s: MediaSnapshot | null) => void): (() => void) => {
      const listener = (_e: unknown, s: MediaSnapshot | null): void => cb(s)
      ipcRenderer.on('media:state', listener)
      return () => {
        ipcRenderer.removeListener('media:state', listener)
      }
    }
  },
  settings: {
    /** 读设置（灵动岛要显示当前模板、切换模板） */
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    /** 切模板：改 activePresetId 即可，计时器那边按"只影响下一段"处理 */
    save: (patch: Partial<Settings>): void => ipcRenderer.send('settings:save', patch),
    onChanged: (cb: (s: Settings) => void): (() => void) => {
      const listener = (_e: unknown, s: Settings): void => cb(s)
      ipcRenderer.on('settings:changed', listener)
      return () => {
        ipcRenderer.removeListener('settings:changed', listener)
      }
    }
  }
}

export type IslandApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('island', api)
} else {
  ;(window as unknown as { island: IslandApi }).island = api
}
