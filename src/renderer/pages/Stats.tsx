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
import type { StatsData, TimelineEntry, TopicStat } from '../../shared/types'

const W = 400
const H = 116
/** 绘图区高度（去掉底部刻度文字那一条） */
const PLOT_H = H - 34
/** x 轴基线 */
const BASE_Y = H - 18

/**
 * 今日时间线（甘特条）的几何。
 *
 * **横轴算法跟"今日按小时分布"完全共用**（`slot = W / 24`，
 * 刻度文字在 `h * slot + slot / 2`）。
 * 这不是偷懒，是规格要求：两处各写一份算法，迟早会走偏
 * （v0.6 的柱子对齐就是这么歪的）。
 *
 * 由此推出时间→坐标的映射：一个槽 = 一小时，
 * 所以"当天第 m 分钟"落在 `m / 60 * slot`。
 * 注意刻度 0/6/12/18 标的是**整点的中点**（跟上面那个图一样），
 * 0 点那条线在 0.5 个槽处 —— 所以 00:34 的段落在它右边一点点。
 */
const TL = {
  /** 泳道 */
  laneY: 12,
  laneH: 30,
  /** x 轴基线 */
  axisY: 46,
  /** 刻度文字基线 */
  labelY: 60,
  /** 画布高 */
  h: 66,
  /**
   * 块最小可见宽度（太短的段否则看不见）。
   *
   * ⚠ **1.2 单位 ≠ 真实比例**（肥鱼定的口径，别改回去）：
   * 这是一层**视觉兜底** —— 真实宽度不足 1.2 单位（≈ 4 分钟）的段，
   * 会被画得比实际宽。
   *
   * 所以：**真实时长以 hover 浮层里的数字为唯一真相**，
   * 不许拿块的宽度反推时长，也不许拿宽度做比例换算。
   * 24 小时的轴上，短段本来就画不出比例 —— 比例不是这张图要表达的东西。
   */
  minW: 1.2,
  /**
   * 块内写时长的门槛：**45 分钟**（肥鱼定的）。
   *
   * 24 小时的轴上一个槽才 16.7px，45 分钟也只有 12.5px ——
   * 再小就成噪声了，宁可不写。
   *
   * **其余信息（起止、时长、主题、任务名）全部走 hover 浮层**，
   * 不靠块内那点空间硬塞。
   *
   * 门槛按**分钟数**判，不按像素判 —— 像素宽度会随画布缩放漂移，
   * 按分钟判才是"这一段到底有没有 45 分钟"这个事实。
   */
  textMinMinutes: 45,
  /** 写"25 分"（带单位）需要的分钟数门槛 */
  textMinMinutesFull: 90
} as const

function minutes(sec: number): number {
  return Math.round(sec / 60)
}

/** 当天第几分钟 → x 坐标（0 点在 0，24 点在最右） */
function timeToX(minute: number, slot: number): number {
  return (minute / 60) * slot
}

/**
 * 今日时间线：一条泳道，今天每个段一个色块。
 *
 * 这张图相对柱状图的全部价值：**能看出"专注—休息—专注"的节奏**，
 * 所以休息段也画（只是压暗），而不只是列专注段。
 */
