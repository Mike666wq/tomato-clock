// 统计聚合：今日按小时分布、近 7 天趋势、打断原因排行。
//
// 放在主进程算，界面只负责画——日期口径只有一处，不会两边算出两个"今天"。

import type { InterruptKind, Session, StatsData, TopicStat } from '../shared/types'
import type { Topic } from '../shared/topics'
import { UNTITLED } from '../shared/topics'

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

/** 本周一 0 点（本地） */
function weekStart(): Date {
  const d = new Date()
  const day = d.getDay() // 0=周日
  const diff = (day + 6) % 7 // 周一为 0
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

type Bucket = {
  rounds: number
  totalSec: number
  interrupted: number
}

/** 按主题聚合一组记录 */
function groupByTopic(sessions: Session[], topics: Topic[]): Map<string | null, Bucket> {
  const map = new Map<string | null, Bucket>()
  for (const s of sessions) {
    if (s.kind !== 'focus') continue
    if (!s.completed) continue
    const key = s.topicId ?? null
    const b = map.get(key) ?? { rounds: 0, totalSec: 0, interrupted: 0 }
    b.rounds += 1
    b.totalSec += s.actualSec ?? 0
    if (s.interrupt !== 'none') b.interrupted += 1
    map.set(key, b)
  }
  void topics
  return map
}

function toStats(buckets: Map<string | null, Bucket>, topics: Topic[]): TopicStat[] {
  const list: TopicStat[] = []
  for (const [topicId, b] of buckets) {
    const topic = topics.find((t) => t.id === topicId)
    list.push({
      topicId,
      name: topic?.name ?? (topicId ? UNTITLED : UNTITLED),
      color: topic?.color ?? '#9aa1ac',
      rounds: b.rounds,
      totalSec: b.totalSec,
      avgSec: b.rounds > 0 ? Math.round(b.totalSec / b.rounds) : 0,
      interruptRate: b.rounds > 0 ? b.interrupted / b.rounds : 0,
      share: 0
    })
  }
  // 占比：同一口径下总和为 1
  const total = list.reduce((sum, x) => sum + x.totalSec, 0)
  for (const x of list) x.share = total > 0 ? x.totalSec / total : 0
  list.sort((a, b) => b.totalSec - a.totalSec)
  return list
}

export function buildStats(sessions: Session[], topics: Topic[] = []): StatsData {
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

  // 主题维度：本周 / 全部
  const weekFrom = weekStart().getTime()
  const weekSessions = sessions.filter((s) => new Date(s.startedAt).getTime() >= weekFrom)
  const topicStats = {
    week: toStats(groupByTopic(weekSessions, topics), topics),
    all: toStats(groupByTopic(sessions, topics), topics)
  }

  // 今日概览：按主题分组
  const todaySessions = sessions.filter(
    (s) => s.kind === 'focus' && s.completed && localDateKey(new Date(s.startedAt)) === todayKey
  )
  const todayBuckets = groupByTopic(todaySessions, topics)
  const todayTopics = [...todayBuckets.entries()]
    .map(([topicId, b]) => {
      const topic = topics.find((t) => t.id === topicId)
      return {
        topicId,
        name: topic?.name ?? UNTITLED,
        color: topic?.color ?? '#9aa1ac',
        rounds: b.rounds,
        totalSec: b.totalSec
      }
    })
    .sort((a, b) => b.totalSec - a.totalSec)

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
    topicStats,
    todayTopics,
    todayTopicCount: todayTopics.length,
    sessions
  }
}
