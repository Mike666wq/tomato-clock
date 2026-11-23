// JSON 文件仓储实现：先写 .tmp 再 rename，避免断电/崩溃写坏文件。
//
// v0.6 的三处加固（都写在这里，因为它们是同一个问题的三张脸）：
//
// 1. **所有写排队**（D1）。以前 `addSession` / `updateSession` / `saveSettings`
//    各自"读整个文件 → 改一处 → 写整个文件"，两个写撞在一起就互相覆盖：
//    后写的会把先写的那条记录整个抹掉。现在所有会改文件的操作进同一条队列，
//    一个接一个做，不会重叠。
//
// 2. **临时文件名唯一**（D6）。以前所有写共用 `${target}.tmp`，
//    两个写同时进行时内容会搅在一起，文件变成非法 JSON。
//    现在临时名带进程号和序号，谁也撞不上谁。
//
// 3. **读不出来不静默**（D6）。以前 JSON 解析失败就 `return defaultData()`，
//    不记日志、不提示 —— 下一次任何写盘都会用默认值覆盖掉它，
//    用户的全部历史记录就这么没了。现在：改名备份 + 记 ERROR + 提示用户。

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppData } from '../../shared/types'
import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, makePreset } from '../../shared/presets'
import { log } from '../logger'
import type { Store } from './index'

const SCHEMA_VERSION = 3

function dataDir(): string {
  return app.getPath('userData')
}

function dataFile(): string {
  return path.join(dataDir(), 'data.json')
}

function defaultData(): AppData {
  return { schemaVersion: SCHEMA_VERSION, settings: { ...DEFAULT_SETTINGS }, sessions: [] }
}

/**
 * 仓储层的钩子。主进程注入"数据文件坏了要通知用户"。
 * 仓储层不 import 界面相关的东西，只留一个口子。
 */
export type StoreHooks = {
  /** data.json 损坏，已改名备份 */
  onCorrupt?: (backupPath: string, error: Error) => void
}

let hooks: StoreHooks = {}

export function setStoreHooks(h: StoreHooks): void {
  hooks = h
}

/**
 * 数据迁移。必须幂等：跑两次不能重复处理。
 *
 * v1 → v2：设置里的 focusMin / shortBreakMin / longBreakMin / roundsBeforeLong
 * 这四个散字段，打包成一个名叫"我的设置"的模板并设为当前模板，
 * 老用户打开还是原来的时长。顺便补上四个内置模板。
 *
 * v2 → v3：主题系统。历史记录没有主题 = 未分类，补上 topicNameSnapshot 空串。
 */
function migrate(data: AppData): { data: AppData; changed: boolean } {
  let changed = false

  if (data.schemaVersion < 2) {
    const legacy = data.settings as unknown as Record<string, unknown>
    const presets = BUILTIN_PRESETS.map((p) => ({ ...p }))
    let activePresetId = DEFAULT_PRESET_ID

    if (typeof legacy['focusMin'] === 'number') {
      const mine = makePreset(
        {
          name: '我的设置',
          focusMin: Number(legacy['focusMin']) || 25,
          shortMin: Number(legacy['shortBreakMin']) || 5,
          longMin: Number(legacy['longBreakMin']) || 15,
          roundsBeforeLong: Number(legacy['roundsBeforeLong']) || 4
        },
        'preset-mine',
        false,
        presets.length
      )
      presets.push(mine)
      activePresetId = mine.id
    }

    const {
      focusMin: _f,
      shortMin: _s,
      longMin: _l,
      roundsBeforeLong: _r,
      ...rest
    } = legacy as Record<string, unknown>

    data.settings = {
      ...DEFAULT_SETTINGS,
      ...(rest as Partial<AppData['settings']>),
      presets,
      activePresetId
    } as AppData['settings']
    data.schemaVersion = 2
    changed = true
  }

  if (data.schemaVersion < 3) {
    data.settings.topics = Array.isArray(data.settings.topics) ? data.settings.topics : []
    data.settings.activeTopicId = data.settings.activeTopicId ?? null
    data.sessions = data.sessions.map((s) => ({
      ...s,
      topicId: s.topicId,
      topicNameSnapshot: s.topicNameSnapshot ?? ''
    }))
    data.schemaVersion = 3
    changed = true
  }

  return { data, changed }
}

