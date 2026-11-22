// 计时模板选择条（v0.3-a）。
//
// 一排小胶囊，点一下就换当前模板。计时进行中切模板只影响下一段，
// 所以跑着的时候旁边会有一句"下一段生效"，别让人以为立刻变了。

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
  return (
    <div className="presets">
      {sorted.map((p) => (
        <button
          key={p.id}
          className={p.id === activeId ? 'presets__chip presets__chip--on' : 'presets__chip'}
          onClick={() => onPick(p.id)}
          title={`专注 ${p.focusMin} · 短休 ${p.shortMin} · 长休 ${p.longMin} 分钟`}
        >
          {p.name}
        </button>
      ))}
      {running ? <span className="presets__hint">下一段生效</span> : null}
    </div>
  )
}
