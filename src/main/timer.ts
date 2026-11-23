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

import { PHASE_LABEL, type PhaseCompleteInfo, type PhaseKind, type RunningSnapshot, type TimerState } from '../shared/types'
import type { TimerConfig } from '../shared/presets'

export type TimerAction = 'toggle' | 'start' | 'pause' | 'skip' | 'reset'

/**
 * 计时器的依赖注入点。
 *
 * 以前时间全部直连 `Date.now()`，于是"系统休眠两小时后唤醒"（G3）、
 * "两个窗口同时操作"（G7）这类行为根本没法测——只能靠真的等。
 * 现在把时钟抽出来，测试里传假时钟，时间相关的规格就能一条条断。
 */
export type TimerOptions = {
  /** 当前时刻（毫秒）。默认 `Date.now` */
  now?: () => number
}

export class Timer {
  private cfg: TimerConfig
  /** 注入的时钟。测试里换掉它就能控制时间 */
  private readonly now: () => number
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
  /** 当前这一段累计暂停毫秒 */
  private pausedMs = 0
  /**
   * 这一段有没有真的跑起来过（L9）。
   * 不用"剩余 == 总长"来判断未开始——用户在开头就暂停时两者相等，
   * 但那也是跑过了，改时长就不该当场生效。
   */
  private segmentHasRun = false
  /**
   * 段序号：每换一段 +1（规格 E 组）。
   * 主进程靠它发现"换段了"，从而跳过防抖立刻落盘——
   * 否则跳过之后有 1 秒窗口，文件里还留着上一段（E9）。
   */
  private segmentSeq = 0
  /** 本次暂停的开始时刻 */
  private pauseStartedAt: number | null = null
  /**
   * 当前这一段挂在哪个主题上（v0.3-b）。
   * 规则跟时长一样：中途切主题只影响下一段，当前段不变。
   */
  private segmentTopicId: string | null = null
  /** 当前这一段的任务名（灵动岛上就地编辑） */
  private segmentTask = ''

