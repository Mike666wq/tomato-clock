// JSON 文件仓储实现：先写 .tmp 再 rename，避免断电/崩溃写坏文件。

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppData } from '../../shared/types'
import type { Store } from './index'

const SCHEMA_VERSION = 1

function dataDir(): string {
  return app.getPath('userData')
}

function dataFile(): string {
  return path.join(dataDir(), 'data.json')
}

function defaultData(): AppData {
  return { schemaVersion: SCHEMA_VERSION, settings: { ...DEFAULT_SETTINGS }, sessions: [] }
}

async function readRaw(): Promise<AppData> {
  try {
    const text = await fs.readFile(dataFile(), 'utf-8')
    const parsed = JSON.parse(text) as Partial<AppData>
    return {
      schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    }
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
