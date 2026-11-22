// 灵动岛的渲染层：贴顶胶囊。
//
// 计时状态全部来自主进程（和主窗口共用同一个状态机），
// 这里不自己算时间、不自己存状态，只读快照。
//
// 交互（方案第三节）：
//   收起态单击 = 开始 / 暂停（最常用的动作给最短路径，不展开）
//   悬停 120ms 展开，离开 400ms 收起
//   展开态：暂停/继续 · 跳过 · 打开主界面；点时间数字也开主界面
//   Esc 收起

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TimerState } from '../../shared/types'
import { OpenIcon, PauseIcon, PlayIcon, SkipIcon } from './Icons'

/** 悬停多久展开 */
const HOVER_OPEN_MS = 120
/** 离开多久收起 */
const HOVER_CLOSE_MS = 400

/** 秒 → mm:ss */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export default function Island(): React.JSX.Element {
  const [state, setState] = useState<TimerState | null>(null)
  const [expanded, setExpanded] = useState(false)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

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

  /** 收起 / 展开：本地状态决定画什么，主进程据此改窗口大小 */
  const setMode = useCallback((next: boolean) => {
    setExpanded(next)
    window.island?.island.setMode(next ? 'expanded' : 'collapsed')
  }, [])

  // 悬停展开 / 离开收起
  const onEnter = useCallback(() => {
    if (openTimer.current) window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => setMode(true), HOVER_OPEN_MS)
  }, [setMode])

  const onLeave = useCallback(() => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setMode(false), HOVER_CLOSE_MS)
  }, [setMode])

  // Esc 收起
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setMode])

  useEffect(
    () => () => {
      if (openTimer.current) window.clearTimeout(openTimer.current)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    []
  )

  const toggle = (): void => window.island?.timer.action('toggle')
  const skip = (): void => window.island?.timer.action('skip')
  const openMain = (): void => window.island?.island.openMain()

  /**
   * 收起态单击 = 开始 / 暂停，不展开。
   * 点之前把"悬停展开"的定时器撤掉：否则点完 120ms 后它自己展开了，
   * 用户以为点了没用。
   */
  const onCollapsedClick = (): void => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    toggle()
  }

  const remaining = state ? state.remainingSec : 0
  const running = state?.running ?? false
  const percent = state && state.totalSec > 0 ? Math.min(100, (state.activeSec / state.totalSec) * 100) : 0
  const phaseText = state
    ? state.phase === 'focus'
      ? '专注'
      : state.phase === 'short'
        ? '短休'
        : '长休'
    : ''

  if (!expanded) {
    return (
      <div
        className="island"
        title={`${phaseText} · 点击开始/暂停`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={onCollapsedClick}
      >
        <span className="island__dot" />
        <span className="island__time">{formatTime(remaining)}</span>
      </div>
    )
  }

  return (
    <div
      className="island island--expanded"
      title={phaseText}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // 展开态的空白处也是"开始/暂停"：鼠标移上来 120ms 岛就展开了，
      // 用户这时点原来胶囊的位置（时间旁边），不该什么都没发生。
      onClick={toggle}
    >
      <div className="island__row">
        <button
          className="island__clock"
          onClick={(e) => {
            e.stopPropagation()
            openMain()
          }}
          title="打开主界面"
        >
          {formatTime(remaining)}
        </button>
        <span className="island__task">添加任务…</span>
        <span className="island__actions">
          <button
            className="island__btn"
            onClick={(e) => {
              e.stopPropagation()
              toggle()
            }}
            title={running ? '暂停' : '继续'}
            aria-label={running ? '暂停' : '继续'}
          >
            {running ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            className="island__btn"
            onClick={(e) => {
              e.stopPropagation()
              skip()
            }}
            title="跳过本段"
            aria-label="跳过本段"
          >
            <SkipIcon />
          </button>
          <button
            className="island__btn"
            onClick={(e) => {
              e.stopPropagation()
              openMain()
            }}
            title="打开主界面"
            aria-label="打开主界面"
          >
            <OpenIcon />
          </button>
        </span>
      </div>
      <span className="island__bar">
        <i style={{ width: `${percent}%` }} />
      </span>
    </div>
  )
}
