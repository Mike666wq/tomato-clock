// 主进程与渲染进程共用的类型定义。
// 这里只放"数据形状"，不放任何业务逻辑。

/** 计时阶段 */
export type PhaseKind = 'focus' | 'short' | 'long'

/** 打断来源 */
export type InterruptKind = 'none' | 'internal' | 'external'

export type Settings = {
  focusMin: number // 默认 25
  shortBreakMin: number // 默认 5
  longBreakMin: number // 默认 15
  roundsBeforeLong: number // 默认 4
  autoStartNext: boolean // 默认 false（自用先不自动，避免被迫开始）
  soundOn: boolean
  volume: number // 0-1
  launchAtLogin: boolean
  window: { x?: number; y?: number; w: number; h: number }
}

/** 一条专注记录 */
export type Session = {
  id: string
  kind: PhaseKind
  startedAt: string // ISO
  endedAt: string // ISO
  plannedSec: number
  actualSec: number // 实际专注秒数（暂停要扣掉）
  completed: boolean // 是否自然走完
  task: string // 任务名，可空
  interrupt: InterruptKind
  interruptNote?: string
}

export type AppData = {
  schemaVersion: number
  settings: Settings
  sessions: Session[]
}

export const DEFAULT_SETTINGS: Settings = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsBeforeLong: 4,
  autoStartNext: false,
  soundOn: true,
  volume: 0.6,
  launchAtLogin: false,
  window: { w: 480, h: 620 }
}

export const PHASE_LABEL: Record<PhaseKind, string> = {
  focus: '专注',
  short: '短休',
  long: '长休'
}

export const PHASE_TOTAL_SEC: Record<PhaseKind, number> = {
  focus: 25 * 60,
  short: 5 * 60,
  long: 15 * 60
}
