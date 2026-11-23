// 设置的结构校验。
//
// 为什么要有：以前 `settings:save` 是"读整份 → 并一个字段 → 写回整份"，
// 传进来什么就写什么。我有一次把 `presets` 传成了字符串，
// 结果**磁盘上的设置被写坏**，程序随后在读它的时候抛异常，界面零提示。
//
// 规矩：**写盘之前先验一遍**，不合法就整份拒绝 —— 磁盘上一个字节都不许变。

import type { Settings } from './types'
import { UI_THEMES } from './types'

const THEME_IDS = UI_THEMES.map((t) => t.id)
const MODES = ['system', 'light', 'dark']

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/**
 * 校验一份设置。
 *
 * 返回 null 表示没问题；否则返回一句**给用户看**的原因。
 */
export function validateSettings(s: unknown): string | null {
  if (!isObj(s)) return '设置不是一个对象'

  if (!isStr(s.activePresetId)) return '当前模板的 id 不对'
  if (!Array.isArray(s.presets)) return '模板列表不是一个数组'
  if (s.presets.length === 0) return '模板列表空了'
  for (const p of s.presets) {
    if (!isObj(p)) return '有一条模板不是一个对象'
    if (!isStr(p.id) || !isStr(p.name)) return '有一条模板缺少名字'
    if (!isNum(p.focusMin) || p.focusMin < 1) return '有一条模板的专注时长不对'
    if (!isNum(p.shortMin) || p.shortMin < 1) return '有一条模板的短休时长不对'
    if (!isNum(p.longMin) || p.longMin < 1) return '有一条模板的长休时长不对'
    if (!isNum(p.roundsBeforeLong) || p.roundsBeforeLong < 1) return '有一条模板的长休轮数不对'
    if (!isBool(p.builtin)) return '有一条模板的"内置"标记不对'
    if (!isNum(p.order)) return '有一条模板的排序值不对'
  }
  // 注意：**不**在这里检查 activePresetId 是否在列表里。
  // 删除正在用的模板时，界面会先发"模板列表变了"、再发"换个模板"，
  // 中间那一刻 activePresetId 确实指向已经不存在的模板 ——
  // 那是正常状态，不是坏数据。存储层会把它修正掉。

  if (!Array.isArray(s.topics)) return '主题列表不是一个数组'
  for (const t of s.topics) {
    if (!isObj(t)) return '有一条主题不是一个对象'
    if (!isStr(t.id) || !isStr(t.name) || !isStr(t.color)) return '有一条主题缺字段'
    if (!isBool(t.archived)) return '有一条主题的"归档"标记不对'
    if (!isStr(t.createdAt)) return '有一条主题缺创建时间'
    if (!isNum(t.order)) return '有一条主题的排序值不对'
  }
  if (s.activeTopicId !== null && !isStr(s.activeTopicId)) return '当前主题的 id 不对'

  for (const key of ['autoStartNext', 'soundOn', 'launchAtLogin', 'islandVisible', 'showMusicControl']) {
    if (!isBool(s[key])) return `设置项 ${key} 不是开关`
  }

  if (!isNum(s.volume) || s.volume < 0 || s.volume > 1) return '音量不是 0 到 1 之间的数'

  if (!isStr(s.uiTheme) || !THEME_IDS.includes(s.uiTheme as Settings['uiTheme'])) {
    return `界面主题不认识（${String(s.uiTheme)}）`
  }
  if (!isStr(s.uiMode) || !MODES.includes(s.uiMode)) {
    return `深浅模式不认识（${String(s.uiMode)}）`
  }

  if (!isObj(s.window)) return '窗口位置不是一个对象'
  if (!isNum(s.window.w) || s.window.w < 1) return '窗口宽度不对'
  if (!isNum(s.window.h) || s.window.h < 1) return '窗口高度不对'
  for (const k of ['x', 'y']) {
    const v = s.window[k]
    if (v !== undefined && !isNum(v)) return `窗口 ${k} 坐标不对`
  }

  return null
}
