// 统计口径的单元测试（规格 F 组）。
//
// 这里只测"数出来的对不对"，不测画图。

import { describe, expect, it } from 'vitest'
import { buildStats } from './stats'
import type { Session, Topic } from '../shared/types'

const TOPICS: Topic[] = [
  {
    id: 't1',
    name: '写代码',
    color: '#ff6b57',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    order: 0
  },
  {
    id: 't2',
    name: '读论文',
    color: '#5ac49b',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    order: 1
  }
]

/** 造一条记录。默认是"今天跑完的一个番茄" */
function session(over: Partial<Session> = {}): Session {
  const started = over.startedAt ?? new Date().toISOString()
  return {
    id: 'x',
    kind: 'focus',
    startedAt: started,
    endedAt: new Date(new Date(started).getTime() + 25 * 60 * 1000).toISOString(),
    plannedSec: 1500,
    actualSec: 1500,
    completed: true,
    task: '',
    interrupt: 'none',
    topicId: 't1',
    ...over
  }
}

describe('F 统计口径', () => {
  it('F1 今日归属按开始时间的本地日期算：跨午夜的段算开始那天', () => {
    // 今天 23:30 开始，跨到明天 00:10 结束
    const start = new Date()
    start.setHours(23, 30, 0, 0)
    const s = session({ startedAt: start.toISOString() })
    const stats = buildStats([s], TOPICS)
    expect(stats.todayCount).toBe(1)
    expect(stats.todayFocusSec).toBe(1500)
    // 按开始那天的那个小时归位
    expect(stats.todayByHour[start.getHours()]).toBe(25)
  })

  it('F3 跳过的段不计入今日专注分钟，但计入回合数', () => {
    const skipped = session({ completed: false, actualSec: 300 })
    const done = session({ actualSec: 1500 })
    const stats = buildStats([skipped, done], TOPICS)

    // 专注分钟只算跑完的那个
    expect(stats.todayFocusSec).toBe(1500)
    expect(stats.todayCount).toBe(1)

    // 回合数算两个（跳过的也占一个回合）
    const stat = stats.topicStats.all.find((t) => t.topicId === 't1')
    expect(stat?.rounds).toBe(2)
  })

  it('F3b 跳过的段不计入该主题的时长与占比', () => {
    const skipped = session({ completed: false, actualSec: 300 })
    const stats = buildStats([skipped], TOPICS)
    const stat = stats.topicStats.all.find((t) => t.topicId === 't1')
    expect(stat?.totalSec).toBe(0)
    expect(stats.totalFocusSec).toBe(0)
  })

  it('F4 打断率的分母是全部回合（含跳过），分子是有打断的', () => {
    const stats = buildStats(
      [
        session({ interrupt: 'internal' }),
        session({ completed: false, actualSec: 100 }),
        session({ completed: false, actualSec: 100 })
      ],
      TOPICS
    )
    const stat = stats.topicStats.all.find((t) => t.topicId === 't1')
    expect(stat?.rounds).toBe(3)
    expect(stat?.interruptRate).toBeCloseTo(1 / 3, 5)
  })

  it('F4b 平均时长按跑完的回合算，跳过的段不稀释它', () => {
    const stats = buildStats(
      [
        session({ actualSec: 1500 }),
        session({ actualSec: 1500 }),
        session({ completed: false, actualSec: 60 })
      ],
      TOPICS
    )
    const stat = stats.topicStats.all.find((t) => t.topicId === 't1')
    expect(stat?.avgSec).toBe(1500)
  })

  it('F5 跳过不会进"打断原因排行"（它不是被打断）', () => {
    const stats = buildStats([session({ completed: false, actualSec: 60 })], TOPICS)
    const none = stats.interrupts.find((i) => i.kind === 'none')
    expect(none?.count).toBe(0)
  })

  it('休息段不计入专注时间', () => {
    const stats = buildStats([session({ kind: 'short', actualSec: 300 })], TOPICS)
    expect(stats.todayFocusSec).toBe(0)
    expect(stats.todayCount).toBe(0)
    expect(stats.totalFocusSec).toBe(0)
  })

  it('主题被归档后，历史记录仍按当时的 topicId 归类', () => {
    const archived: Topic = {
      id: 't1',
      name: '写代码',
      color: '#ff6b57',
      archived: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      order: 0
    }
    const stats = buildStats([session({ topicId: 't1' })], [archived])
    const stat = stats.topicStats.all.find((t) => t.topicId === 't1')
    expect(stat).toBeTruthy()
    expect(stat?.rounds).toBe(1)
  })
})
