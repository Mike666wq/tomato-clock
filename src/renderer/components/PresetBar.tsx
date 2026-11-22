// 计时模板选择条（v0.3-a）。
//
// 一排小胶囊，点一下就换当前模板。计时进行中切模板只影响下一段，
// 所以跑着的时候旁边会有一句"下一段生效"，别让人以为立刻变了。
//
// v0.2.2：整行左对齐，前面加一个"模板"小标签；模板多了（用户能自己建）
// 一行放不下时横向滚动，不换行——换行会让底部越来越高，又回到压叠的老路。

import { useEffect, useRef, useState } from 'react'
import type { Preset } from '../../shared/presets'

type Props = {
  presets: Preset[]
  activeId: string
  /** 计时是否在跑（跑着的时候切模板要提示"下一段生效"） */
  running: boolean
  onPick: (id: string) => void
}

export function PresetBar({ presets, activeId, running, onPick }: Props): React.JSX.Element {
  const sorted = [...presets].sort((a, b) => a.order - b.order)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)

  // 装不下时右边加一段渐隐，暗示"还能往右滑"
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = (): void => setOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="presets">
      <span className="presets__label">模板</span>
      <div
        className={overflow ? 'presets__scroll presets__scroll--more' : 'presets__scroll'}
        ref={scrollRef}
      >
        <div className="presets__inner">
          {sorted.map((p) => (
            <button
              key={p.id}
              className={p.id === activeId ? 'presets__chip presets__chip--on' : 'presets__chip'}
              onClick={() => onPick(p.id)}
            >
              {p.name}
              <em>
                {p.focusMin}/{p.shortMin}
              </em>
            </button>
          ))}
          {running ? <span className="presets__hint">下一段生效</span> : null}
        </div>
      </div>
    </div>
  )
}
