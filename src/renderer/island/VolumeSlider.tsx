// 灵动岛里的**系统音量滑条**（v0.3.6）。
//
// 为什么单独拆一个组件：绑事件监听器的 useEffect 必须在组件**挂载后**才跑。
// 写在 Island 里会受"展开态才渲染音乐行"这个分支影响，时机不可靠
// （实测过：监听器明明该绑上，事件也到了元素，但处理函数没执行）。
// 独立组件自己的 effect 只在它挂载时跑一次，时机干净。
//
// 为什么用**原生监听**而不是 React 的 onMouseDown/onMouseMove：
// 实测在这块浮层上，原生 addEventListener('mousedown'/'mousemove'/'mouseup')
// 能收到事件，但 React 的 onMouseDown/onMouseMove/onMouseUp **不触发**
// （onWheel 是好的）。合成事件也一样。绕开这层异常，直接绑原生。
//
// 规格：
//   - 轨道 4px、拇指 12px（尺寸见 styles/themes/island-glass.css）
//   - 拖动时节流 50ms，**松手必须落最终值**（否则音量停在途中的数上）
//   - 滚轮 ±5%
//   - 3 秒不动自动收起

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
  const rootRef = useRef<HTMLSpanElement | null>(null)
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

  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const push = (value: number, force: boolean): void => {
      const now = Date.now()
      if (!force && now - lastSent.current < THROTTLE_MS) return
      lastSent.current = now
      onChange(value)
    }

    const onDown = (e: MouseEvent): void => {
      // 岛整体是"点一下就切计时"的大开关，滑条必须自己拦住
      e.stopPropagation()
      dragging.current = true
      onInteract?.()
      const v = valueAt(e.clientX)
      setLocal(v)
      push(v, true)
    }
    const onMove = (e: MouseEvent): void => {
      // 用**鼠标按键状态**判断是不是在拖动，不靠自己的 ref：
      // 实测 dragging 这个 ref 在某些路径下会莫名失效（明明按下了，move 却不处理）。
      // e.buttons 的第 1 位 = 左键按住，这是浏览器给的事实。
      if ((e.buttons & 1) === 0) return
      e.stopPropagation()
      onInteract?.()
      const v = valueAt(e.clientX)
      setLocal(v)
      push(v, false)
    }
    const onUp = (e: MouseEvent): void => {
      if (!dragging.current) return
      e.stopPropagation()
      dragging.current = false
      onInteract?.()
      // ⚠ **松手必须落最终值**：节流期间最后那一下可能没发出去，
      //   不落最终值的话音量会停在拖动途中的某个数上。
      const v = valueAt(e.clientX)
      setLocal(null)
      push(v, true)
    }
    const onWheel = (e: WheelEvent): void => {
      e.stopPropagation()
      e.preventDefault()
      onInteract?.()
      const base = latest.current.local ?? latest.current.volume
      const next = Math.max(0, Math.min(100, base + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)))
      setLocal(null)
      onChange(next)
    }

    el.addEventListener('mousedown', onDown)
    el.addEventListener('mousemove', onMove)
    // ⚠ **mouseup 挂在 window 上，不挂元素上**：
    //   拖到轨道外面松手时，元素上根本收不到 mouseup，
    //   音量会停在途中的某个数上（实测踩过）。
    //   同理不用 mouseleave 结束拖动 —— 它会在不该触发的时候触发。
    window.addEventListener('mouseup', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      el.removeEventListener('wheel', onWheel)
    }
  }, [valueAt, onChange, onInteract])

  const percent = local ?? volume

  return (
    <span
      className="island__vol"
      ref={rootRef}
      role="slider"
      aria-label="系统音量"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span className="island__vol-track" ref={trackRef}>
        <i className="island__vol-fill" style={{ width: `${percent}%` }} />
        <i className="island__vol-thumb" style={{ left: `${percent}%` }} />
      </span>
    </span>
  )
}
