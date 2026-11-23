// 计时状态机的单元测试。
//
// 测试名用规格编号（`it('C3 跳过之后不自动开始', ...)`），
// 以后看名字就知道测的是《v0.4 逻辑规格与测试清单》里的哪一条。
//
// 怎么控制时间：
//   1) `vi.useFakeTimers()` 把 setInterval 变成可控的（计时器每 200ms 跳一次）
//   2) 假时钟 `clock` 由测试自己推进，推进时两个一起走：
//      `clock += ms` 让 `now()` 前进，`vi.advanceTimersByTime(ms)` 让 tick 触发。
//      注意用的是注入的 `now()`，不是 vitest 的 Date.now——
//      这样"系统时钟被改动"这类场景也能单独模拟。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timer } from './timer'
import type { TimerConfig } from '../shared/presets'
import type { PhaseCompleteInfo } from '../shared/types'

/**
 * 一套好算的模板。
 *
 * 时长单位是分钟且最小 1 分钟（`phaseSec` 里 `Math.max(1, min) * 60`），
 * 所以休息段最短就是 60 秒——想区分长短休，得让 longMin 真的比 shortMin 大。
 *
 * 专注 1 分钟 = 60s，短休 1 分钟 = 60s，长休 2 分钟 = 120s，每 2 轮进长休。
 */
const CFG: TimerConfig = {
  focusMin: 1,
  shortMin: 1,
  longMin: 2,
  roundsBeforeLong: 2,
  autoStartNext: false,
  topicId: null
}

/** 专注段长度（秒） */
const FOCUS_SEC = 60
/** 短休段长度（秒） */
const SHORT_SEC = 60
/** 长休段长度（秒） */
const LONG_SEC = 120

let clock = 0
let timer: Timer
let infos: PhaseCompleteInfo[]

/** 推进时间：假时钟和注入的 now 一起走 */
function advance(ms: number): void {
  clock += ms
  vi.advanceTimersByTime(ms)
}

function advanceSec(sec: number): void {
  advance(sec * 1000)
}

/** 建一个计时器并收集它发出的段落结束事件 */
function makeTimer(cfg: Partial<TimerConfig> = {}): Timer {
  const t = new Timer({ ...CFG, ...cfg }, { now: () => clock })
  infos = []
  t.onPhaseComplete((info) => infos.push(info))
  return t
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_700_000_000_000 // 固定起点，避免"今天"随运行时间漂移
  timer = makeTimer()
})

afterEach(() => {
  timer.dispose()
  vi.useRealTimers()
})

// ---------------------------------------------------------------- A 基本计时

