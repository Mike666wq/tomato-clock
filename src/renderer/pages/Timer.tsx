// 主界面（计时）。
//
// 状态全部来自主进程：界面只读快照、发动作。
// 主进程不在的时候（比如直接在浏览器里开页面）退化为一个静态兜底状态。

import { useEffect, useRef, useState } from 'react'
import { Ring } from '../components/Ring'
import { Controls } from '../components/TimerControls'
import { PHASE_LABEL, type TimerState } from '../../shared/types'

const FALLBACK: TimerState = {
  phase: 'focus',
  running: false,
  totalSec: 25 * 60,
  remainingSec: 25 * 60,
  focusRounds: 0,
  completed: { focus: 0, short: 0, long: 0 }
}

function format(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function Timer(): React.JSX.Element {
  const [state, setState] = useState<TimerState>(FALLBACK)
  const [breathe, setBreathe] = useState(false)
  const wasRunning = useRef(false)

  // 订阅主进程状态
  useEffect(() => {
    const api = window.pomodoro
    if (!api) return
    void api.timer.getState().then(setState)
    return api.timer.onState(setState)
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
  }, [])

  const focusMinutes = state.completed.focus * 25

  return (
    <div className="main">
      <div className="phase-label">{PHASE_LABEL[state.phase]}</div>

      <Ring total={state.totalSec} remaining={state.remainingSec} breathe={breathe}>
        <div className="ring__time">{format(state.remainingSec)}</div>
        <div className="ring__hint">{state.running ? '进行中' : '已暂停'}</div>
      </Ring>

      <Controls running={state.running} onToggle={toggle} onSkip={skip} onReset={reset} />

      <div className="status">
        <span className="status__dot">●</span> 已完成 {state.focusRounds} 个番茄 · 专注累计{' '}
        {focusMinutes} 分钟
      </div>
    </div>
  )
}
