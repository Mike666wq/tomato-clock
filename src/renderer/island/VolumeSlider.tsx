// 灵动岛里的**系统音量滑条**（v0.3.6）。
//
// 交互（按肥鱼的规格）：
//   - 轨道 4px、拇指 12px（尺寸见 styles/themes/island-glass.css）
//   - 拖动时**指针捕获**（setPointerCapture）：按下之后即使指针移出轨道，
//     pointermove/pointerup 仍然送到这个元素
//   - 拖动时节流 50ms，**松手必须落最终值**（否则音量停在途中的数上）
//   - 滚轮 ±5%
//   - 拖完 3 秒不动自动收起（计时在 Island 那边）
//
// 事件用 **pointer 事件 + 指针捕获**：
//   指针捕获是浏览器给的机制 —— 按下之后，这个元素就接管了后续的
//   pointermove/pointerup，哪怕指针已经移出去。这比"监听 window 的 mouseup"
//   稳，也比"监听 mouseleave"可靠（后者会在不该触发的时候触发）。
//
// 为什么单独拆一个组件：绑事件监听器的 useEffect 必须在组件**挂载后**才跑。
// 写在 Island 里会受"展开态才渲染音乐行"这个分支影响，时机不可靠。

import { useCallback, useEffect, useRef, useState } from 'react'

/** 拖动时节流间隔 */
const THROTTLE_MS = 50
/** 滚轮一格 ±5% */
const WHEEL_STEP = 5

type Props = {
  /** 当前系统音量 0-100 */
  volume: number
  /** 设音量（主进程会立刻本地更新，所以拖动是跟手的） */
  onChange: (value: number) => void
  /** 用户又动了一下（用来重置"3 秒自动收起"的计时） */
  onInteract?: () => void
}

export default function VolumeSlider({ volume, onChange, onInteract }: Props): React.JSX.Element {
  const [local, setLocal] = useState<number | null>(null)
  const trackRef = useRef<HTMLSpanElement | null>(null)
  const lastSent = useRef(0)
  const dragging = useRef(false)
  /** 最新值放 ref：拖动时它每帧都在变，不能进 effect 的依赖 */
  const latest = useRef({ local: null as number | null, volume: 0 })
  latest.current = { local, volume }

  const valueAt = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const r = track.getBoundingClientRect()
    if (r.width <= 0) return 0
    const p = (clientX - r.left) / r.width
    return Math.max(0, Math.min(100, Math.round(p * 100)))
  }, [])

  const push = useCallback(
    (value: number, force: boolean) => {
      const now = Date.now()
      if (!force && now - lastSent.current < THROTTLE_MS) return
      lastSent.current = now
      onChange(value)
    },
    [onChange]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      // 岛整体是"点一下就切计时"的大开关，滑条必须自己拦住
      e.stopPropagation()
      // **指针捕获**：按下之后，这个元素接管后续的 pointermove/pointerup，
      // 哪怕指针已经移出轨道。没有它，拖到一半移出去就断了。
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* 捕获失败也别影响拖动 */
      }
      dragging.current = true
      onInteract?.()
      const v = valueAt(e.clientX)
      setLocal(v)
      push(v, true)
    },
    [valueAt, push, onInteract]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      if (!dragging.current) return
      e.stopPropagation()
      onInteract?.()
      const v = valueAt(e.clientX)
      // 界面本地先动：拇指跟着走，不等系统回读
      setLocal(v)
      push(v, false)
    },
    [valueAt, push, onInteract]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      if (!dragging.current) return
      e.stopPropagation()
      dragging.current = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* 没捕获住就算了 */
      }
      // ⚠ **松手必须落最终值**：节流期间最后那一下可能没发出去，
      //   不落最终值的话音量会停在拖动途中的某个数上。
      const v = valueAt(e.clientX)
      setLocal(null)
      push(v, true)
    },
    [valueAt, push, onInteract]
  )

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLSpanElement>) => {
      e.stopPropagation()
      e.preventDefault()
      onInteract?.()
      const base = latest.current.local ?? latest.current.volume
      const next = Math.max(0, Math.min(100, base + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)))
      setLocal(null)
      onChange(next)
    },
    [onChange, onInteract]
  )

  // 兜底：指针在元素外松手时（万一没捕获住），也要把最终值落下去
  useEffect(() => {
    const onUp = (e: PointerEvent): void => {
      if (!dragging.current) return
      dragging.current = false
      const v = valueAt(e.clientX)
      setLocal(null)
      push(v, true)
    }
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [valueAt, push])

  const percent = local ?? volume

  return (
    <span
      className="island__vol"
      role="slider"
      aria-label="系统音量"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <span className="island__vol-track" ref={trackRef}>
        <i className="island__vol-fill" style={{ width: `${percent}%` }} />
        <i className="island__vol-thumb" style={{ left: `${percent}%` }} />
      </span>
    </span>
  )
}
