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

import { PHASE_LABEL, type PhaseKind, type PhaseCompleteInfo, type Settings, type TimerState } from '../shared/types'

export type TimerAction = 'toggle' | 'start' | 'pause' | 'skip' | 'reset'

export class Timer {
  private settings: Settings
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
  /** 当前阶段累计暂停毫秒 */
  private pausedMs = 0
  /** 本次暂停的开始时刻 */
  private pauseStartedAt: number | null = null

  constructor(settings: Settings) {
    this.settings = settings
    this.remainingSecCached = this.phaseSec('focus')

    if (import.meta.env.DEV) {
      this.devSeed = (phase?: PhaseKind, elapsedSec = 0): void => {
        if (phase) this.phase = phase
        this.phaseStartedAt = Date.now()
        this.pausedMs = 0
        this.pauseStartedAt = null
        this.remainingSecCached = Math.max(0, this.phaseSec(this.phase) - elapsedSec)
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
    const total = this.phaseSec(this.phase)
    const remaining = this.remainingSec()
    return {
      phase: this.phase,
      running: this.running,
      totalSec: total,
      remainingSec: remaining,
      activeSec: Math.max(0, total - remaining),
      focusRounds: this.focusRounds,
      completed: { ...this.completed }
    }
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

  /** 设置变化时调用（时长等） */
  updateSettings(settings: Settings): void {
    this.settings = settings
    if (!this.running) {
      // 暂停状态下刷新当前阶段时长
      this.remainingSecCached = this.phaseSec(this.phase)
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
        ? this.settings.focusMin
        : phase === 'short'
          ? this.settings.shortBreakMin
          : this.settings.longBreakMin
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
    this.remainingSecCached = this.phaseSec(this.phase)
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
        endedAt: new Date(endedAt).toISOString()
      }
      this.phaseListeners.forEach((fn) => fn(info))
    }

    // 阶段流转：专注 → (每 roundsBeforeLong 轮一次长休) 短休 → 专注
    let next: PhaseKind = 'focus'
    if (finished === 'focus') {
      next = this.focusRounds % this.settings.roundsBeforeLong === 0 ? 'long' : 'short'
    }

    this.phase = next
    this.running = false
    this.endsAt = null
    this.pauseStartedAt = null
    this.pausedMs = 0
    this.phaseStartedAt = endedAt
    this.remainingSecCached = this.phaseSec(next)
    this.emit()

    if (this.settings.autoStartNext) {
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
