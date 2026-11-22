// 胶囊里那几个小图标。全部是内联 SVG，尺寸统一 14px，颜色走 currentColor。

type IconProps = { className?: string }

const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 14 14',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export function PauseIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg {...base} className={className} aria-hidden>
      <rect x="4.1" y="3" width="2" height="8" rx="0.9" fill="currentColor" stroke="none" />
      <rect x="7.9" y="3" width="2" height="8" rx="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function PlayIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M4.6 3.2 10.6 7 4.6 10.8Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SkipIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M3.4 3.2 9.2 7 3.4 10.8Z" fill="currentColor" stroke="none" />
      <rect x="10.1" y="3.2" width="1.7" height="7.6" rx="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function OpenIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M5.6 3.2h5.2v5.2" />
      <path d="M10.8 3.2 4.7 9.3" />
      <path d="M8.9 10.8H3.2V5.1" />
    </svg>
  )
}