/**
 * 读整个数据文件。
 *
 * 读不出来分三种情况，处理方式完全不同：
 *   - 文件不存在 → 当作全新安装（正常）
 *   - 文件存在但内容坏了 → **改名备份 + 记 ERROR + 通知用户**，
 *     然后当作全新安装继续跑（不能崩），但备份文件留着，用户/我能找回原件
 *   - 文件存在但读不了（权限等）→ 记 ERROR，当作没有数据
 */
async function readRaw(): Promise<AppData> {
  let text: string
  try {
    text = await fs.readFile(dataFile(), 'utf-8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return defaultData()
    log.error(`读数据文件失败：${e.message}`)
    return defaultData()
  }

  try {
    const parsed = JSON.parse(text) as Partial<AppData>
    const merged: AppData = {
      schemaVersion: parsed.schemaVersion ?? 1,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) } as AppData['settings'],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    }
    const result = migrate(merged)
    // 迁移完立刻落盘，免得每次启动都重跑一遍
    if (result.changed) await writeRaw(result.data)
    return result.data
  } catch (err) {
    // 文件坏了：改名备份，别直接覆盖 —— 原件要留着
    const backup = `${dataFile()}.corrupt-${Date.now()}`
    try {
      await fs.rename(dataFile(), backup)
      log.error(
        `数据文件损坏，已备份为 ${path.basename(backup)}：${(err as Error).message}`
      )
    } catch (e) {
      log.error(
        `数据文件损坏且备份失败：${(err as Error).message} / ${(e as Error).message}`
      )
    }
    hooks.onCorrupt?.(backup, err as Error)
    return defaultData()
  }
}

/** 临时文件名的序号：保证同一个进程里也不会撞名 */
let writeSeq = 0

async function writeRaw(data: AppData): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  const target = dataFile()
  // 临时名必须唯一：所有写共用一个 .tmp 时，两个写的内容会搅在一起（D6）
  const tmp = `${target}.${process.pid}.${writeSeq++}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tmp, target)
  } catch (err) {
    log.error(`写数据文件失败：${(err as Error).message}`)
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * 写入队列：所有会改文件的操作一个接一个做，绝不重叠（D1）。
 *
 * 以前是两个写各读各的、各写各的，后写的把先写的整个覆盖掉。
 * 现在排队：第二个写开始时，第一个已经落盘了。
 */
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

/**
 * 排队做一次"读 → 改 → 写"。
 *
 * `fn` 返回 false 表示"这次不用写盘"（比如要改的那条记录没找到）。
 */
function mutate<T>(fn: (data: AppData) => T | Promise<T>): Promise<T> {
  return enqueue(async () => {
    const data = await readRaw()
    const result = await fn(data)
    if (result === false) return result as T
    await writeRaw(data)
    return result
  })
}

export const jsonStore: Store = {
  async read() {
    return readRaw()
  },
  async write(data) {
    await enqueue(() => writeRaw(data))
  },
  async addSession(session) {
    await mutate((data) => {
      data.sessions.push(session)
    })
  },
  async updateSession(id, patch) {
    await mutate((data) => {
      const hit = data.sessions.find((s) => s.id === id)
      if (!hit) return false
      Object.assign(hit, patch)
    })
  },
  async listSessions() {
    const data = await readRaw()
    return data.sessions
  },
  async getSettings() {
    const data = await readRaw()
    return data.settings
  },
  async saveSettings(settings) {
    await mutate((data) => {
      data.settings = settings
    })
  }
}
