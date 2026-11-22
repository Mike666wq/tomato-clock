// 主题选择条（v0.3-b）：一排带颜色点的小胶囊。
//
// 允许不选（"未分类"），不强制——强制会让人为了开始计时先建个主题，这是劝退。
// 计时进行中切主题只影响下一段。
//
// v0.2.2：整行左对齐，前面加一个"主题"小标签。
// 之前整行居中，只有一个"未分类"时孤零零飘在中间，看着像忘了点什么。
//
// v0.2.3：高亮跟"用户选中的"（activeId），不再跟"这一段正在用的"走。
// 切主题只影响下一段，之前拿 state.topicId 做高亮，用户点了「未分类」界面纹丝不动，
// 看起来就是"点了没反应"。正在跑的那段用的哪个，用一个小「本段」标记单独标出来。

import { useEffect, useRef, useState } from 'react'
import type { Topic } from '../../shared/topics'

type Props = {
  topics: Topic[]
  /** 用户选中的主题（settings.activeTopicId）：谁亮着就是谁 */
  activeId: string | null
  /** 当前这一段实际挂的主题（state.topicId）：跟 activeId 不一样时标「本段」 */
  currentId?: string | null
  onPick: (id: string | null) => void
  /** 紧凑模式：灵动岛里用 */
  compact?: boolean
}

export function TopicBar({ topics, activeId, currentId, onPick, compact }: Props): React.JSX.Element {
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

  // 只有两者不一致时才需要标记，否则每条都挂个"本段"反而吵
  const showCurrent = currentId !== undefined && currentId !== activeId

  const chips = (
    <>
      <button
        className={activeId === null ? 'topics__chip topics__chip--on' : 'topics__chip'}
        onClick={() => onPick(null)}
      >
        <span className="topics__dot" style={{ background: 'var(--ink-2)' }} />
        未分类
        {showCurrent && currentId === null ? <em className="topics__tag">本段</em> : null}
      </button>
      {live.map((t) => (
        <button
          key={t.id}
          className={t.id === activeId ? 'topics__chip topics__chip--on' : 'topics__chip'}
          onClick={() => onPick(t.id)}
        >
          <span className="topics__dot" style={{ background: t.color }} />
          {t.name}
          {showCurrent && currentId === t.id ? <em className="topics__tag">本段</em> : null}
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
