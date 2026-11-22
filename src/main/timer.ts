// 计时核心：状态机 + 阶段流转。
//
// 状态归主进程持有（方案第八节风险表最后一条）：
// 窗口关掉、界面重开、甚至应用退到托盘，计时都照常走。
// 渲染层只通过 IPC 读快照、发动作，不持有任何计时状态。
//
// 时间口径：
//   remainingSec  倒计时剩余秒数，暂停时冻结
//   activeSec     本阶段实际"跑起来"的秒数，暂停期间不增长
//   actualSec     阶段结束时写进记录的秒数 = 已跑秒数（已扣掉暂停）

import { PHASE_LABEL, type PhaseKind, type PhaseCompleteInfo, type TimerState } from '../shared/types'
import type { TimerConfig } from '../shared/presets'

export type TimerAction = 'toggle' | 'start' | 'pause' | 'skip' | 'reset'

export class Timer {
  private cfg: TimerConfig
  private phase: PhaseKind = 'focus'
  private running = false
  private endsAt: number | null = null
  private focusRounds = 0
  private completed = { focus: 0, short: 0, long: 0 }
  private ticker: NodeJS.Timeout | null = null
  private lastEmittedSec = -1
  private listeners = new Set<(s: TimerState) => void>()
  private phaseListeners = new Set<(p: PhaseCompleteInfo) => void>()

  /** 当前阶段开始时刻（墙钟） */
  private phaseStartedAt = Date.now()
  /**
   * 当前这一段的计划总长。**在这一段跑完之前冻结**：
   * 设置里改了时长只影响下一段，当前段的 total 不动，
   * 否则圆环的分母会当场跳一下。
   */
  private segmentTotalSec = 0
  /** 当前阶段累计暂停毫秒 */
  private pausedMs = 0
  /** 本次暂停的开始时刻 */
  private pauseStartedAt: number | null = null
  /**
   * 当前这一段挂在哪个主题上（v0.3-b）。
   * 规则跟时长一样：中途切主题只影响下一段，当前段不变。
   */
  private segmentTopicId: string | null = null
  /** 当前这一段的任务名（灵动岛上就地编辑） */
  private segmentTask = ''

  constructor(cfg: TimerConfig) {
    this.cfg = cfg
    this.remainingSecCached = this.phaseSec('focus')
    this.segmentTotalSec = this.remainingSecCached
    // 第一段也要挂上当前选中的主题。
    // 之前漏了这一行：segmentTopicId 默认 null，而它只在 updateSettings / reset / advance
    // 里才被赋值，于是"每次启动应用后的第一个专注段"永远记成未分类，
    // 用户明明在设置里选着主题，跑完一看记录还是未分类。
    this.segmentTopicId = cfg.topicId

    if (import.meta.env.DEV) {
      this.devSeed = (phase?: PhaseKind, elapsedSec = 0): void => {
        if (phase) this.phase = phase
        this.phaseStartedAt = Date.now()
        this.pausedMs = 0
        this.pauseStartedAt = null
        this.segmentTotalSec = this.phaseSec(this.phase)
        this.remainingSecCached = Math.max(0, this.segmentTotalSec - elapsedSec)
        this.running = false
        this.endsAt = null
        this.emit()
        // elapsedSec > 0 时从"已经过去 elapsed 秒"的位置继续跑，用来快速验证阶段流转
        if (elapsedSec > 0) this.start()
      }
    }
  }

  // ---------- 对外接口 ----------

  getState(): TimerState {
    const total = this.segmentTotalSec
    const remaining = this.remainingSec()
    return {
      phase: this.phase,
      running: this.running,
      totalSec: total,
      remainingSec: remaining,
      activeSec: Math.max(0, total - remaining),
      focusRounds: this.focusRounds,
      completed: { ...this.completed },
      topicId: this.segmentTopicId,
      activeTopicId: this.cfg.topicId,
      task: this.segmentTask
    }
  }

  /** 设置当前这一段的任务名（灵动岛就地编辑用） */
  setTask(text: string): void {
    this.segmentTask = text
    this.emit()
  }

  subscribe(fn: (s: TimerState) => void): () => void {
    this.listeners.add(fn)
    fn(this.getState())
    return () => this.listeners.delete(fn)
  }

  onPhaseComplete(fn: (info: PhaseCompleteInfo) => void): () => void {
    this.phaseListeners.add(fn)
    return () => this.phaseListeners.delete(fn)
  }

  /**
   * 配置变化时调用（切模板、改自动开始等）。
   *
   * 规则（肥鱼定死）：计时进行中修改时长，只影响下一段，当前段不变。
   * 当前段的 segmentTotalSec 与剩余时间都不动，所以圆环也不会跳。
   * 只有"这一段还没开始跑"（不计时、也没消耗过）时才立刻生效。
   *
   * 切模板同理：休息段里换了模板，下一段（下一个专注）用新模板的时长，
   * 而这一段休息的长度不变 —— 因为 advance() 是在段落真正开始时
   * 现读 this.cfg，不是缓存的初始值。
   */
  updateSettings(cfg: TimerConfig): void {
    this.cfg = cfg
    const newTotal = this.phaseSec(this.phase)
    const notStarted = !this.running && this.remainingSecCached === this.segmentTotalSec
    if (notStarted && newTotal !== this.segmentTotalSec) {
      this.segmentTotalSec = newTotal
      this.remainingSecCached = newTotal
      this.emit()
    }
    // 主题同一条规则：这一段还没开始跑 → 立刻用新主题；已经在跑 → 当前段不变，下一段生效
    if (notStarted && this.segmentTopicId !== cfg.topicId) {
      this.segmentTopicId = cfg.topicId
      this.emit()
    }
  }

