// 主进程与渲染进程共用的类型定义。
// 这里只放"数据形状"，不放任何业务逻辑。

import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, type Preset, type TimerConfig } from './presets'
import { type Topic } from './topics'

export type { Preset, TimerConfig, Topic }

/** 计时阶段 */
export type PhaseKind = 'focus' | 'short' | 'long'

/** 打断来源 */
export type InterruptKind = 'none' | 'internal' | 'external'

/**
 * 界面主题（v0.5）。
 *
 * 三套视觉语言，不只是换色：数字字体、圆角、按钮形态、有没有光都不一样，
 * 所以颜色和形状都放在 styles/themes/*.css 里，这里只管"用哪一套"。
 */
export type UiTheme = 'paper' | 'neon' | 'ios'

/** 深浅模式。纸感只能浅、霓虹只能深，系统感三种都行 */
export type UiMode = 'system' | 'light' | 'dark'

export type UiThemeInfo = {
  id: UiTheme
  /** 给人看的名字 */
  name: string
  /** 一句话自我描述 */
  desc: string
  /** 这套主题支持哪几档深浅 */
  modes: UiMode[]
  /** 预览卡上写的小字 */
  preview: string
}

/** 三套主题的元信息。设置页的预览卡直接拿这里渲染 */
export const UI_THEMES: UiThemeInfo[] = [
  { id: 'paper', name: '纸感', desc: '这是一张纸', modes: ['light'], preview: '纸感' },
  { id: 'neon', name: '玻璃霓虹', desc: '这是一块发光装置', modes: ['dark'], preview: '霓虹' },
  {
    id: 'ios',
    name: '系统感',
    desc: '这是苹果自带的 app',
    modes: ['system', 'light', 'dark'],
    preview: '系统感'
  }
]

/**
 * 切主题时的深浅兜底。
 *
 * 纸感只有浅、霓虹只有深：用户在深色下切到纸感，不能让界面保持深色
 * （那就成"黑底纸"了，也不是纸感）。所以直接落到这套主题支持的那一档。
 */
export function resolveUiTheme(
  theme: UiTheme,
  mode: UiMode,
  systemPrefersDark: boolean
): { theme: UiTheme; mode: 'light' | 'dark' } {
  const info = UI_THEMES.find((t) => t.id === theme) ?? UI_THEMES[0]
  let m: UiMode = mode
  if (!info.modes.includes(m)) m = info.modes[0]
  if (m === 'system') m = systemPrefersDark ? 'dark' : 'light'
  return { theme: info.id, mode: m }
}

/**
 * 每套主题的窗口底色。
 *
 * 主进程拿它设窗口背景色：窗口底色必须和界面底色一样，
 * 否则纸感（浅底）启动时会先闪一下深色，闪一下很难受。
 */
export const UI_THEME_BG: Record<UiTheme, { light: string; dark: string }> = {
  paper: { light: '#f4f1ea', dark: '#f4f1ea' },
  neon: { light: '#08090b', dark: '#08090b' },
  ios: { light: '#f2f2f7', dark: '#000000' }
}


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
  /** 界面主题（v0.5）。默认纸感 */
  uiTheme: UiTheme
  /** 深浅模式。纸感/霓虹只有一档，切过去会自动落到它支持的那档 */
  uiMode: UiMode
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
  /**
   * 这一段是"跑完"还是"被跳过"（规格 C1）。
   * false = 用户主动跳过：照旧写一条记录（completed=false），
   * 但不响铃、不弹记录卡片、不打断用户。
   */
  completed: boolean
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

/** 今日时间线上的一段（v0.3.4 的甘特条） */
export type TimelineEntry = {
  /** 段的开始时间（ISO） */
  startedAt: string
  /** 段的结束时间（ISO） */
  endedAt: string
  /** 专注 / 短休 / 长休 */
  kind: PhaseKind
  /** 实际时长（秒）。宽度按**实际时长**画，不是计划时长 */
  actualSec: number
  /** 是否自然走完。没走完的（跳过/中断）用虚线区分 */
  completed: boolean
  /** 主题 id，没挂主题为空 */
  topicId: string | null
  /** 主题名（记录当时的名字） */
  topicName: string
  /** 主题色。没挂主题时为空 —— 界面用中性色，不给它编个假颜色 */
  color: string | null
  /** 任务名 */
  task: string
  /** 打断原因 */
  interrupt: InterruptKind
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
  /** 今日时间线：专注段和休息段都画，按开始时间排 */
  timeline: TimelineEntry[]
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

/**
 * 崩溃恢复快照（规格 E 组）。
 *
 * 存在 `%APPDATA%\pomodoro\running.json`，和 `data.json` 分开：
 * 这是"当前这一段"的临时状态，每 30 秒重写一次全部历史记录太蠢，
 * 而且混进历史数据里两边会互相污染。
 *
 * 恢复时**一律按暂停处理**（E0：应用退出 = 暂停），
 * 所以 `running` 只是"落盘那一刻在不在跑"的记录，不是恢复后的状态。
 */
export type RunningSnapshot = {
  /** 快照结构版本。以后改结构时靠它识别旧文件 */
  v: 1
  phase: PhaseKind
  /** 落盘那一刻是否在跑 */
  running: boolean
  /** 这一段的计划总长（冻结的那个，切了模板也不变） */
  segmentTotalSec: number
  /** 落盘那一刻的剩余秒数 */
  remainingSec: number
  /** 这一段累计暂停了多少秒 */
  pausedSec: number
  /** 这一段开始时刻（恢复后仍用它算"今天"） */
  startedAt: string
  /** 落盘时刻 */
  savedAt: string
  /** 这一段的任务名 */
  task: string
  /** 这一段挂在哪个主题上 */
  topicId: string | null
  /** 当时的模板 id（只作记录；下一段仍用当前设置） */
  presetId?: string
  /**
   * 段序号：每换一段 +1。
   * 主进程靠它发现"换段了"，从而跳过防抖立刻落盘——
   * 否则跳过之后有 1 秒窗口，文件里还留着上一段（规格 E9）。
   */
  segmentSeq: number
  focusRounds: number
  completed: { focus: number; short: number; long: number }
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
  uiTheme: 'paper',
  uiMode: 'system',
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
