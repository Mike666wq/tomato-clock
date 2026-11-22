// JSON 文件仓储实现：先写 .tmp 再 rename，避免断电/崩溃写坏文件。

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppData } from '../../shared/types'
import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, makePreset } from '../../shared/presets'
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
      shortBreakMin: _s,
      longBreakMin: _l,
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

async function readRaw(): Promise<AppData> {
  try {
    const text = await fs.readFile(dataFile(), 'utf-8')
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
  } catch {
    return defaultData()
  }
}

async function writeRaw(data: AppData): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  const target = dataFile()
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, target)
}

export const jsonStore: Store = {
  async read() {
    return readRaw()
  },
  async write(data) {
    await writeRaw(data)
  },
  async addSession(session) {
    const data = await readRaw()
    data.sessions.push(session)
    await writeRaw(data)
  },
  async updateSession(id, patch) {
    const data = await readRaw()
    const hit = data.sessions.find((s) => s.id === id)
    if (hit) {
      Object.assign(hit, patch)
      await writeRaw(data)
    }
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
    const data = await readRaw()
    data.settings = settings
    await writeRaw(data)
  }
}
