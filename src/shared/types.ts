// 主进程与渲染进程共用的类型定义。
// 这里只放"数据形状"，不放任何业务逻辑。

import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, type Preset, type TimerConfig } from './presets'
import { type Topic } from './topics'

export type { Preset, TimerConfig, Topic }

/** 计时阶段 */
export type PhaseKind = 'focus' | 'short' | 'long'

/** 打断来源 */
export type InterruptKind = 'none' | 'internal' | 'external'

export type Settings = {
  /** 当前模板（v0.3-a 起，时长由模板决定，不再是散字段） */
  activePresetId: string
  /** 所有模板：内置四个 + 自定义的 */
  presets: Preset[]
  /** 所有主题（v0.3-b）。首次启动不预置，用户自己建 */
  topics: Topic[]
  /** 当前主题；为空 = 未分类（允许不选，不强制） */
  activeTopicId: string | null
  autoStartNext: boolean // 默认 false（自用先不自动，避免被迫开始）
  soundOn: boolean
  volume: number // 0-1
  launchAtLogin: boolean
  /** 灵动岛是否显示（托盘右键菜单可以临时藏起来） */
  islandVisible: boolean
  /** 灵动岛展开态要不要显示音乐控制那一行。默认关：不是所有人都想在计时条里多一行东西 */
  showMusicControl: boolean
  window: { x?: number; y?: number; w: number; h: number }
}

/** 当前在放什么（由主进程从 SMTC 子进程拿到的） */
export type MediaSnapshot = {
  /** 来源程序，如 Tencent.QQMusic */
  source: string
  title: string
  artist: string
  playing: boolean
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
  /** 挂在哪个主题上（v0.3-b）。为空 = 未分类；休息段不挂 */
  topicId?: string
  /** 记录当时的主题名，改名后历史仍可读 */
  topicNameSnapshot?: string
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
  /** 当前这一段挂在哪个主题上（v0.3-b）。中途切主题不改变它 */
  topicId: string | null
  /** 用户当前选中的主题（切它只影响下一段） */
  activeTopicId: string | null
  /** 当前这一段的任务名（灵动岛上就地编辑，写进这一段的记录） */
  task: string
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
  /** 这一段的任务名（灵动岛上写的）。要在这里带上：等异步流程回来再读状态就晚了 */
  task: string
  /** 这一段挂在哪个主题上（休息段为空） */
  topicId: string | null
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

/** 一个主题的统计（v0.3-b） */
export type TopicStat = {
  topicId: string | null
  name: string
  color: string
  /** 完成了几个番茄 */
  rounds: number
  /** 总专注秒数 */
  totalSec: number
  /** 平均每回合秒数 */
  avgSec: number
  /** 打断率：被打断的回合占比（0–1） */
  interruptRate: number
  /** 时间占比（0–1），同一口径下总和为 1 */
  share: number
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
  /** 主题维度排行：本周 / 全部两个口径 */
  topicStats: { week: TopicStat[]; all: TopicStat[] }
  /** 今日概览：今天涉及几个主题、几个番茄，按主题分组 */
  todayTopics: Array<{
    topicId: string | null
    name: string
    color: string
    rounds: number
    totalSec: number
  }>
  /** 今天涉及的主题个数 */
  todayTopicCount: number
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
  topics: [],
  activeTopicId: null,
  autoStartNext: false,
  soundOn: true,
  volume: 0.5,
  launchAtLogin: false,
  islandVisible: true,
  showMusicControl: false,
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
    autoStartNext: settings.autoStartNext,
    topicId: settings.activeTopicId
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
