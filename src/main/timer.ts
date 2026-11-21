// 计时核心：状态机 + 阶段流转。
//
// 状态归主进程持有（方案第八节风险表最后一条）：
// 窗口关掉、界面重开、甚至应用退到托盘，计时都照常走。
// 渲染层只通过 IPC 读快照、发动作，不持有任何计时状态。

import { PHASE_LABEL, type PhaseKind, type Settings, type TimerState } from '../shared/types'

export type TimerAction = 'toggle' | 'start' | 'pause' | 'skip' | 'reset'

export type TimerEvents = {
  /** 计时状态变化 */
  onState: (state: TimerState) => void
  /** 一个阶段自然跑完（用于第 3 轮的强提醒与记录弹窗） */
  onPhaseComplete: (phase: PhaseKind) => void
}

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
  private phaseListeners = new Set<(p: PhaseKind) => void>()

  constructor(settings: Settings) {
    this.settings = settings
    this.remainingSecCached = this.phaseSec('focus')

    if (import.meta.env.DEV) {
      this.devSeed = (phase?: PhaseKind, elapsedSec = 0): void => {
        if (phase) this.phase = phase
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
    return {
      phase: this.phase,
      running: this.running,
      totalSec: this.phaseSec(this.phase),
      remainingSec: this.remainingSec(),
      focusRounds: this.focusRounds,
      completed: { ...this.completed }
    }
  }

  subscribe(fn: (s: TimerState) => void): () => void {
    this.listeners.add(fn)
    fn(this.getState())
    return () => this.listeners.delete(fn)
  }

  onPhaseComplete(fn: (p: PhaseKind) => void): () => void {
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
    this.lastEmittedSec = -1
    this.ensureTicker()
    this.emit()
  }

  private pause(): void {
    if (!this.running) return
    this.remainingSecCached = this.remainingSec()
    this.running = false
    this.endsAt = null
    this.emit()
  }

  private reset(): void {
    this.running = false
    this.endsAt = null
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
    if (completed) {
      this.completed[finished] += 1
      if (finished === 'focus') {
        this.focusRounds += 1
      }
      this.phaseListeners.forEach((fn) => fn(finished))
    }

    // 阶段流转：专注 → (每 roundsBeforeLong 轮一次长休) 短休 → 专注
    let next: PhaseKind = 'focus'
    if (finished === 'focus') {
      next = this.focusRounds % this.settings.roundsBeforeLong === 0 ? 'long' : 'short'
    }

    this.phase = next
    this.running = false
    this.endsAt = null
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
