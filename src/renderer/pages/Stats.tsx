// 统计页：手写 SVG 图 —— 今日按小时分布 / 近 7 天趋势 / 打断原因排行 / 主题时间占比。
//
// 规矩：不引图表库，只用 --accent / --line / --ink-2 三色，不做仪表盘风。
//
// v0.6 的两条硬规矩（都是用户提的）：
//
// 1. **各板块固定存在**。没数据就在卡片里显示一行空态文案，
//    不许"没数据就不渲染这块" —— 用户会以为功能没做，而不是"还没数据"。
// 2. **三张数字卡同构**：数字 + 单位小字 + 标签，等宽等高。
//    以前"今日番茄"没有单位、另外两张把"分钟"塞在数字右边，三张长得不一样。

import { useEffect, useState } from 'react'
import type { StatsData, TopicStat } from '../../shared/types'

const W = 400
const H = 116
/** 绘图区高度（去掉底部刻度文字那一条） */
const PLOT_H = H - 34
/** x 轴基线 */
const BASE_Y = H - 18

function minutes(sec: number): number {
  return Math.round(sec / 60)
}

/** 今日按小时分布 */
function HourChart({ data }: { data: number[] }): React.JSX.Element {
  const max = Math.max(1, ...data)
  const slot = W / 24
  const barW = slot * 0.56

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="今日按小时分布">
      <line x1={0} y1={BASE_Y} x2={W} y2={BASE_Y} className="chart__axis" />
      {/* 最大值参考线：只有一根柱子时，没有参照就不知道它到底有多高 */}
      <line x1={0} y1={BASE_Y - PLOT_H} x2={W} y2={BASE_Y - PLOT_H} className="chart__ref" />
      <text x={W} y={BASE_Y - PLOT_H - 4} className="chart__ref-label" textAnchor="end">
        最高 {max} 分钟
      </text>
      {data.map((v, h) => {
        const hgt = (v / max) * PLOT_H
        // 柱子中心对准这一小时的中点，刻度文字也在中点 —— 两者必须同一个算法
        const x = h * slot + (slot - barW) / 2
        return v > 0 ? (
          <rect
            key={h}
            x={x}
            y={BASE_Y - hgt}
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

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="近 7 天趋势">
      <line x1={0} y1={BASE_Y} x2={W} y2={BASE_Y} className="chart__axis" />
      <line x1={0} y1={BASE_Y - PLOT_H} x2={W} y2={BASE_Y - PLOT_H} className="chart__ref" />
      <text x={W} y={BASE_Y - PLOT_H - 4} className="chart__ref-label" textAnchor="end">
        最高 {minutes(max)} 分钟
      </text>
      {data.map((d, i) => {
        const hgt = (d.focusSec / max) * PLOT_H
        // 柱子中心 = 日期标签的中心（同一个 slot 中点），别各算各的
        const x = i * slot + (slot - barW) / 2
        const isToday = i === data.length - 1
        return (
          <g key={d.date}>
            {/* 没数据的日期什么都不画，只留 x 轴标签 */}
            {d.focusSec > 0 ? (
              <rect
                x={x}
                y={BASE_Y - hgt}
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
  const total = data.reduce((sum, d) => sum + d.count, 0)
  if (total === 0) {
    return <div className="card__empty">还没有记录</div>
  }
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

/** 主题时间占比横条排行（带回合数、总时长、平均时长、打断率） */
function TopicBars({ data }: { data: TopicStat[] }): React.JSX.Element {
  if (!data.length) {
    return <div className="card__empty">还没有挂主题的番茄</div>
  }
  const max = Math.max(1, ...data.map((d) => d.totalSec))
  return (
    <div className="topic-bars">
      {data.map((d) => (
        <div key={d.topicId ?? 'none'} className="topic-bar">
          <div className="topic-bar__head">
            <span className="topic-bar__dot" style={{ background: d.color }} />
            <span className="topic-bar__name">{d.name}</span>
            <span className="topic-bar__min">{minutes(d.totalSec)} 分钟</span>
            <span className="topic-bar__share">{Math.round(d.share * 100)}%</span>
          </div>
          <div className="topic-bar__track">
            {/* 主题色不直接写进 background，而是塞进 --topic-color：
                主题层可以决定"这条横条长什么样"（纸感下改成墨色打底 + 一点主题色），
                组件里不写死配色。色点那个圆点保留用户选的原色。 */}
            <div
              className="topic-bar__fill"
              style={
                {
                  width: `${(d.totalSec / max) * 100}%`,
                  '--topic-color': d.color
                } as React.CSSProperties
              }
            />
          </div>
          <div className="topic-bar__meta">
            <span>
              {d.rounds} 个番茄 · 平均 {minutes(d.avgSec)} 分钟
            </span>
            <span className={d.interruptRate > 0 ? 'topic-bar__rate topic-bar__rate--bad' : 'topic-bar__rate'}>
              打断率 {Math.round(d.interruptRate * 100)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

export function Stats(): React.JSX.Element {
  const [data, setData] = useState<StatsData | null>(null)
  const [scope, setScope] = useState<'week' | 'all'>('week')

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

  return (
    <div className="main main--page">
      {/* 三张卡同构：数字 + 单位小字 + 标签，等宽等高 */}
      <div className="stats__head">
        <div className="stats__card">
          <div className="stats__num">
            {data.todayCount}
            <span className="stats__unit">个</span>
          </div>
          <div className="stats__cap">今日番茄</div>
        </div>
        <div className="stats__card">
          <div className="stats__num">
            {minutes(data.todayFocusSec)}
            <span className="stats__unit">分钟</span>
          </div>
          <div className="stats__cap">今日专注</div>
        </div>
        <div className="stats__card">
          <div className="stats__num">
            {minutes(data.totalFocusSec)}
            <span className="stats__unit">分钟</span>
          </div>
          <div className="stats__cap">累计专注</div>
        </div>
      </div>

      {/* 下面每一块都固定存在。没数据就在卡片里写一句空态，
          不整块消失 —— 用户会以为功能没做。 */}

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
        {data.last7Days.every((d) => d.focusSec === 0) ? (
          <div className="card__empty">最近 7 天还没有专注记录</div>
        ) : (
          <>
            <TrendChart data={data.last7Days} />
            {/* 灰柱是"往日"，红柱是"今天"——不写出来用户看不懂 */}
            <div className="chart-legend">
              <span className="chart-legend__item">
                <i className="chart-legend__swatch chart-legend__swatch--today" />
                今天
              </span>
              <span className="chart-legend__item">
                <i className="chart-legend__swatch chart-legend__swatch--past" />
                往日
              </span>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h3 className="card__title">主题时间占比</h3>
        <div className="scope">
          <button className={scope === 'week' ? 'scope__btn scope__btn--on' : 'scope__btn'} onClick={() => setScope('week')}>
            本周
          </button>
          <button className={scope === 'all' ? 'scope__btn scope__btn--on' : 'scope__btn'} onClick={() => setScope('all')}>
            全部
          </button>
        </div>
        <TopicBars data={data.topicStats[scope]} />
        <div className="card__note">打断率 = 这个主题的回合里被打断的比例。主流产品都不给这个数。</div>
      </section>

      <section className="card">
        <h3 className="card__title">打断原因排行</h3>
        <InterruptChart data={data.interrupts} />
      </section>

      <section className="card">
        <h3 className="card__title">今日概览</h3>
        {data.todayTopics.length === 0 ? (
          <div className="card__empty">今天还没有完成的番茄</div>
        ) : (
          <>
            <div className="card__note">
              今天 {data.todayTopicCount} 个主题 · {data.todayCount} 个番茄
            </div>
            {data.todayTopics.map((t) => (
              <div key={t.topicId ?? 'none'} className="topic-today">
                <span className="topic-bar__dot" style={{ background: t.color }} />
                <span className="topic-today__name">{t.name}</span>
                <span className="topic-today__num">
                  {t.rounds} 个番茄 · {minutes(t.totalSec)} 分钟
                </span>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  )
}
