// 统计页：三张手写 SVG 图 —— 今日按小时分布 / 近 7 天趋势 / 打断原因排行。
//
// 规矩：不引图表库，只用 --accent / --line / --ink-2 三色，不做仪表盘风。

import { useEffect, useState } from 'react'
import type { StatsData } from '../../shared/types'

const W = 400
const H = 116

function minutes(sec: number): number {
  return Math.round(sec / 60)
}

/** 今日按小时分布 */
function HourChart({ data }: { data: number[] }): React.JSX.Element {
  const max = Math.max(1, ...data)
  const slot = W / 24
  const barW = slot * 0.56
  const baseY = H - 18

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="今日按小时分布">
      <line x1={0} y1={baseY} x2={W} y2={baseY} className="chart__axis" />
      {data.map((v, h) => {
        const hgt = (v / max) * (H - 34)
        const x = h * slot + (slot - barW) / 2
        return v > 0 ? (
          <rect
            key={h}
            x={x}
            y={baseY - hgt}
            width={barW}
            height={Math.max(2, hgt)}
            rx={1.5}
            className="chart__bar"
          />
        ) : null
      })}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={h * slot + slot / 2} y={H - 4} className="chart__label" textAnchor="middle">
          {h}
        </text>
      ))}
      {/* 右端补一个 24，不然最后一格悬空 */}
      <text x={W} y={H - 4} className="chart__label" textAnchor="end">
        24
      </text>
    </svg>
  )
}

/** 近 7 天趋势 */
function TrendChart({ data }: { data: StatsData['last7Days'] }): React.JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.focusSec))
  const slot = W / data.length
  const barW = slot * 0.5
  const baseY = H - 18

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="近 7 天趋势">
      <line x1={0} y1={baseY} x2={W} y2={baseY} className="chart__axis" />
      {data.map((d, i) => {
        const hgt = (d.focusSec / max) * (H - 34)
        const x = i * slot + (slot - barW) / 2
        const isToday = i === data.length - 1
        return (
          <g key={d.date}>
            {/* 没数据的日期什么都不画，只留 x 轴标签 */}
            {d.focusSec > 0 ? (
              <rect
                x={x}
                y={baseY - hgt}
                width={barW}
                height={Math.max(2, hgt)}
                rx={1.5}
                className={isToday ? 'chart__bar chart__bar--today' : 'chart__bar chart__bar--muted'}
              />
            ) : null}
            <text x={i * slot + slot / 2} y={H - 4} className="chart__label" textAnchor="middle">
              {d.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 打断原因排行 */
function InterruptChart({ data }: { data: StatsData['interrupts'] }): React.JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.count))
  const rowH = 30
  const h = data.length * rowH
  const labelW = 76
  const trackW = W - labelW - 34

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${h}`} role="img" aria-label="打断原因排行">
      {data.map((d, i) => {
        const y = i * rowH + 4
        const w = (d.count / max) * trackW
        return (
          <g key={d.kind}>
            <text x={0} y={y + 13} className="chart__label chart__label--left">
              {d.label}
            </text>
            {/* 0 值不画条，只留标签和数字 */}
            {d.count > 0 ? (
              <>
                <rect x={labelW} y={y + 3} width={trackW} height={12} rx={2} className="chart__track" />
                <rect
                  x={labelW}
                  y={y + 3}
                  width={Math.max(3, w)}
                  height={12}
                  rx={2}
                  className={d.kind === 'none' ? 'chart__bar chart__bar--muted' : 'chart__bar'}
                />
              </>
            ) : null}
            <text x={W} y={y + 14} className="chart__value" textAnchor="end">
              {d.count}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function Stats(): React.JSX.Element {
  const [data, setData] = useState<StatsData | null>(null)

  useEffect(() => {
    const api = window.pomodoro
    if (!api) return
    void api.stats.get().then(setData)
    // 回到这一页时重新拉一次
    const id = window.setInterval(() => void api.stats.get().then(setData), 5000)
    return () => window.clearInterval(id)
  }, [])

  if (!data) {
    return <div className="main main--page">读取中…</div>
  }

  const empty = data.sessions.length === 0

  if (empty) {
    return (
      <div className="main main--page">
        <div className="stats__empty">
          <div className="stats__empty-title">今天还没开始</div>
          <div className="stats__empty-sub">
            做完第一个番茄，这里会出现你的专注分布、7 天趋势和打断情况。
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="main main--page">
      <div className="stats__head">
        <div>
          <div className="stats__num">{data.todayCount}</div>
          <div className="stats__cap">今日番茄</div>
        </div>
        <div>
          <div className="stats__num">{minutes(data.todayFocusSec)}</div>
          <div className="stats__cap">今日专注（分钟）</div>
        </div>
        <div>
          <div className="stats__num">{minutes(data.totalFocusSec)}</div>
          <div className="stats__cap">累计专注（分钟）</div>
          <div className="stats__sub">含历史</div>
        </div>
      </div>

      <section className="card">
        <h3 className="card__title">今日按小时分布</h3>
        {data.todayCount === 0 ? (
          <div className="card__empty">今天还没有完成的番茄</div>
        ) : (
          <HourChart data={data.todayByHour} />
        )}
      </section>

      <section className="card">
        <h3 className="card__title">近 7 天趋势</h3>
        <TrendChart data={data.last7Days} />
      </section>

      <section className="card">
        <h3 className="card__title">打断原因排行</h3>
        <InterruptChart data={data.interrupts} />
      </section>
    </div>
  )
}
