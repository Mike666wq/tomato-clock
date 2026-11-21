// 圆环进度。用 stroke-dashoffset 连续走，不是每秒一跳。

type RingProps = {
  /** 阶段总秒数 */
  total: number
  /** 剩余秒数 */
  remaining: number
  /** 开始计时那一刻做一次轻微"呼吸" */
  breathe?: boolean
  children?: React.ReactNode
}

const SIZE = 320
const STROKE = 8
const RADIUS = (SIZE - STROKE) / 2 - 4
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function Ring({ total, remaining, breathe, children }: RingProps): React.JSX.Element {
  const progress = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0
  const dashOffset = CIRCUMFERENCE * (1 - progress)
  // 进度 0% 时不要留一个孤零零的圆头
  const visible = progress > 0.0005

  return (
    <div className={breathe ? 'ring ring--breathe' : 'ring'}>
      <svg className="ring__svg" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className="ring__track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} />
        <circle
          className="ring__progress"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          strokeOpacity={visible ? 1 : 0}
        />
      </svg>
      <div className="ring__center">{children}</div>
    </div>
  )
}
