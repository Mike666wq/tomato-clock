// 记录卡片：任务名（可空）+ 打断类型。
//
// 交互约定：
//   回车提交、不点鼠标 3 秒内能完成；Esc / 跳过 = 按默认落一条（已完成、无任务、无打断）
//   打开时只聚焦卡片本身，不聚焦输入框——避免抢走用户正在用的输入法

import { useEffect, useRef, useState } from 'react'
import type { InterruptKind, Session } from '../../shared/types'

const INTERRUPTS: Array<{ value: InterruptKind; label: string }> = [
  { value: 'none', label: '没被打断' },
  { value: 'internal', label: '内部打断' },
  { value: 'external', label: '外部打断' }
]

type Props = {
  session: Session
  onSubmit: (task: string, interrupt: InterruptKind) => void
  onSkip: () => void
}

export function RecordCard({ session, onSubmit, onSkip }: Props): React.JSX.Element {
  const [task, setTask] = useState('')
  const [interrupt, setInterrupt] = useState<InterruptKind>('none')
  const cardRef = useRef<HTMLDivElement>(null)

  // 只聚焦容器，不聚焦输入框
  useEffect(() => {
    cardRef.current?.focus()
  }, [])

  const submit = (): void => onSubmit(task.trim(), interrupt)

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onSkip()
    }
  }

  const minutes = Math.round(session.actualSec / 60)

  return (
    <div className="record-overlay">
      <div
        className="record-card"
        ref={cardRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label="记录这一段"
      >
        <div className="record-card__title">这一段完成了</div>
        <div className="record-card__sub">
          专注 {minutes} 分钟{session.pausedSec ? ` · 暂停了 ${Math.round(session.pausedSec / 60)} 分钟` : ''}
        </div>

        <input
          className="record-card__input"
          placeholder="刚才在做什么？（可留空）"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />

        <div className="record-card__group">
          {INTERRUPTS.map((it) => (
            <button
              key={it.value}
              className={interrupt === it.value ? 'chip chip--on' : 'chip'}
              onClick={() => setInterrupt(it.value)}
            >
              {it.label}
            </button>
          ))}
        </div>

        <div className="record-card__actions">
          <button className="btn btn--primary record-card__ok" onClick={submit}>
            记下来
          </button>
          <button className="btn btn--ghost" onClick={onSkip}>
            跳过
          </button>
        </div>
        <div className="record-card__hint">回车直接保存 · 60 秒不动会自动记一条</div>
      </div>
    </div>
  )
}