describe('A 基本计时', () => {
  it('A1 启动后是专注段、剩余等于专注时长、没有在跑', () => {
    const s = timer.getState()
    expect(s.phase).toBe('focus')
    expect(s.remainingSec).toBe(60)
    expect(s.totalSec).toBe(60)
    expect(s.running).toBe(false)
    expect(s.activeSec).toBe(0)
  })

  it('A2 跑到点进入下一阶段，并写一条 completed=true 的记录', () => {
    timer.apply('start')
    advanceSec(60)
    const s = timer.getState()
    expect(s.phase).toBe('short')
    expect(s.running).toBe(false)
    expect(infos.length).toBe(1)
    expect(infos[0].phase).toBe('focus')
    expect(infos[0].completed).toBe(true)
    expect(infos[0].plannedSec).toBe(60)
  })

  it('A3 暂停再恢复：剩余不跳，暂停时长累计，actualSec 不含暂停', () => {
    timer.apply('start')
    advanceSec(10)
    timer.apply('pause')
    expect(timer.getState().remainingSec).toBe(50)

    // 暂停 30 秒：倒计时必须纹丝不动
    advanceSec(30)
    expect(timer.getState().remainingSec).toBe(50)

    timer.apply('start')
    expect(timer.getState().remainingSec).toBe(50)
    advanceSec(50)

    expect(infos.length).toBe(1)
    expect(infos[0].pausedSec).toBe(30)
    // 实际跑了 60 秒（暂停那 30 秒不算）
    expect(infos[0].actualSec).toBe(60)
    expect(infos[0].plannedSec).toBe(60)
  })

  it('A4 暂停时改时长：当前段不变', () => {
    timer.apply('start')
    advanceSec(5)
    timer.apply('pause')
    timer.updateSettings({ ...CFG, focusMin: 50 })
    const s = timer.getState()
    expect(s.totalSec).toBe(60)
    expect(s.remainingSec).toBe(55)
  })

  it('A5 运行中改时长：当前段不动（圆环分母不跳）', () => {
    timer.apply('start')
    advanceSec(5)
    timer.updateSettings({ ...CFG, focusMin: 50 })
    const s = timer.getState()
    expect(s.totalSec).toBe(60)
    expect(s.remainingSec).toBe(55)
  })

  it('A6 未开始时改时长：立刻生效（剩余和总长一起变）', () => {
    timer.updateSettings({ ...CFG, focusMin: 50 })
    const s = timer.getState()
    expect(s.totalSec).toBe(3000)
    expect(s.remainingSec).toBe(3000)
  })

  it('L9 开头就暂停也算"跑过"：改时长不当场生效', () => {
    // 按开始又立刻暂停：剩余还是整段，但这段已经"跑过"了
    timer.apply('start')
    timer.apply('pause')
    expect(timer.getState().remainingSec).toBe(timer.getState().totalSec)

    timer.updateSettings({ ...CFG, focusMin: 50 })
    const s = timer.getState()
    expect(s.totalSec).toBe(60) // 当前段不变
    expect(s.remainingSec).toBe(60)
  })

  it('L9b 重置之后又回到"没跑过"：改时长立刻生效', () => {
    timer.apply('start')
    advanceSec(5)
    timer.apply('reset')
    timer.updateSettings({ ...CFG, focusMin: 50 })
    expect(timer.getState().totalSec).toBe(3000)
  })

  it('A7 连续暂停/恢复 5 次：pausedSec 是 5 次之和（误差 ≤ 1 秒）', () => {
    timer.apply('start')
    let pausedTotal = 0
    for (let i = 0; i < 5; i++) {
      advanceSec(2)
      timer.apply('pause')
      advanceSec(3)
      pausedTotal += 3
      timer.apply('start')
    }
    advanceSec(60 - 10) // 把剩下的跑完
    expect(infos.length).toBe(1)
    expect(Math.abs(infos[0].pausedSec - pausedTotal)).toBeLessThanOrEqual(1)
    expect(infos[0].pausedSec).toBe(15)
  })
})

// ---------------------------------------------------------------- B 阶段流转

describe('B 阶段流转', () => {
  it('B1 专注完成（第 1 轮）→ 短休', () => {
    timer.apply('start')
    advanceSec(60)
    expect(timer.getState().phase).toBe('short')
  })

  it('B2 第 2 轮专注完成 → 长休，且长休时长取模板的 longMin', () => {
    // roundsBeforeLong=2，所以第 2 轮完成后进长休
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    expect(timer.getState().phase).toBe('short')
    timer.apply('start')
    advanceSec(SHORT_SEC)
    expect(timer.getState().phase).toBe('focus')
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    expect(timer.getState().phase).toBe('long')
    expect(timer.getState().totalSec).toBe(LONG_SEC)
  })

  it('B3 长休完成 → 专注，轮次计数继续', () => {
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    timer.apply('start')
    advanceSec(SHORT_SEC)
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    expect(timer.getState().phase).toBe('long')
    timer.apply('start')
    advanceSec(LONG_SEC)
    expect(timer.getState().phase).toBe('focus')
    expect(timer.getState().focusRounds).toBe(2)
  })

  it('B4 短休完成 → 专注', () => {
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    expect(timer.getState().phase).toBe('short')
    timer.apply('start')
    advanceSec(SHORT_SEC)
    expect(timer.getState().phase).toBe('focus')
  })

  it('B5 休息段中途切模板：当前休息段不变，下一个专注段用新模板', () => {
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    expect(timer.getState().phase).toBe('short')
    expect(timer.getState().totalSec).toBe(SHORT_SEC)

    // 休息段里换成 50 分钟专注的模板
    timer.updateSettings({ ...CFG, focusMin: 50 })

    // 当前休息段长度不变
    expect(timer.getState().totalSec).toBe(SHORT_SEC)
    expect(timer.getState().remainingSec).toBe(SHORT_SEC)

    // 跑完休息段 → 下一个专注段用新模板
    timer.apply('start')
    advanceSec(SHORT_SEC)
    expect(timer.getState().phase).toBe('focus')
    expect(timer.getState().totalSec).toBe(3000)
  })

  it('B6 roundsBeforeLong 改成 2 后，下一轮起按 2 计（已积累的轮次不清零）', () => {
    // 先完成 1 轮
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    expect(timer.getState().focusRounds).toBe(1)

    // 改成每 2 轮长休
    timer.updateSettings({ ...CFG, roundsBeforeLong: 2 })
    expect(timer.getState().focusRounds).toBe(1)

    // 下一轮完成后累计到 2 → 长休
    timer.apply('start')
    advanceSec(SHORT_SEC)
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    expect(timer.getState().focusRounds).toBe(2)
    expect(timer.getState().phase).toBe('long')
  })
})

