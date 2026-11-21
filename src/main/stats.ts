// 统计聚合：今日按小时分布、近 7 天趋势、打断原因排行。
//
// 放在主进程算，界面只负责画——日期口径只有一处，不会两边算出两个"今天"。

import type { InterruptKind, Session, StatsData } from '../shared/types'

export type { StatsData }

const INTERRUPT_LABELS: Record<InterruptKind, string> = {
  none: '没被打断',
  internal: '内部打断',
  external: '外部打断'
}

function localDateKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function buildStats(sessions: Session[]): StatsData {
  const todayKey = localDateKey(new Date())

  const todayByHour = new Array<number>(24).fill(0)
  const byDate = new Map<string, number>()
  const interrupts: Record<InterruptKind, number> = { none: 0, internal: 0, external: 0 }

  let todayCount = 0
  let todayFocusSec = 0
  let totalFocusSec = 0

  for (const s of sessions) {
    const started = new Date(s.startedAt)
    const dayKey = localDateKey(started)

    if (s.kind === 'focus') {
      totalFocusSec += s.actualSec ?? 0
      byDate.set(dayKey, (byDate.get(dayKey) ?? 0) + (s.actualSec ?? 0))
      if (s.completed && dayKey === todayKey) {
        todayCount += 1
        todayFocusSec += s.actualSec ?? 0
        todayByHour[started.getHours()] += Math.round((s.actualSec ?? 0) / 60)
      }
    }

    interrupts[s.interrupt] = (interrupts[s.interrupt] ?? 0) + 1
  }

  // 近 7 天
  const last7Days: StatsData['last7Days'] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = localDateKey(d)
    last7Days.push({
      date: key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      focusSec: byDate.get(key) ?? 0
    })
  }

  return {
    todayCount,
    todayFocusSec,
    totalFocusSec,
    todayByHour,
    last7Days,
    interrupts: (['none', 'internal', 'external'] as InterruptKind[]).map((kind) => ({
      kind,
      label: INTERRUPT_LABELS[kind],
      count: interrupts[kind] ?? 0
    })),
    sessions
  }
}
