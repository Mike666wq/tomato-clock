// 主题管理（v0.3-b，设置页用）。
//
// 主题可以增、改名、归档；**不删除**——归档后不再出现在选择器里，历史数据保留。
// 首次启动不预置任何主题，用户自己建第一个。

import { useState } from 'react'
import {
  TOPIC_COLORS,
  TOPIC_NAME_MAX,
  makeTopic,
  validateTopic,
  type Topic,
  type TopicDraft
} from '../../shared/topics'

type Props = {
  topics: Topic[]
  activeId: string | null
  onTopics: (topics: Topic[]) => void
  onActivate: (id: string | null) => void
  onNotice: (text: string) => void
}

const EMPTY: TopicDraft = { name: '', color: TOPIC_COLORS[0] }

function newId(): string {
  return `topic-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

export function TopicManager({ topics, activeId, onTopics, onActivate, onNotice }: Props): React.JSX.Element {
  const [editing, setEditing] = useState<{ mode: 'new' | 'rename'; id?: string } | null>(null)
  const [draft, setDraft] = useState<TopicDraft>(EMPTY)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const live = [...topics].filter((t) => !t.archived).sort((a, b) => a.order - b.order)
  const archived = [...topics].filter((t) => t.archived).sort((a, b) => a.order - b.order)

  const open = (mode: 'new' | 'rename', topic?: Topic): void => {
    setError('')
    setEditing({ mode, id: topic?.id })
    setDraft(topic ? { name: topic.name, color: topic.color } : EMPTY)
  }

  const close = (): void => {
    setEditing(null)
    setError('')
  }

  const save = (): void => {
    if (!editing) return
    const check = validateTopic(draft, topics, editing.mode === 'rename' ? editing.id : undefined)
    if (!check.ok) {
      setError(check.error)
      onNotice(check.error)
      return
    }
    if (editing.mode === 'rename' && editing.id) {
      onTopics(topics.map((t) => (t.id === editing.id ? { ...t, name: draft.name.trim(), color: draft.color } : t)))
      onNotice('主题已更新')
    } else {
      const created = makeTopic(draft, newId(), topics.length)
      onTopics([...topics, created])
      onActivate(created.id)
      onNotice(`已创建主题「${created.name}」`)
    }
    close()
  }

  const archive = (t: Topic): void => {
    onTopics(topics.map((x) => (x.id === t.id ? { ...x, archived: true } : x)))
    if (activeId === t.id) onActivate(null)
    onNotice(`已归档「${t.name}」，历史记录保留`)
  }

  const restore = (t: Topic): void => {
    onTopics(topics.map((x) => (x.id === t.id ? { ...x, archived: false } : x)))
    onNotice(`已恢复「${t.name}」`)
  }

  return (
    <section className="card">
      <h3 className="card__title">主题</h3>
      <p className="card__note">
        主题是长期归类空间，不是待办清单。每段番茄可以挂一个主题，空着就是未分类，不强制选。
      </p>

      <div className="topic-list">
        <button
          className={activeId === null ? 'topic-row topic-row--on' : 'topic-row'}
          onClick={() => onActivate(null)}
        >
          <span className="topic-row__dot" style={{ background: 'var(--ink-2)' }} />
          <span className="topic-row__name">未分类</span>
          {activeId === null ? <em>当前</em> : null}
        </button>

        {live.map((t) => (
          <div key={t.id} className={t.id === activeId ? 'topic-row topic-row--on' : 'topic-row'}>
            <button className="topic-row__name" onClick={() => onActivate(t.id)}>
              <span className="topic-row__dot" style={{ background: t.color }} />
              {t.name}
              {t.id === activeId ? <em>当前</em> : null}
            </button>
            <span className="topic-row__ops">
              <button onClick={() => open('rename', t)}>改名</button>
              <button onClick={() => archive(t)}>归档</button>
            </span>
          </div>
        ))}
      </div>

      <button className="btn btn--soft field__wide" onClick={() => open('new')}>
        + 新建主题
      </button>

      {editing ? (
        <div className="preset-editor">
          <div className="field">
            <label>名称</label>
            <input
              className="preset-editor__name"
              type="text"
              maxLength={TOPIC_NAME_MAX}
              value={draft.name}
              placeholder="例如：写代码"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label>颜色</label>
            <div className="topic-palette">
              {TOPIC_COLORS.map((c) => (
                <button
                  key={c}
                  className={c === draft.color ? 'topic-swatch topic-swatch--on' : 'topic-swatch'}
                  style={{ background: c }}
                  onClick={() => setDraft({ ...draft, color: c })}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          {error ? <p className="preset-editor__error">{error}</p> : null}
          <div className="preset-editor__ops">
            <button className="btn btn--primary" onClick={save}>
              保存
            </button>
            <button className="btn btn--ghost" onClick={close}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {archived.length > 0 ? (
        <div className="topic-archived">
          <button className="card__note" onClick={() => setShowArchived(!showArchived)}>
            已归档 {archived.length} 个（历史记录保留）{showArchived ? ' ▾' : ' ▸'}
          </button>
          {showArchived
            ? archived.map((t) => (
                <div key={t.id} className="topic-row">
                  <span className="topic-row__name">
                    <span className="topic-row__dot" style={{ background: t.color }} />
                    {t.name}
                  </span>
                  <span className="topic-row__ops">
                    <button onClick={() => restore(t)}>恢复</button>
                  </span>
                </div>
              ))
            : null}
        </div>
      ) : null}
    </section>
  )
}
