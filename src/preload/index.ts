// preload：通过 contextBridge 暴露最小 API，界面不碰 Node。
//
// 计时状态由主进程持有，这里只做两件事：读快照、发动作。

import { contextBridge, ipcRenderer } from 'electron'
import type {
  InterruptKind,
  Notice,
  RecordSummary,
  Session,
  Settings,
  ShortcutDef,
  StatsData,
  TimerState
} from '../shared/types'

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
  records: {
    /** 今日番茄数 / 今日专注时长 / 历史总时长 */
    summary: (): Promise<RecordSummary> => ipcRenderer.invoke('records:summary'),
    /** 提交一条记录（任务名 + 打断类型） */
    submit: (id: string, task: string, interrupt: InterruptKind): void =>
      ipcRenderer.send('records:submit', id, task, interrupt),
    onSummary: (cb: (s: RecordSummary) => void): (() => void) => {
      const listener = (_e: unknown, s: RecordSummary): void => cb(s)
      ipcRenderer.on('records:summary', listener)
      return () => {
        ipcRenderer.removeListener('records:summary', listener)
      }
    },
    /** 主进程要求打开记录卡片 */
    onOpen: (cb: (session: Session) => void): (() => void) => {
      const listener = (_e: unknown, s: Session): void => cb(s)
      ipcRenderer.on('record:open', listener)
      return () => {
        ipcRenderer.removeListener('record:open', listener)
      }
    },
    onClose: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('record:close', listener)
      return () => {
        ipcRenderer.removeListener('record:close', listener)
      }
    }
  },
  reminder: {
    /** 结束提醒：窗口已置顶，这里负责声音 + 边框闪烁 */
    onFire: (cb: (payload: { title: string; body: string }) => void): (() => void) => {
      const listener = (_e: unknown, p: { title: string; body: string }): void => cb(p)
      ipcRenderer.on('reminder:fire', listener)
      return () => {
        ipcRenderer.removeListener('reminder:fire', listener)
      }
    }
  },
  notice: {
    /** 取走攒着的通知（推送早于界面订阅时用） */
    take: (): Promise<Notice[]> => ipcRenderer.invoke('notice:take'),
    onShow: (cb: (n: Notice) => void): (() => void) => {
      const listener = (_e: unknown, n: Notice): void => cb(n)
      ipcRenderer.on('notice:show', listener)
      return () => {
        ipcRenderer.removeListener('notice:show', listener)
      }
    }
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    save: (patch: Partial<Settings>): void => ipcRenderer.send('settings:save', patch),
    /** 设置变了（切模板等），所有窗口都要刷新 */
    onChanged: (cb: (s: Settings) => void): (() => void) => {
      const listener = (_e: unknown, s: Settings): void => cb(s)
      ipcRenderer.on('settings:changed', listener)
      return () => {
        ipcRenderer.removeListener('settings:changed', listener)
      }
    }
  },
  stats: {
    get: (): Promise<StatsData> => ipcRenderer.invoke('stats:get')
  },
  shortcuts: {
    get: (): Promise<ShortcutDef[]> => ipcRenderer.invoke('shortcuts:get'),
    set: (id: ShortcutDef['id'], accelerator: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('shortcuts:set', id, accelerator)
  },
  csv: {
    export: (): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke('csv:export')
  },
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    /** 关闭按钮：收进托盘，不退出 */
    close: (): void => ipcRenderer.send('window:close'),
    show: (): void => ipcRenderer.send('window:show')
  },
  nav: {
    /** 主进程让主窗口切到某页（灵动岛右键菜单里的"设置"走这条） */
    onPage: (cb: (page: 'timer' | 'stats' | 'settings') => void): (() => void) => {
      const listener = (_e: unknown, page: 'timer' | 'stats' | 'settings'): void => cb(page)
      ipcRenderer.on('nav:page', listener)
      return () => {
        ipcRenderer.removeListener('nav:page', listener)
      }
    }
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