  apply(action: TimerAction): void {
    switch (action) {
      case 'toggle':
        if (this.running) this.pause()
        else this.start()
        break
      case 'start':
        this.start()
        break
      case 'pause':
        this.pause()
        break
      case 'skip':
        this.skip()
        break
      case 'reset':
        this.reset()
        break
    }
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  // ---------- 内部实现 ----------

  private remainingSecCached = 0

  private phaseSec(phase: PhaseKind): number {
    const min =
      phase === 'focus'
        ? this.cfg.focusMin
        : phase === 'short'
          ? this.cfg.shortMin
          : this.cfg.longMin
    return Math.max(1, min) * 60
  }

  private remainingSec(): number {
    if (!this.running || this.endsAt === null) return this.remainingSecCached
    return Math.max(0, Math.ceil((this.endsAt - Date.now()) / 1000))
  }

  private start(): void {
    if (this.running) return
    this.remainingSecCached = this.remainingSecCached || this.phaseSec(this.phase)
    this.endsAt = Date.now() + this.remainingSecCached * 1000
    this.running = true
    // 恢复计时：把这次暂停的时长累计进去
    if (this.pauseStartedAt !== null) {
      this.pausedMs += Date.now() - this.pauseStartedAt
      this.pauseStartedAt = null
    }
    this.lastEmittedSec = -1
    this.ensureTicker()
    this.emit()
  }

  private pause(): void {
    if (!this.running) return
    this.remainingSecCached = this.remainingSec()
    this.running = false
    this.endsAt = null
    this.pauseStartedAt = Date.now()
    this.emit()
  }

  private reset(): void {
    this.running = false
    this.endsAt = null
    this.pauseStartedAt = null
    this.pausedMs = 0
    this.phaseStartedAt = Date.now()
    this.segmentTotalSec = this.phaseSec(this.phase)
    this.remainingSecCached = this.segmentTotalSec
    this.segmentTopicId = this.cfg.topicId
    this.segmentTask = ''
    this.emit()
  }

  /** 跳过当前段：按正常完成的路径推进到下一段（但不计入完成次数） */
  private skip(): void {
    this.advance(false)
  }

  private ensureTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => this.tick(), 200)
  }

  private tick(): void {
    if (!this.running) return
    const left = this.remainingSec()
    if (left <= 0) {
      this.advance(true)
      return
    }
    if (left !== this.lastEmittedSec) {
      this.lastEmittedSec = left
      this.emit()
    }
  }

  /** 推进到下一阶段。completed=true 表示这一段是自然跑完的 */
  private advance(completed: boolean): void {
    const finished = this.phase
    const plannedSec = this.phaseSec(finished)
    const endedAt = Date.now()

    if (completed) {
      this.completed[finished] += 1
      if (finished === 'focus') {
        this.focusRounds += 1
      }
      // 实际跑起来的秒数：倒计时只在"跑"的时候走，所以
      // 实际秒数 = 计划 - 剩余（此刻剩余已归零），暂停时间不进这个数
      const actualSec = Math.max(0, plannedSec - this.remainingSec())
      const pausedSec = Math.round(
        (this.pausedMs + (this.pauseStartedAt ? endedAt - this.pauseStartedAt : 0)) / 1000
      )
      const info: PhaseCompleteInfo = {
        phase: finished,
        plannedSec,
        actualSec,
        pausedSec,
        startedAt: new Date(this.phaseStartedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        // 任务名和主题必须在清空之前取出来：后面这段的 task 会被清掉
        task: this.segmentTask,
        topicId: finished === 'focus' ? this.segmentTopicId : null
      }
      this.phaseListeners.forEach((fn) => fn(info))
    }

    // 阶段流转：专注 → (每 roundsBeforeLong 轮一次长休) 短休 → 专注
    let next: PhaseKind = 'focus'
    if (finished === 'focus') {
      next = this.focusRounds % this.cfg.roundsBeforeLong === 0 ? 'long' : 'short'
    }

    this.phase = next
    this.running = false
    this.endsAt = null
    this.pauseStartedAt = null
    this.pausedMs = 0
    this.phaseStartedAt = endedAt
    // 新的一段开始：主题用"此刻"选中的那个（用户可能刚在休息里切过）
    this.segmentTopicId = this.cfg.topicId
    // 任务名是"这一段"的，新的一段从头开始
    this.segmentTask = ''
    // 下一段用新的时长
    this.segmentTotalSec = this.phaseSec(next)
    this.remainingSecCached = this.segmentTotalSec
    this.emit()

    if (this.cfg.autoStartNext) {
      this.start()
    }
  }

  private emit(): void {
    const state = this.getState()
    this.listeners.forEach((fn) => fn(state))
  }
}

export { PHASE_LABEL }

/**
 * 开发期专用方法：把计时器摆到指定阶段与已过秒数，用来快速验证阶段流转。
 * 用接口声明合并而不是类字段，这样打包产物里连属性名都不会留下。
 */
export interface Timer {
  devSeed?: (phase?: PhaseKind, elapsedSec?: number) => void
}
