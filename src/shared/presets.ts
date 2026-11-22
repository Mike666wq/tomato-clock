// 计时模板（v0.3-a）：可以来回切的几套时长。
//
// 为什么要模板而不是"改参数"：改参数会覆盖掉唯一那套设置，明天想换回去得重新调。
// 模板是能并存的几套，切一下就换。

/** 一套模板 */
export type Preset = {
  id: string
  name: string
  focusMin: number
  shortMin: number
  longMin: number
  roundsBeforeLong: number
  /** 内置模板不可删，但可以复制成自定义的 */
  builtin: boolean
  order: number
}

/** 各字段的范围限制。超范围直接拒绝，不静默截断 */
export const PRESET_LIMITS = {
  nameMax: 12,
  focusMin: { min: 1, max: 180 },
  shortMin: { min: 1, max: 60 },
  longMin: { min: 1, max: 90 },
  roundsBeforeLong: { min: 1, max: 12 }
} as const

/** 内置模板：四个够用，给多了人就开始比较模板而不是干活 */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin-classic',
    name: '经典',
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    roundsBeforeLong: 4,
    builtin: true,
    order: 0
  },
  {
    id: 'builtin-deep',
    name: '深度',
    focusMin: 50,
    shortMin: 10,
    longMin: 25,
    roundsBeforeLong: 3,
    builtin: true,
    order: 1
  },
  {
    id: 'builtin-sprint',
    name: '冲刺',
    focusMin: 15,
    shortMin: 3,
    longMin: 10,
    roundsBeforeLong: 4,
    builtin: true,
    order: 2
  },
  {
    id: 'builtin-exam',
    name: '考试',
    focusMin: 45,
    shortMin: 10,
    longMin: 20,
    roundsBeforeLong: 2,
    builtin: true,
    order: 3
  }
]

export const DEFAULT_PRESET_ID = 'builtin-classic'

/** 计时器真正需要的配置（从当前模板 + 当前主题派生） */
export type TimerConfig = {
  focusMin: number
  shortMin: number
  longMin: number
  roundsBeforeLong: number
  autoStartNext: boolean
  /** 用户当前选中的主题（切主题只影响下一段） */
  topicId: string | null
}

/** 模板草稿（还没落库） */
export type PresetDraft = {
  name: string
  focusMin: number
  shortMin: number
  longMin: number
  roundsBeforeLong: number
}

export function findPreset(presets: Preset[], id: string): Preset | undefined {
  return presets.find((p) => p.id === id)
}

/**
 * 校验一份模板草稿。
 *
 * 返回值是给人看的错误说明：超范围直接拒绝并说明，不静默截断成别的值。
 * exceptId：编辑已有模板时排除它自己（不然跟自己重名了）。
 */
export function validatePreset(
  draft: PresetDraft,
  presets: Preset[],
  exceptId?: string
): { ok: true } | { ok: false; error: string } {
  const name = draft.name.trim()
  if (!name) return { ok: false, error: '名称不能为空' }
  if (name.length > PRESET_LIMITS.nameMax) {
    return { ok: false, error: `名称不能超过 ${PRESET_LIMITS.nameMax} 个字` }
  }
  if (presets.some((p) => p.id !== exceptId && p.name === name)) {
    return { ok: false, error: `已经有叫「${name}」的模板了` }
  }

  const checks: Array<[keyof PresetDraft, number, number, string]> = [
    ['focusMin', PRESET_LIMITS.focusMin.min, PRESET_LIMITS.focusMin.max, '专注'],
    ['shortMin', PRESET_LIMITS.shortMin.min, PRESET_LIMITS.shortMin.max, '短休'],
    ['longMin', PRESET_LIMITS.longMin.min, PRESET_LIMITS.longMin.max, '长休'],
    ['roundsBeforeLong', PRESET_LIMITS.roundsBeforeLong.min, PRESET_LIMITS.roundsBeforeLong.max, '长休轮数']
  ]

  for (const [key, min, max, label] of checks) {
    const v = Number(draft[key])
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      return { ok: false, error: `${label}要填整数` }
    }
    if (v < min || v > max) {
      return { ok: false, error: `${label}要在 ${min}–${max} 之间，你填的是 ${v}` }
    }
  }

  return { ok: true }
}

/** 按草稿生成一份模板（新建/复制时用） */
export function makePreset(draft: PresetDraft, id: string, builtin: boolean, order: number): Preset {
  return {
    id,
    name: draft.name.trim(),
    focusMin: draft.focusMin,
    shortMin: draft.shortMin,
    longMin: draft.longMin,
    roundsBeforeLong: draft.roundsBeforeLong,
    builtin,
    order
  }
}
