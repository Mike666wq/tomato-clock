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

/**
 * 播放/暂停按钮的图标（**一个** svg，三种形态）。
 *
 * ⚠ **为什么三个图标要合并成一个组件**（2026-11-24 实测踩到）：
 *   以前是三个独立组件（PlayIcon / PauseIcon / PlayPauseIcon），
 *   状态一变就换成**另一个** `<svg>` 节点。
 *   而这个按钮正好在**鼠标底下**被替换 ——
 *   浏览器会把"光标下的元素被删掉"报成 mouseout，
 *   岛于是以为鼠标移走了 → **400ms 后自己收起**。
 *   实测：点一下暂停，岛当场塌掉（用户看着像"点了没反应"）。
 *
 *   现在：`<svg>` 永远是同一个节点，只换里面的 path/rect，
 *   节点不被替换 → 不会触发 mouseout → 岛不塌。
 *
 * 三种形态：
 *   'pause' = 两个竖条（正在放，点了会停）
 *   'play'  = 一个三角（暂停中，点了会放）
 *   'both'  = 一个三角 + 一个竖条（**方向不知道**，点了发切换命令）
 */
export function PlayPauseGlyph({
  className,
  size = 16,
  kind = 'both'
}: IconProps & { kind?: 'pause' | 'play' | 'both' }): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      {kind === 'play' ? (
        <path d="M4.6 3.2 10.6 7 4.6 10.8Z" fill="currentColor" stroke="none" />
      ) : kind === 'pause' ? (
        <>
          <rect x="4.1" y="3" width="2" height="8" rx="0.9" fill="currentColor" stroke="none" />
          <rect x="7.9" y="3" width="2" height="8" rx="0.9" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <path d="M4.2 3.2 9.4 7 4.2 10.8Z" fill="currentColor" stroke="none" />
          <rect x="9.4" y="3.2" width="1.7" height="7.6" rx="0.8" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}

/**
 * 上一首（⏮）：**竖条在左** + 两个朝左的三角。
 *
 * ⚠ 2026-11-24 重画过：原来把竖条画在了右边，渲染出来是"◀◀|"，
 *   那是**下一首**的镜像 —— 两个按钮的方向全是反的，用户一眼就看出来了。
 *   标准形态：上一首 = |◀◀，下一首 = ▶▶|。
 */
export function PrevIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect x="2" y="3" width="1.6" height="8" rx="0.7" fill="currentColor" stroke="none" />
      <path d="M9.6 3.1 5.4 7l4.2 3.9Z" fill="currentColor" stroke="none" />
      <path d="M13 3.1 8.8 7l4.2 3.9Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * 下一首（⏭）：两个朝右的三角 + **竖条在右**。
 *
 * （上一首的镜像，竖条在右。见 PrevIcon 的注释。）
 */
export function NextIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M1 3.1 4.8 7 1 10.9Z" fill="currentColor" stroke="none" />
      <path d="M5.2 3.1 9 7l-3.8 3.9Z" fill="currentColor" stroke="none" />
      <rect x="10.4" y="3" width="1.6" height="8" rx="0.7" fill="currentColor" stroke="none" />
    </svg>
  )
}


/**
 * 对勾：主题列表里"当前选中的那个"。
 *
 * ⚠ 注意别把它换成独立组件里的 `<svg>` 换节点那套写法（见 PlayPauseGlyph）：
 *   这个图标在列表里，列表项被点掉时整行会重渲染 —— 图标节点被换掉，
 *   如果光标正压在它上面，浏览器会报 mouseout，岛就自己收了。
 */
export function CheckIcon({ className, size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <path d="M2.8 7.3 5.7 10.1 11.2 4.2" />
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
