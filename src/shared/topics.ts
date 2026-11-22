// 主题系统（v0.3-b）：番茄钟挂到一个长期存在的归类空间上。
//
// 主题不是待办清单：没有完成状态、没有优先级、没有截止时间。
// 它就是个分类，作用是回答"这段时间都花哪了"。

/** 一个主题 */
export type Topic = {
  id: string
  name: string
  /** 从固定调色板取，不自由取色 */
  color: string
  /** 归档后不再出现在选择器里，但历史数据保留 */
  archived: boolean
  createdAt: string
  order: number
}

/**
 * 固定调色板。
 * 不自由取色是为了让统计图一眼能分清，而且深浅统一、不会在深色底上看不清。
 */
export const TOPIC_COLORS: string[] = [
  '#ff6b57', // 番茄红
  '#5ac49b', // 休息绿
  '#f5b942', // 琥珀
  '#7aa2f7', // 蓝
  '#bb9af7', // 紫
  '#f7768e', // 粉
  '#7dcfff', // 青
  '#9ece6a' // 黄绿
]

export const TOPIC_NAME_MAX = 12

/** 未分类（不选主题）时用的名字 */
export const UNTITLED = '未分类'

export function findTopic(topics: Topic[], id: string | undefined): Topic | undefined {
  if (!id) return undefined
  return topics.find((t) => t.id === id)
}

/** 选择器里显示的主题：未归档的，按 order 排 */
export function activeTopics(topics: Topic[]): Topic[] {
  return [...topics].filter((t) => !t.archived).sort((a, b) => a.order - b.order)
}

export type TopicDraft = { name: string; color: string }

/** 校验主题草稿：超范围/重名直接拒绝并说明 */
export function validateTopic(
  draft: TopicDraft,
  topics: Topic[],
  exceptId?: string
): { ok: true } | { ok: false; error: string } {
  const name = draft.name.trim()
  if (!name) return { ok: false, error: '主题名不能为空' }
  if (name.length > TOPIC_NAME_MAX) {
    return { ok: false, error: `主题名不能超过 ${TOPIC_NAME_MAX} 个字` }
  }
  if (topics.some((t) => t.id !== exceptId && t.name === name)) {
    return { ok: false, error: `已经有叫「${name}」的主题了` }
  }
  if (!TOPIC_COLORS.includes(draft.color)) {
    return { ok: false, error: '颜色要从调色板里选' }
  }
  return { ok: true }
}

export function makeTopic(draft: TopicDraft, id: string, order: number): Topic {
  return {
    id,
    name: draft.name.trim(),
    color: draft.color,
    archived: false,
    createdAt: new Date().toISOString(),
    order
  }
}
