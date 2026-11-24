// 主题选择器的行为断言（v0.3.10）。
//
// 这三条规则（选 / 取消 / 新建）是用户直接感知的行为，
// 写成单测才锁得住 —— 之前两边各写各的，就是没有这层锁。

import { describe, expect, it } from 'vitest'
import type { Topic } from '../shared/topics'
import {
  addTopicAction,
  nextActiveTopicId,
  pickableTopics,
  showUnattachedNote,
  topicMenuItems
} from '../shared/topic-picker'

function topic(id: string, name: string, order: number, archived = false): Topic {
  return { id, name, color: '#ff6b57', archived, createdAt: '2026-01-01T00:00:00.000Z', order }
}

describe('主题选择器', () => {
  it('T1 选一个主题就是选中它', () => {
    expect(nextActiveTopicId(null, 'a')).toBe('a')
    expect(nextActiveTopicId('b', 'a')).toBe('a')
  })

  it('T2 再点已选中的那个 = 取消', () => {
    expect(nextActiveTopicId('a', 'a')).toBeNull()
  })

  it('T3 有主题时点「＋ 主题」是出列表', () => {
    expect(addTopicAction([topic('a', 'A', 0)])).toBe('open-list')
  })

  it('T4 一个主题都没有时点「＋ 主题」直接进新建（不弹空框）', () => {
    expect(addTopicAction([])).toBe('open-create')
  })

  it('T5 归档的主题不算数：只剩归档项时也直接进新建', () => {
    expect(addTopicAction([topic('a', 'A', 0, true)])).toBe('open-create')
  })

  it('T6 可选的主题按 order 排，归档的排掉', () => {
    const list = pickableTopics([
      topic('b', 'B', 1),
      topic('a', 'A', 0),
      topic('c', 'C', 2, true)
    ])
    expect(list.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('T7 列表内容 = 全部主题 + 末尾一行新建', () => {
    const items = topicMenuItems([topic('a', 'A', 0), topic('b', 'B', 1)], 'a', null)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ kind: 'topic', id: 'a', selected: true })
    expect(items[1]).toMatchObject({ kind: 'topic', id: 'b', selected: false })
    expect(items[2]).toEqual({ kind: 'create' })
  })

  it('T8 正在跑的段挂着的主题要标出来（跟选中的不是一个时）', () => {
    const items = topicMenuItems([topic('a', 'A', 0), topic('b', 'B', 1)], 'a', 'b')
    expect(items[1]).toMatchObject({ kind: 'topic', id: 'b', running: true })
  })

  it('T9 选了主题但这一段没挂 → 提示「本段没挂主题」', () => {
    expect(showUnattachedNote('a', null)).toBe(true)
    expect(showUnattachedNote(null, null)).toBe(false)
    expect(showUnattachedNote('a', 'a')).toBe(false)
  })
})
