// 圆环进度。用 stroke-dashoffset 连续走，不是每秒一跳。
//
// 尺寸由外面算好传进来（主界面要按可用高度缩放，写死 320 会在小窗口里顶出去）。
// 描边宽度固定 8px，不跟着尺寸缩放，否则环大了线也跟着粗。

type RingProps = {
  /** 阶段总秒数 */
  total: number
  /** 剩余秒数 */
  remaining: number
  /** 开始计时那一刻做一次轻微"呼吸" */
  breathe?: boolean
  /** 直径（DIP）。不传就用 token 里的默认值 */
  size?: number
  children?: React.ReactNode
}

const STROKE = 8

export function Ring({ total, remaining, breathe, size, children }: RingProps): React.JSX.Element {
  const px = size ?? 320
  const radius = (px - STROKE) / 2 - 4
  const circumference = 2 * Math.PI * radius

  const progress = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0
  const dashOffset = circumference * (1 - progress)
  // 进度 0% 时不要留一个孤零零的圆头
  const visible = progress > 0.0005

  return (
    <div
      className={breathe ? 'ring ring--breathe' : 'ring'}
      style={{ '--ring-size': `${px}px` } as React.CSSProperties}
    >
      <svg className="ring__svg" viewBox={`0 0 ${px} ${px}`} aria-hidden="true">
        <circle className="ring__track" cx={px / 2} cy={px / 2} r={radius} />
        <circle
          className="ring__progress"
          cx={px / 2}
          cy={px / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeOpacity={visible ? 1 : 0}
        />
      </svg>
      <div className="ring__center">{children}</div>
    </div>
  )
}
