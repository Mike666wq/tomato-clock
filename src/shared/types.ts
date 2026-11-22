// 主进程与渲染进程共用的类型定义。
// 这里只放"数据形状"，不放任何业务逻辑。

import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, type Preset, type TimerConfig } from './presets'

export type { Preset, TimerConfig }

/** 计时阶段 */
export type PhaseKind = 'focus' | 'short' | 'long'

/** 打断来源 */
export type InterruptKind = 'none' | 'internal' | 'external'

export type Settings = {
  /** 当前模板（v0.3-a 起，时长由模板决定，不再是散字段） */
  activePresetId: string
  /** 所有模板：内置四个 + 自定义的 */
  presets: Preset[]
  autoStartNext: boolean // 默认 false（自用先不自动，避免被迫开始）
  soundOn: boolean
  volume: number // 0-1
  launchAtLogin: boolean
  /** 灵动岛是否显示（托盘右键菜单可以临时藏起来） */
  islandVisible: boolean
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
  pausedSec?: number // 这一段里累计暂停的秒数
  completed: boolean // 是否自然走完
  task: string // 任务名，可空
  interrupt: InterruptKind
  interruptNote?: string
}

/** 计时状态快照：主进程持有，界面只读 */
export type TimerState = {
  phase: PhaseKind
  running: boolean
  /** 当前阶段总秒数 */
  totalSec: number
  /** 当前阶段剩余秒数 */
  remainingSec: number
  /** 当前阶段已实际运行的秒数（不含暂停时间） */
  activeSec: number
  /** 本轮已完成多少个专注 */
  focusRounds: number
  /** 每个阶段跑完的次数（专注/短休/长休），用于统计 */
  completed: { focus: number; short: number; long: number }
}

/** 一个阶段自然跑完时，主进程交给界面与存储层的信息 */
export type PhaseCompleteInfo = {
  phase: PhaseKind
  plannedSec: number
  /** 实际运行秒数，已扣掉暂停时间 */
  actualSec: number
  /** 这一段里累计暂停了多少秒 */
  pausedSec: number
  startedAt: string
  endedAt: string
}

/** 底部状态行用的汇总 */
export type RecordSummary = {
  /** 今日完成的专注个数 */
  todayCount: number
  /** 今日专注总秒数 */
  todayFocusSec: number
  /** 历史专注总秒数 */
  totalFocusSec: number
}

/** 一次性提示（快捷键注册失败等） */
export type Notice = {
  id: string
  text: string
  tone: 'info' | 'warn'
}

/** 统计页需要的数据，由主进程算好 */
export type StatsData = {
  /** 今日完成的番茄数 */
  todayCount: number
  /** 今日专注总秒数 */
  todayFocusSec: number
  /** 历史专注总秒数 */
  totalFocusSec: number
  /** 今日按小时分布，24 个槽位，单位分钟 */
  todayByHour: number[]
  /** 近 7 天（含今天），索引 0 = 6 天前 */
  last7Days: Array<{ date: string; label: string; focusSec: number }>
  /** 打断原因排行 */
  interrupts: Array<{ kind: InterruptKind; label: string; count: number }>
  /** 全部记录 */
  sessions: Session[]
}

/** 快捷键项 */
export type ShortcutDef = {
  id: 'toggle' | 'show'
  accelerator: string
  /** 给人看的写法，如 "Ctrl + Alt + Space" */
  display: string
  label: string
}

/** 本地存储文件的整体结构 */
export type AppData = {
  schemaVersion: number
  settings: Settings
  sessions: Session[]
}

export const DEFAULT_SETTINGS: Settings = {
  activePresetId: DEFAULT_PRESET_ID,
  presets: BUILTIN_PRESETS.map((p) => ({ ...p })),
  autoStartNext: false,
  soundOn: true,
  volume: 0.5,
  launchAtLogin: false,
  islandVisible: true,
  window: { w: 480, h: 580 }
}

/**
 * 从设置里取出计时器真正需要的配置。
 *
 * 时长全部来自"当前模板"；这样切模板时只要换 activePresetId，
 * 计时器下一段自然就用新模板（切换规则：只影响下一段）。
 */
export function timerConfigOf(settings: Settings): TimerConfig {
  const p = settings.presets.find((x) => x.id === settings.activePresetId)
  const fallback = BUILTIN_PRESETS[0]
  const src = p ?? fallback
  return {
    focusMin: src.focusMin,
    shortMin: src.shortMin,
    longMin: src.longMin,
    roundsBeforeLong: src.roundsBeforeLong,
    autoStartNext: settings.autoStartNext
  }
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