function TimelineChart({ data }: { data: TimelineEntry[] }): React.JSX.Element {
  const slot = W / 24
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60
  const nowX = timeToX(nowMin, slot)
  // 悬停中的那一段：详情浮层跟着它
  const [hover, setHover] = useState<{ e: TimelineEntry; x: number } | null>(null)

  return (
    <div className="timeline">
      <svg
        className="chart chart--timeline"
        viewBox={`0 0 ${W} ${TL.h}`}
        role="img"
        aria-label="今日时间线"
      >
        {/* 泳道底：一条浅槽，块画在它上面 */}
        <rect x={0} y={TL.laneY} width={W} height={TL.laneH} className="timeline__lane" />

        {data.map((e, i) => {
          const start = new Date(e.startedAt)
          const startMin = start.getHours() * 60 + start.getMinutes() + start.getSeconds() / 60
          const durMin = e.actualSec / 60
          // 跨零点的段：按开始时间归当天，但不许越过 24 点（裁到当天末尾）
          const endMin = Math.min(24 * 60, startMin + durMin)
          const x = timeToX(startMin, slot)
          const w = Math.max(TL.minW, timeToX(endMin - startMin, slot))
          const isBreak = e.kind !== 'focus'
          const cls = [
            'timeline__seg',
            !e.color && !isBreak ? 'timeline__seg--none' : '',
            isBreak ? 'timeline__seg--break' : '',
            !e.completed ? 'timeline__seg--open' : ''
          ]
            .filter(Boolean)
            .join(' ')
          // 块内写字的门槛是 **45 分钟**（肥鱼定的）：
          // 24 小时的轴上 45 分钟也只有 12.5px，再小就是噪声。
          // 其余信息全走 hover 浮层，不硬塞。
          const durMinR = Math.round(durMin)
          const showText = durMinR >= TL.textMinMinutes
          return (
            <g key={`${e.startedAt}-${i}`}>
              {/*
                原生 <title>（浏览器 tooltip）只作兜底。
                信息不全 —— 完整信息在下面那个 React 浮层里，
                它才有主题、任务名、"没跑完"这些。
              */}
              <title>{`${fmtTime(e.startedAt)} – ${fmtTime(e.endedAt)}　${durMinR} 分钟`}</title>
              <rect
                x={x}
                y={TL.laneY}
                width={w}
                height={TL.laneH}
                rx={2}
                className={cls}
                onMouseEnter={() => setHover({ e, x })}
                onMouseLeave={() => setHover(null)}
                style={{ '--topic-color': e.color || 'var(--ink-3)' } as React.CSSProperties}
              />
              {showText ? (
                <text
                  x={x + 3}
                  y={TL.laneY + TL.laneH / 2 + 3}
                  className="timeline__seg-text"
                >
                  {durMinR >= TL.textMinMinutesFull ? `${durMinR} 分` : durMinR}
                </text>
              ) : null}
            </g>
          )
        })}

      {/* 「现在」：只有今天才有这条线 */}
      {nowX >= 0 && nowX <= W ? (
        <>
          <line
            x1={nowX}
            y1={TL.laneY - 4}
            x2={nowX}
            y2={TL.axisY}
            className="timeline__now"
          />
          <text
            x={nowX > W - 26 ? nowX - 2 : nowX + 2}
            y={TL.laneY - 5}
            className="timeline__now-label"
            textAnchor={nowX > W - 26 ? 'end' : 'start'}
          >
            现在
          </text>
        </>
      ) : null}

      <line x1={0} y1={TL.axisY} x2={W} y2={TL.axisY} className="chart__axis" />
      {/* 刻度：跟"今日按小时分布"同一个算法 */}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={h * slot + slot / 2} y={TL.labelY} className="chart__label" textAnchor="middle">
          {h}
        </text>
      ))}
      <text x={W} y={TL.labelY} className="chart__label" textAnchor="end">
        24
      </text>
      </svg>

      {/*
        详情浮层：起止时间 + 时长 + 主题 + 任务名。
        块里塞不下这些（24 小时的轴上一格才十几像素），
        所以全部信息走这里。位置跟着悬停的那一段走。

        用 HTML 而不是 SVG 里的 <foreignObject>：
        文字不用跟着 viewBox 缩放，字号始终是设计好的那个大小。

        靠边时改锚点，不然浮层会跑出卡片被裁掉
        （第一版就这问题：00:34 的段在最左边，浮层左边被切掉一半）。
      */}
      {hover ? (
        <div
          className="timeline__tip"
          data-anchor={hover.x < 60 ? 'left' : hover.x > W - 60 ? 'right' : 'center'}
          style={{
            // 百分比定位：跟 svg 的缩放无关，块在哪就跟在哪
            left: `${(hover.x / W) * 100}%`
          }}
          role="tooltip"
        >
          <div className="timeline__tip-time">
            {fmtTime(hover.e.startedAt)} – {fmtTime(hover.e.endedAt)}
            {/*
              这里的分钟数是 **actualSec 算出来的真实时长**，
              不是从块的宽度反推的 —— 短段有最小可见宽兜底，
              宽度不等于比例。**浮层里的数字是唯一真相。**
            */}
            <span className="timeline__tip-dur">{minutes(hover.e.actualSec)} 分钟</span>
          </div>
          <div className="timeline__tip-topic">
            <i
              className="timeline__tip-dot"
              style={{ background: hover.e.color || 'var(--ink-3)' }}
            />
            {hover.e.kind === 'focus'
              ? hover.e.topicName || '未挂主题'
              : hover.e.kind === 'long'
                ? '长休息'
                : '短休息'}
            {hover.e.task ? <span className="timeline__tip-task">{hover.e.task}</span> : null}
          </div>
          {hover.e.kind === 'focus' && !hover.e.completed ? (
            <div className="timeline__tip-flag">没跑完</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** ISO → 本地 HH:MM */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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
        <h3 className="card__title">今日时间线</h3>
        {data.timeline.length === 0 ? (
          <div className="card__empty">今天还没有专注记录</div>
        ) : (
          <>
            <TimelineChart data={data.timeline} />
            <div className="card__note">
              横轴是 0–24 点，色块宽度是实际时长。休息段压暗，没跑完的段用虚线框。
            </div>
          </>
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