// ---------------------------------------------------------------- C 跳过与重置

describe('C 跳过与重置', () => {
  it('C1 跳过专注段：写一条 completed=false 的记录，focusRounds 不增加，进入休息段', () => {
    timer.apply('start')
    advanceSec(20)
    timer.apply('skip')

    expect(infos.length).toBe(1)
    expect(infos[0].completed).toBe(false)
    expect(infos[0].phase).toBe('focus')
    expect(infos[0].actualSec).toBe(20) // 只记真正跑掉的时间
    expect(timer.getState().focusRounds).toBe(0)
    expect(timer.getState().phase).toBe('short')
  })

  it('C1b 跳过的第一段进短休，不会因为 focusRounds=0 直接给长休', () => {
    timer.apply('skip')
    expect(timer.getState().phase).toBe('short')
  })

  it('C2 跳过休息段：不写记录，直接进专注段', () => {
    timer.apply('start')
    advanceSec(60)
    expect(timer.getState().phase).toBe('short')
    timer.apply('skip')
    expect(infos.length).toBe(1) // 只有之前专注段那一条
    expect(infos[0].phase).toBe('focus')
    expect(timer.getState().phase).toBe('focus')
  })

  it('C3 跳过之后不自动开始下一段（即使 autoStartNext 开着）', () => {
    timer.dispose()
    timer = makeTimer({ autoStartNext: true })
    timer.apply('start')
    advanceSec(10)
    timer.apply('skip')
    expect(timer.getState().running).toBe(false)
    expect(timer.getState().remainingSec).toBe(timer.getState().totalSec)
  })

  it('C4 重置当前段：剩余回到整段、暂停清零、任务名清空，阶段和轮次不变', () => {
    timer.apply('start')
    advanceSec(10)
    timer.setTask('写方案')
    timer.apply('pause')
    advanceSec(5)
    timer.apply('reset')

    const s = timer.getState()
    expect(s.phase).toBe('focus')
    expect(s.focusRounds).toBe(0)
    expect(s.remainingSec).toBe(s.totalSec)
    expect(s.running).toBe(false)
    expect(s.task).toBe('')

    // 暂停累计也被清零：接着跑完，这一段的 pausedSec 是 0
    timer.apply('start')
    advanceSec(FOCUS_SEC)
    expect(infos.length).toBe(1)
    expect(infos[0].pausedSec).toBe(0)
  })

  it('C5 暂停状态下重置：回到未开始状态', () => {
    timer.apply('start')
    advanceSec(10)
    timer.apply('pause')
    expect(timer.getState().running).toBe(false)
    timer.apply('reset')
    const s = timer.getState()
    expect(s.running).toBe(false)
    expect(s.remainingSec).toBe(s.totalSec)
    expect(s.activeSec).toBe(0)
  })
})

// ---------------------------------------------------------------- D 主题与任务名

