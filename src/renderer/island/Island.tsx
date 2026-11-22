// 灵动岛的渲染层：贴顶胶囊。
//
// 计时状态全部来自主进程（和主窗口共用同一个状态机），
// 这里不自己算时间、不自己存状态，只读快照。

import { useEffect, useState } from 'react'
import type { TimerState } from '../../shared/types'

/** 秒 → mm:ss */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export default function Island(): React.JSX.Element {
  const [state, setState] = useState<TimerState | null>(null)

  useEffect(() => {
    const api = window.island
    if (!api) return
    void api.timer.getState().then(setState)
    return api.timer.onState(setState)
  }, [])

  // 阶段色靠 html 上的 data 属性驱动：tokens.css 里 html[data-phase] 换 --phase，
  // 圆点、进度条都跟着变，渲染层不写死任何颜色。
  useEffect(() => {
    const el = document.documentElement
    if (!state) return
    el.dataset.phase = state.phase
    el.dataset.paused = state.running ? '0' : '1'
  }, [state])

  const remaining = state ? state.remainingSec : 0
  const phaseText = state ? (state.phase === 'focus' ? '专注' : state.phase === 'short' ? '短休' : '长休') : ''

  return (
    <div className="island" title={phaseText}>
      <span className="island__dot" />
      <span className="island__time">{formatTime(remaining)}</span>
    </div>
  )
}
