// 主题选择条（v0.3-b）：一排带颜色点的小胶囊。
//
// 允许不选（"未分类"），不强制——强制会让人为了开始计时先建个主题，这是劝退。
// 计时进行中切主题只影响下一段。

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
  return (
    <div className={compact ? 'topics topics--compact' : 'topics'}>
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
    </div>
  )
}
