// 主界面（计时）。
//
// 状态全部来自主进程：界面只读快照、发动作。
// 主进程不在的时候（比如直接在浏览器里开页面）退化为一个静态兜底状态。

import { useEffect, useRef, useState } from 'react'
import { Ring } from '../components/Ring'
import { Controls } from '../components/TimerControls'
import { PresetBar } from '../components/PresetBar'
import { TopicBar } from '../components/TopicBar'
import { keyCapture } from '../keyCapture'
import { PHASE_LABEL, type RecordSummary, type Settings, type TimerState } from '../../shared/types'

const FALLBACK: TimerState = {
  phase: 'focus',
  running: false,
  totalSec: 25 * 60,
  remainingSec: 25 * 60,
  activeSec: 0,
  focusRounds: 0,
  completed: { focus: 0, short: 0, long: 0 },
  topicId: null,
  activeTopicId: null,
  task: ''
}

const EMPTY_SUMMARY: RecordSummary = { todayCount: 0, todayFocusSec: 0, totalFocusSec: 0 }

function format(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function Timer(): React.JSX.Element {
  const [state, setState] = useState<TimerState>(FALLBACK)
  const [summary, setSummary] = useState<RecordSummary>(EMPTY_SUMMARY)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [breathe, setBreathe] = useState(false)
  const [ringSize, setRingSize] = useState(320)
  const ringAreaRef = useRef<HTMLDivElement>(null)
  const wasRunning = useRef(false)

  /**
   * 圆环按可用空间缩放，不能写死。
   * 之前写死 320px，用户把窗口缩到 500×589 之后环把下面全顶出去了，
   * 模板条压到导航栏上、状态行被挤没 —— 那是我的锅。
   * 规则：min(420, 可用宽 - 96, 可用高 × 0.52)，最小 200。
   */
  useEffect(() => {
    const el = ringAreaRef.current
    if (!el) return
    const measure = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      // 0.78：这个区域现在只装圆环（按钮那组在它下面单独占位），
      // 早先用 0.52 是怕压到底下的东西，现在结构上压不到了，可以放大
      const next = Math.max(200, Math.min(420, w - 96, h * 0.78))
      setRingSize(Math.round(next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 订阅主进程状态
  useEffect(() => {
    const api = window.pomodoro
    if (!api) return
    void api.timer.getState().then(setState)
    void api.records.summary().then(setSummary)
    void api.settings.get().then(setSettings)
    const offState = api.timer.onState(setState)
    const offSummary = api.records.onSummary(setSummary)
    const offSettings = api.settings.onChanged(setSettings)
    return () => {
      offState()
      offSummary()
      offSettings()
    }
  }, [])

  // 阶段属性挂在 html 根元素上，派生色（底轨、柔光）才能跟着换色
  useEffect(() => {
    document.documentElement.dataset.phase = state.phase
  }, [state.phase])

  // 开始计时那一刻圆环轻微"呼吸"一次，作为仪式感
  useEffect(() => {
    if (state.running && !wasRunning.current) {
      setBreathe(true)
      const t = window.setTimeout(() => setBreathe(false), 460)
      wasRunning.current = true
      return () => window.clearTimeout(t)
    }
    wasRunning.current = state.running
  }, [state.running])

  const toggle = (): void => window.pomodoro?.timer.action('toggle')
  const skip = (): void => window.pomodoro?.timer.action('skip')
  const reset = (): void => window.pomodoro?.timer.action('reset')

  // 空格键也能控制（方案 P0-1）。正在改键时让路
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (keyCapture.active) return
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const todayMin = Math.round(summary.todayFocusSec / 60)
  const totalMin = Math.round(summary.totalFocusSec / 60)

  /**
   * 三种状态要分开：
   *   未开始（这一段一秒都没跑过）→ 准备开始
   *   运行中 → 进行中
   *   跑过之后被打断 → 已暂停
   * 一段从来没跑过就说"已暂停"是错的，用户会以为刚才发生过什么。
   */
  const hint = state.running ? '进行中' : state.activeSec > 0 ? '已暂停' : '准备开始'

  return (
    <div className="main main--timer">
      <div className="phase-label">{PHASE_LABEL[state.phase]}</div>

      {/* 中部：自适应高度，装不下就滚，绝不压到底下的东西 */}
      <div className="timer__ring" ref={ringAreaRef}>
        <Ring total={state.totalSec} remaining={state.remainingSec} breathe={breathe} size={ringSize}>
          <div className="ring__time">{format(state.remainingSec)}</div>
          <div className="ring__hint">{hint}</div>
        </Ring>
      </div>

      {/* 底部：固定贴底的一组 */}
      <div className="timer__bottom">
        <Controls running={state.running} onToggle={toggle} onSkip={skip} onReset={reset} />

        {settings && settings.presets.length > 0 ? (
          <PresetBar
            presets={settings.presets}
            activeId={settings.activePresetId}
            running={state.running}
            onPick={(id) => window.pomodoro?.settings.save({ activePresetId: id })}
          />
        ) : null}

        {settings ? (
          <TopicBar
            topics={settings.topics ?? []}
            activeId={state.topicId ?? null}
            onPick={(id) => window.pomodoro?.settings.save({ activeTopicId: id })}
          />
        ) : null}

        <div className="status">
          <span className="status__dot">●</span> 今日 {summary.todayCount} 个番茄 · 今日专注 {todayMin} 分钟 ·
          累计 {totalMin} 分钟
        </div>
      </div>
    </div>
  )
}
