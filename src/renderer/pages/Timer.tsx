// 主界面（计时）。
//
// 第 1 轮：假数据驱动，数字真的按秒往下走，阶段切换换整个界面的色调。
// 第 2 轮：计时状态改由主进程持有，这里只订阅显示。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Ring } from '../components/Ring'
import { Controls } from '../components/TimerControls'
import { PHASE_LABEL, PHASE_TOTAL_SEC, type PhaseKind } from '../../shared/types'

/** 假数据：今天已完成的番茄数与累计专注时长（第 3 轮接真实记录） */
const FAKE_TODAY_POMODOROS = 3
const FAKE_TOTAL_FOCUS_MIN = 87

/** 初始阶段。支持 ?phase=short 预览休息态色调（开发期看视觉稿用） */
function initialPhase(): PhaseKind {
  const p = new URLSearchParams(window.location.search).get('phase')
  return p === 'short' || p === 'long' ? p : 'focus'
}

/** 预览用：?elapsed=600 表示已经过去 600 秒，用来截有弧度的视觉稿 */
function initialElapsed(): number {
  const raw = Number(new URLSearchParams(window.location.search).get('elapsed'))
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

function format(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatDuration(min: number): string {
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

export function Timer(): React.JSX.Element {
  const [phase, setPhase] = useState<PhaseKind>(initialPhase)
  const [running, setRunning] = useState(true)
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, PHASE_TOTAL_SEC[initialPhase()] - initialElapsed())
  )
  const [breathe, setBreathe] = useState(false)

  /** 阶段结束的时刻。用时间戳算，不靠累加，避免漂移。 */
  const endsAtRef = useRef<number>(
    Date.now() + Math.max(0, PHASE_TOTAL_SEC[initialPhase()] - initialElapsed()) * 1000
  )

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0) {
        // 第 2 轮：交给主进程推进阶段，这里只负责显示
        setRunning(false)
      }
    }, 200)
    return () => window.clearInterval(id)
  }, [running])

  const toggle = useCallback(() => {
    if (running) {
      setRemaining(Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000)))
      setRunning(false)
    } else {
      endsAtRef.current = Date.now() + remaining * 1000
      setRunning(true)
      setBreathe(true)
      window.setTimeout(() => setBreathe(false), 460)
    }
  }, [running, remaining])

  const reset = useCallback(() => {
    setRunning(false)
    setRemaining(PHASE_TOTAL_SEC[phase])
  }, [phase])

  const skip = useCallback(() => {
    const next: PhaseKind = phase === 'focus' ? 'short' : 'focus'
    setPhase(next)
    setRunning(false)
    setRemaining(PHASE_TOTAL_SEC[next])
  }, [phase])

  // 空格键也能控制（方案 P0-1）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  useEffect(() => {
    // 阶段属性挂在 html 根元素上，派生色（底轨、柔光）才能跟着换色
    document.documentElement.dataset.phase = phase
  }, [phase])

  const total = PHASE_TOTAL_SEC[phase]

  return (
    <div className="main">
      <div className="phase-label">{PHASE_LABEL[phase]}</div>

      <Ring total={total} remaining={remaining} breathe={breathe}>
        <div className="ring__time">{format(remaining)}</div>
        <div className="ring__hint">{running ? '进行中' : '已暂停'}</div>
      </Ring>

      <Controls running={running} onToggle={toggle} onSkip={skip} onReset={reset} />

      <div className="status">
        <span className="status__dot">●</span> 今天第 {FAKE_TODAY_POMODOROS} 个番茄 · 累计专注{' '}
        {formatDuration(FAKE_TOTAL_FOCUS_MIN)}
      </div>
    </div>
  )
}