describe('D 主题与任务名', () => {
  it('D1 启动后第一个专注段挂上当前选中的主题', () => {
    timer.dispose()
    timer = makeTimer({ topicId: 't1' })
    expect(timer.getState().topicId).toBe('t1')
    timer.apply('start')
    advanceSec(60)
    expect(infos[0].topicId).toBe('t1')
  })

  it('D2 运行中切主题：当前段记录仍是旧主题，下一段用新主题', () => {
    timer.dispose()
    timer = makeTimer({ topicId: 't1' })
    timer.apply('start')
    advanceSec(10)
    timer.updateSettings({ ...CFG, topicId: 't2' })

    // 当前段的主题没变
    expect(timer.getState().topicId).toBe('t1')
    advanceSec(50)
    expect(infos[0].topicId).toBe('t1')

    // 下一段用新主题
    expect(timer.getState().topicId).toBe('t2')
  })

  it('D3 休息段不允许设任务名', () => {
    timer.apply('start')
    advanceSec(60)
    expect(timer.getState().phase).toBe('short')
    timer.setTask('休息时写的东西')
    expect(timer.getState().task).toBe('')
  })

  it('D3b 专注段可以设任务名，且会写进这一段的记录', () => {
    timer.apply('start')
    timer.setTask('今天写方案')
    expect(timer.getState().task).toBe('今天写方案')
    advanceSec(60)
    expect(infos[0].task).toBe('今天写方案')
  })

  it('D4 写了任务名就一直在状态里（不会自己消失）', () => {
    timer.apply('start')
    timer.setTask('写一半')
    advanceSec(10)
    expect(timer.getState().task).toBe('写一半')
  })
})

// ---------------------------------------------------------------- 写错数据的 bug

describe('L1/L2 冻结段长', () => {
  it('L1 中途切模板后，记录里的 plannedSec 仍是这一段原来的长度', () => {
    timer.apply('start')
    advanceSec(10)

    // 跑到一半切模板（这一段的 60 秒已经冻结）
    timer.updateSettings({ ...CFG, focusMin: 50 })

    advanceSec(50)
    expect(infos.length).toBe(1)
    // 必须是 60（旧模板），不是 3000（新模板）
    expect(infos[0].plannedSec).toBe(60)
    expect(infos[0].actualSec).toBe(60)
  })

  it('L1b 切模板后的下一段才用新长度', () => {
    timer.apply('start')
    advanceSec(10)
    timer.updateSettings({ ...CFG, focusMin: 50 })
    advanceSec(50)
    expect(timer.getState().phase).toBe('short')
    timer.apply('start')
    advanceSec(SHORT_SEC)
    expect(timer.getState().phase).toBe('focus')
    expect(timer.getState().totalSec).toBe(3000)
  })
})

// ---------------------------------------------------------------- G 边界

describe('G 边界', () => {
  it('G1 时长为 0 或负数会被兜底成 1 分钟（60 秒）', () => {
    // 兜底发生在 phaseSec 里：Math.max(1, 分钟) * 60
    timer.dispose()
    timer = makeTimer({ focusMin: 0 })
    expect(timer.getState().totalSec).toBe(60)
    timer.dispose()
    timer = makeTimer({ focusMin: -5 })
    expect(timer.getState().totalSec).toBe(60)
  })

  it('G2 180 分钟不截断', () => {
    timer.dispose()
    timer = makeTimer({ focusMin: 180 })
    expect(timer.getState().totalSec).toBe(180 * 60)
    expect(timer.getState().remainingSec).toBe(180 * 60)
  })

  it('G3 系统休眠两小时后唤醒：剩余耗尽就立刻进下一段，不白给一整段', () => {
    timer.apply('start')
    // 一步跳过两小时
    advanceSec(2 * 3600)
    expect(timer.getState().phase).not.toBe('focus')
    expect(timer.getState().remainingSec).toBe(timer.getState().totalSec)
    expect(infos.length).toBeGreaterThanOrEqual(1)
  })

  it('G5 快速连点开始/暂停 10 次：状态一致', () => {
    for (let i = 0; i < 5; i++) {
      timer.apply('start')
      timer.apply('pause')
    }
    const s = timer.getState()
    expect(s.running).toBe(false)
    expect(s.remainingSec).toBe(s.totalSec)

    timer.apply('start')
    advanceSec(1)
    // 在跑的时候倒计时必须真的在走
    expect(timer.getState().remainingSec).toBeLessThan(timer.getState().totalSec)
    expect(timer.getState().running).toBe(true)
  })

  it('G7 两个窗口读到的是同一个状态机（订阅者拿到一致快照）', () => {
    const seen: number[] = []
    timer.subscribe((s) => seen.push(s.remainingSec))
    timer.apply('start')
    advanceSec(3)
    const a = timer.getState()
    const b = timer.getState()
    expect(a).toEqual(b)
    expect(seen.length).toBeGreaterThan(0)
  })
})
