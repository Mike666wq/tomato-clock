// 胶囊里那几个小图标。全部是内联 SVG，颜色走 currentColor。
//
// 默认 14px；音乐控制那一行的按钮要 16px（12px 的歌名配 14px 的图标太挤），
// 所以给一个 size —— 图形本身还是同一套 viewBox，只是画多大。

type IconProps = { className?: string; size?: number }

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    // 画大了线就细一点，不然 16px 的图标看着发黑
    strokeWidth: size >= 16 ? 1.4 : 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  } as const
}

export function PauseIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect x="4.1" y="3" width="2" height="8" rx="0.9" fill="currentColor" stroke="none" />
      <rect x="7.9" y="3" width="2" height="8" rx="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function PlayIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M4.6 3.2 10.6 7 4.6 10.8Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SkipIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M3.4 3.2 9.2 7 3.4 10.8Z" fill="currentColor" stroke="none" />
      <rect x="10.1" y="3.2" width="1.7" height="7.6" rx="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function OpenIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M5.6 3.2h5.2v5.2" />
      <path d="M10.8 3.2 4.7 9.3" />
      <path d="M8.9 10.8H3.2V5.1" />
    </svg>
  )
}

/** 上一首：两个三角形朝左 + 一条竖线 */
export function PrevIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M10.2 3.4 4.6 7l5.6 3.6Z" fill="currentColor" stroke="none" />
      <path d="M4 3.4 0.6 7 4 10.6Z" fill="currentColor" stroke="none" transform="translate(3.6 0)" />
      <rect x="10.6" y="3.4" width="1.5" height="7.2" rx="0.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 下一首 */
export function NextIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M3.8 3.4 9.4 7l-5.6 3.6Z" fill="currentColor" stroke="none" />
      <path d="M10 3.4 13.4 7 10 10.6Z" fill="currentColor" stroke="none" transform="translate(-3.6 0)" />
      <rect x="1.9" y="3.4" width="1.5" height="7.2" rx="0.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * 音量喇叭（系统总音量）。
 * muted=true 时画一条斜杠，表示当前是 0。
 */
export function VolumeIcon({
  className,
  size = 14,
  muted = false
}: IconProps & { muted?: boolean }): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M2.6 5.4h1.8L7 3.2v7.6L4.4 8.6H2.6Z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="M9 5.6l3 2.8M12 5.6l-3 2.8" />
      ) : (
        <>
          <path d="M9.1 5.4a3 3 0 0 1 0 3.2" />
          <path d="M10.9 4a5.2 5.2 0 0 1 0 6" />
        </>
      )}
    </svg>
  )
}
