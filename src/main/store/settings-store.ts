// 设置的单例 + 串行写入（v0.6 缺陷 D1 / D2）。
//
// 以前设置是"每次用的时候从磁盘读一遍"：
//
//   ipcMain.on('settings:save', (_e, patch) => {
//     void jsonStore.getSettings().then(async (current) => {
//       const next = { ...current, ...patch }   // ← 基于旧快照合并
//       await jsonStore.saveSettings(next)      // ← 写回整份
//
// 两个请求各自读到**同一份旧快照**，各自合并自己那一个字段，
// 然后各写回**整份**设置 —— 谁后写谁赢，赢的那份里另一方的字段是旧值。
// 改动凭空消失，磁盘上没有任何痕迹。
//
// 现在：
//   - 设置在主进程只存**一份**（内存里的单例），读不读盘都读它；
//   - 所有写入进**一条队列**，一个接一个做；
//   - 合并用的是队列里**当前的内存值**，不是磁盘上的旧快照；
//   - 写盘之前**先校验**，不合法就整份拒绝，磁盘上一个字节都不变。

import { DEFAULT_SETTINGS, type Settings } from '../../shared/types'
import { validateSettings } from '../../shared/settings-schema'
import { jsonStore } from './json-store'
import { log } from '../logger'

/** 内存里的当前设置。null = 还没从磁盘读过 */
let cache: Settings | null = null

/** 写入队列：所有写一个接一个，绝不重叠 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  // 前一个失败也要让下一个继续（否则一次失败之后队列就堵死了）
  const run = queue.then(fn, fn)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export const settingsStore = {
  /** 第一次调用时从磁盘读一次，之后一直用内存里的那份 */
  async init(): Promise<Settings> {
    if (!cache) cache = await jsonStore.getSettings()
    return cache
  },

  /** 同步拿当前设置（内存里的那份）。没初始化过就给默认值。 */
  peek(): Settings {
    return cache ?? DEFAULT_SETTINGS
  },

  /** 等价于 init()，语义上更好读 */
  get(): Promise<Settings> {
    return settingsStore.init()
  },

  /**
   * 合并 patch 并落盘。
   *
   * - 排队：不会和别的写撞在一起
   * - 合并的是**当前内存值**：别的字段不会被覆盖
   * - 落盘前校验：不合法就抛错，磁盘一个字节都不变
   */
  save(patch: Partial<Settings>): Promise<Settings> {
    return enqueue(async () => {
      const current = await settingsStore.init()
      const next: Settings = { ...current, ...patch }
      // 当前模板被删掉了（界面会先发"模板列表变了"、再发"换个模板"，
      // 中间那一刻 activePresetId 指向已经不存在的模板）——
      // 修正掉，别把这次保存整个挡下来。
      if (!next.presets.some((p) => p.id === next.activePresetId)) {
        next.activePresetId = next.presets[0]?.id ?? DEFAULT_SETTINGS.activePresetId
      }
      const problem = validateSettings(next)
      if (problem) {
        // 不落盘：磁盘保持原样
        throw new Error(problem)
      }
      await jsonStore.saveSettings(next)
      cache = next
      log.info(`设置已保存（${Object.keys(patch).join(', ') || '无改动'}）`)
      return next
    })
  }
}
