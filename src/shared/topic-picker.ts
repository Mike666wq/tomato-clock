// 主题选择器（v0.3.10）：岛上和主窗口**同一套行为**。
//
// 之前两边各写各的，结果：
//   岛上   ——「＋ 主题」直接跳去新建，有主题也选不中（用户报的问题）
//   主窗口 —— 一排胶囊，选/取消都行
// 同一件事两套行为，用户当然觉得"坏了"。
//
// 现在把"选 / 取消 / 新建"这三条规则收在一处，两边都调它。
// 规则只有三条：
//   1 点某个主题 → 选中它
//   2 再点已选中的那个 → 取消（回到「＋ 主题」）
//   3 点「＋ 主题」→ 有主题先出列表（末尾才是新建），一个主题都没有就直接新建

import { activeTopics, type Topic } from './topics'

/** 选择器里能选的主题：没归档的，按 order 排 */
export function pickableTopics(topics: Topic[]): Topic[] {
  return activeTopics(topics)
}

/**
 * 点一个主题项之后 activeTopicId 变成什么。
 *
 * 再点已选中的那个 = 取消选择（不然没有别的办法取消）。
 */
export function nextActiveTopicId(activeId: string | null, id: string): string | null {
  return activeId === id ? null : id
}

/** 点「＋ 主题」时该干什么 */
export type AddTopicAction = 'open-list' | 'open-create'

/**
 * 一个主题都没有的时候没有列表可显示 —— 直接进新建，
 * 不许弹一个空框（用户点了没反应，还以为坏了）。
 */
export function addTopicAction(topics: Topic[]): AddTopicAction {
  return pickableTopics(topics).length === 0 ? 'open-create' : 'open-list'
}

/** 列表里的一行 */
export type TopicMenuItem =
  | {
      kind: 'topic'
      id: string
      name: string
      color: string
      /** 用户选中的那个（打勾） */
      selected: boolean
      /** 正在跑的这段挂的是这个主题（且跟选中的不一样 → 标「本段」） */
      running: boolean
    }
  | { kind: 'create' }

/**
 * 生成列表内容：全部可选主题 + 末尾一行新建入口。
 *
 * 末尾的「＋ 新建主题」永远在 —— 列表里没有它，用户就没法建新主题了。
 */
export function topicMenuItems(
  topics: Topic[],
  selectedId: string | null,
  runningId: string | null
): TopicMenuItem[] {
  const items: TopicMenuItem[] = pickableTopics(topics).map((t) => ({
    kind: 'topic',
    id: t.id,
    name: t.name,
    color: t.color,
    selected: t.id === selectedId,
    running: t.id === runningId
  }))
  items.push({ kind: 'create' })
  return items
}

/**
 * 「本段没挂主题」这条提示要不要显示。
 *
 * 情况：用户已经选了主题，但正在跑的这段是没挂主题的（切换只影响下一段）。
 * 不说清楚，用户会以为这一段也记到新主题上了。
 */
export function showUnattachedNote(selectedId: string | null, runningId: string | null): boolean {
  return runningId === null && selectedId !== null
}
