// 主题选择条（v0.3-b）：一排带颜色点的小胶囊。
//
// 允许不选（"未分类"），不强制——强制会让人为了开始计时先建个主题，这是劝退。
// 计时进行中切主题只影响下一段。
//
// v0.2.2：整行左对齐，前面加一个"主题"小标签。
// 之前整行居中，只有一个"未分类"时孤零零飘在中间，看着像忘了点什么。

import { useEffect, useRef, useState } from 'react'
import type { Topic } from '../../shared/topics'

type Props = {
  topics: Topic[]
  activeId: string | null
  onPick: (id: string | null) => void
  /** 紧凑模式：灵动岛里用 */
  compact?: boolean
}

export function TopicBar({ topics, activeId, onPick, compact }: Props): React.JSX.Element {
  const live = [...topics].filter((t) => !t.archived).sort((a, b) => a.order - b.order)
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
  const chips = (
    <>
      <button
        className={activeId === null ? 'topics__chip topics__chip--on' : 'topics__chip'}
        onClick={() => onPick(null)}
      >
        <span className="topics__dot" style={{ background: 'var(--ink-2)' }} />
        未分类
      </button>
      {live.map((t) => (
        <button
          key={t.id}
          className={t.id === activeId ? 'topics__chip topics__chip--on' : 'topics__chip'}
          onClick={() => onPick(t.id)}
        >
          <span className="topics__dot" style={{ background: t.color }} />
          {t.name}
        </button>
      ))}
    </>
  )
  if (compact) {
    return <div className="topics topics--compact">{chips}</div>
  }
  return (
    <div className="topics">
      <span className="topics__label">主题</span>
      <div
        className={overflow ? 'topics__scroll topics__scroll--more' : 'topics__scroll'}
        ref={scrollRef}
      >
        <div className="topics__inner">{chips}</div>
      </div>
    </div>
  )
}
