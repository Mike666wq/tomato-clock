// 主题选择条（v0.3-b）：一排带颜色点的小胶囊。
//
// v0.6：**不再有"未分类"这个选项**。
// "未分类"是数据概念（记录里没挂主题），不是能选的东西 —
// 摆出来会让人以为"未分类"是个主题，可它其实是"没选"。
// 现在没选的时候显示「＋ 主题」（去建一个），选了显示主题名。
// 想取消选择：再点一次已选中的那个。
//
// 计时进行中切主题只影响下一段。
//
// v0.2.2：整行左对齐，前面加一个"主题"小标签。
// 之前整行居中，只有一个选项时孤零零飘在中间，看着像忘了点什么。
//
// v0.2.3：高亮跟"用户选中的"（activeId），不再跟"这一段正在用的"走。
// 切主题只影响下一段，之前拿 state.topicId 做高亮，用户点了界面纹丝不动，
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
  /** 「＋ 主题」：去建一个主题。没有这个入口，第一次用的人不知道主题从哪来 */
  onAdd?: () => void
}

export function TopicBar({
  topics,
  activeId,
  currentId,
  onPick,
  compact,
  onAdd
}: Props): React.JSX.Element {
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
      {live.map((t) => (
        <button
          key={t.id}
          className={t.id === activeId ? 'topics__chip topics__chip--on' : 'topics__chip'}
          onClick={() => onPick(t.id === activeId ? null : t.id)}
        >
          <span className="topics__dot" style={{ background: t.color }} />
          {t.name}
          {showCurrent && currentId === t.id ? <em className="topics__tag">本段</em> : null}
        </button>
      ))}
      {/* 这一段没挂主题，但用户选了别的 —— 说清楚，别让人以为这段也会记到那个主题上。
          这里只说明，不给"未分类"这个可点的选项 */}
      {showCurrent && currentId === null ? <span className="topics__note">本段没挂主题</span> : null}
      {onAdd ? (
        <button className="topics__chip topics__chip--add" onClick={onAdd}>
          ＋ 主题
        </button>
      ) : null}
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
