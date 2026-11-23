// 「今天」的口径只有一处实现 —— 这里钉住它（v0.6 缺陷 D3）。
//
// 以前主界面按结束时间算、统计页按开始时间算，
// 跨零点的那一条番茄，两边给出两个数。

import { describe, expect, it } from 'vitest'
import { isToday, localDateKey, msUntilNextMidnight, sessionDayKey } from './day'

describe('D3 今天只有一个口径', () => {
  it('D3-1 本地日期键是 YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 10, 23, 15, 4, 5))).toBe('2026-11-23')
    expect(localDateKey(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01')
  })

  it('D3-2 记录按开始时间归属某一天', () => {
    // 23:50 开始、第二天 00:10 结束 → 算开始那天
    const startedAt = new Date(2026, 10, 23, 23, 50, 0).toISOString()
    const endedAt = new Date(2026, 10, 24, 0, 10, 0).toISOString()
    expect(sessionDayKey(startedAt)).toBe('2026-11-23')
    // 结束时间属于第二天，但归属只看开始时间
    expect(new Date(endedAt).getDate()).toBe(24)
    expect(isToday(startedAt, new Date(2026, 10, 23, 23, 59, 59))).toBe(true)
    expect(isToday(startedAt, new Date(2026, 10, 24, 0, 10, 0))).toBe(false)
  })

  it('D3-3 距离下一个零点的毫秒数', () => {
    // 23:59:57 → 还有 3 秒
    expect(msUntilNextMidnight(new Date(2026, 10, 23, 23, 59, 57, 0))).toBe(3000)
    // 00:00:00 → 还有一整天
    expect(msUntilNextMidnight(new Date(2026, 10, 23, 0, 0, 0, 0))).toBe(24 * 3600 * 1000)
    // 至少 1 秒，不会变成 0（setTimeout(0) 会立刻反复触发）
    expect(msUntilNextMidnight(new Date(2026, 10, 23, 23, 59, 59, 999))).toBeGreaterThanOrEqual(1000)
  })
})