  constructor(cfg: TimerConfig, options: TimerOptions = {}) {
    this.cfg = cfg
    this.now = options.now ?? ((): number => Date.now())
    this.remainingSecCached = this.phaseSec('focus')
    this.segmentTotalSec = this.remainingSecCached
    // 第一段也要挂上当前选中的主题。
    // 之前漏了这一行：segmentTopicId 默认 null，而它只在 updateSettings / reset / advance
    // 里才被赋值，于是"每次启动应用后的第一个专注段"永远记成未分类，
    // 用户明明在设置里选着主题，跑完一看记录还是未分类。
    this.segmentTopicId = cfg.topicId
    this.phaseStartedAt = this.now()

    if (import.meta.env.DEV) {
      this.devSeed = (phase?: PhaseKind, elapsedSec = 0): void => {
        if (phase) this.phase = phase
        this.phaseStartedAt = this.now()
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
    // D3：休息段不允许设任务名。休息段的任务没有意义，
    // 而且会被原样写进休息段的记录里，统计时多出一堆没用的文本。
    if (this.phase !== 'focus') return
    this.segmentTask = text
    this.emit()
  }

  /**
   * 导出当前这一段的快照（规格 E 组）。
   *
   * 纯数据，不做任何 IO——落盘由主进程负责，这样 `Timer` 仍是可测的纯逻辑类。
   */
  getSnapshot(): RunningSnapshot {
    const total = this.segmentTotalSec
    const remaining = this.remainingSec()
    return {
      v: 1,
      phase: this.phase,
      running: this.running,
      segmentTotalSec: total,
      remainingSec: remaining,
      pausedSec: Math.round(
        (this.pausedMs + (this.pauseStartedAt ? this.now() - this.pauseStartedAt : 0)) / 1000
      ),
      startedAt: new Date(this.phaseStartedAt).toISOString(),
      savedAt: new Date(this.now()).toISOString(),
      task: this.segmentTask,
      topicId: this.segmentTopicId,
      segmentSeq: this.segmentSeq,
      focusRounds: this.focusRounds,
      completed: { ...this.completed }
    }
  }

  /**
   * 用快照恢复（规格 E1/E2/E3/E5）。
   *
   * **恢复出来一律是暂停态**（E0：应用退出 = 暂停）：
   * 关掉程序期间时间不前进，所以"退出那一刻的剩余"就是恢复后的剩余，
   * 不需要推算、不需要补记——机器都没开，凭什么替他记一个番茄。
   */
  restore(snapshot: RunningSnapshot): void {
    this.phase = snapshot.phase
    this.running = false
    this.endsAt = null
    this.pauseStartedAt = null
    this.pausedMs = Math.max(0, snapshot.pausedSec) * 1000
    // 段长用快照里那一份（E5）：期间改过设置也不能把正在跑的段改掉
    this.segmentTotalSec = Math.max(1, snapshot.segmentTotalSec)
    this.remainingSecCached = Math.max(0, Math.min(snapshot.remainingSec, this.segmentTotalSec))
    this.segmentTopicId = snapshot.topicId ?? null
    this.segmentTask = snapshot.task ?? ''
    // 恢复出来的段算"跑过"：改时长不该当场生效
    this.segmentHasRun = true
    this.segmentSeq = snapshot.segmentSeq ?? 0
    this.focusRounds = Math.max(0, snapshot.focusRounds ?? 0)
    this.completed = {
      focus: snapshot.completed?.focus ?? 0,
      short: snapshot.completed?.short ?? 0,
      long: snapshot.completed?.long ?? 0
    }
    const started = Date.parse(snapshot.startedAt)
    this.phaseStartedAt = Number.isFinite(started) ? started : this.now()
    this.lastEmittedSec = -1
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
    // L9：判断"这一段有没有开始过"不能看"剩余 == 总长"。
    // 用户在开头就按了暂停，剩余确实等于总长，但那也是"跑过"——
    // 按老写法，这种情况下改时长会当场生效，和 A4/A5 冲突。
    // 改用"这一段有没有真的跑起来过"这个标记。
    const notStarted = !this.segmentHasRun
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
    return Math.max(0, Math.ceil((this.endsAt - this.now()) / 1000))
  }

  private start(): void {
    if (this.running) return
    // L10：剩余恰好为 0 时不能被重置成整段。
    // 用 `=== 0` 判断"从没跑过"，而不是" falsy"——0 是 falsy，
    // 但 0 也是一个合法的剩余值（刚到点、还没 advance）。
    if (this.remainingSecCached === 0) this.remainingSecCached = this.segmentTotalSec
    this.endsAt = this.now() + this.remainingSecCached * 1000
    this.running = true
    this.segmentHasRun = true
    // 恢复计时：把这次暂停的时长累计进去
    if (this.pauseStartedAt !== null) {
      this.pausedMs += this.now() - this.pauseStartedAt
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
    this.pauseStartedAt = this.now()
    this.emit()
  }

  /**
   * 重置**当前这一段**（规格 C4/C5）。
   *
   * 只重置这一段：剩余回到整段、暂停累计清零、任务名清空；
   * **阶段不变、focusRounds 不变**（不是重置整个循环）。
   *
   * 段长用冻结的 `segmentTotalSec`，不重新读模板：
   * 这和 A4/A5 是一致的——运行中改时长，当前段的长度不动，
   * 重置只是"把这一段从头再跑一遍"，不是"换一套模板"。
   */
  private reset(): void {
    this.running = false
    this.endsAt = null
    this.pauseStartedAt = null
    this.pausedMs = 0
    // 重置后这一段又回到"没跑过"：改时长会立刻生效
    this.segmentHasRun = false
    // 重置算换了一段：主进程要立刻落盘，不能等防抖
    this.segmentSeq += 1
    this.phaseStartedAt = this.now()
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

  /**
   * 推进到下一阶段。
   *
   * completed=true  = 这一段自然跑完
   * completed=false = 用户跳过（规格 C1/C2）
   */
  private advance(completed: boolean): void {
    const finished = this.phase
    // L1：段长必须用**冻结的** segmentTotalSec，不能用 phaseSec(phase)——
    // phaseSec 读的是当前设置，而中途切过模板时这一段的长度早就被冻住了。
    // 用错的话，"中途切模板的那个番茄"记录里的 plannedSec / actualSec 全是错的。
    const plannedSec = this.segmentTotalSec
    const endedAt = this.now()

    // 跳过休息段不写记录（规格 C2）；跳过专注段要写一条 completed=false 的（规格 C1）
    const shouldRecord = completed || finished === 'focus'

    if (shouldRecord) {
      if (completed) {
        this.completed[finished] += 1
        if (finished === 'focus') {
          this.focusRounds += 1
        }
      }
      // 实际跑起来的秒数：倒计时只在"跑"的时候走，所以
      // 实际秒数 = 计划 - 剩余（此刻剩余已归零），暂停时间不进这个数。
      // L2：这里的 plannedSec 必须是冻结的段长，否则这一步跟着一起错。
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
        task: finished === 'focus' ? this.segmentTask : '',
        topicId: finished === 'focus' ? this.segmentTopicId : null,
        // completed=false = 被跳过了，不是"跑完了"
        completed
      }
      this.phaseListeners.forEach((fn) => fn(info))
    }

    // 阶段流转：专注 → (每 roundsBeforeLong 轮一次长休) 短休 → 专注
    //
    // 长休只由"跑完"赚来：跳过永远进短休。
    // 否则第一段就跳过的话，focusRounds 还是 0，0 % 4 === 0 会直接给一个 15 分钟长休——
    // "我把番茄跳过了，结果被罚休息 15 分钟"，这显然不是本意（规格 L6 / C1）。
    let next: PhaseKind = 'focus'
    if (finished === 'focus') {
      next = completed && this.focusRounds % this.cfg.roundsBeforeLong === 0 ? 'long' : 'short'
    }

    this.phase = next
    this.running = false
    this.endsAt = null
    this.pauseStartedAt = null
    this.pausedMs = 0
    // 新的一段：还没跑过
    this.segmentHasRun = false
    // 换段了：主进程据此立刻落盘（E9：跳过的段不能留在快照里）
    this.segmentSeq += 1
    this.phaseStartedAt = endedAt
    // 新的一段开始：主题用"此刻"选中的那个（用户可能刚在休息里切过）
    this.segmentTopicId = this.cfg.topicId
    // 任务名是"这一段"的，新的一段从头开始
    this.segmentTask = ''
    // 下一段用新的时长
    this.segmentTotalSec = this.phaseSec(next)
    this.remainingSecCached = this.segmentTotalSec
    this.emit()

    // C3：跳过之后**不自动开始**下一段，即使 autoStartNext 开着。
    // 用户主动跳过通常是想换一件事，不该被立刻按进下一段。
    if (completed && this.cfg.autoStartNext) {
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
