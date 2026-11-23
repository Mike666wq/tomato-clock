// 崩溃恢复快照的单元测试（规格 E 组）。
//
// 存储层不 import electron：目录和日志都由调用方传进来，
// 所以这里能用临时目录直接测，不用起 Electron。

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeRunningState, type SnapshotLogger } from './running-state'
import type { RunningSnapshot } from '../shared/types'

let dir = ''
const logs: string[] = []
const logger: SnapshotLogger = {
  info: (m) => logs.push(`INFO ${m}`),
  warn: (m) => logs.push(`WARN ${m}`),
  error: (m) => logs.push(`ERROR ${m}`)
}

function snap(over: Partial<RunningSnapshot> = {}): RunningSnapshot {
  return {
    v: 1,
    phase: 'focus',
    running: true,
    segmentTotalSec: 1500,
    remainingSec: 1200,
    pausedSec: 0,
    startedAt: '2026-11-23T10:00:00.000Z',
    savedAt: '2026-11-23T10:05:00.000Z',
    task: '写方案',
    topicId: 't1',
    presetId: 'builtin-classic',
    segmentSeq: 3,
    focusRounds: 1,
    completed: { focus: 1, short: 1, long: 0 },
    ...over
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pm-snapshot-'))
  logs.length = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('E 组：崩溃恢复快照', () => {
  it('E7 快照存在独立的 running.json 里，不碰 data.json', () => {
    const state = makeRunningState(dir, logger)
    state.save(snap())
    const files = readdirSync(dir)
    expect(files).toContain('running.json')
    expect(files).not.toContain('data.json')
  })

  it('E4 落盘是原子写：先写 .tmp 再 rename，不留半截文件', () => {
    const state = makeRunningState(dir, logger)
    state.save(snap())
    // 落完盘只有最终文件，没有残留的 .tmp
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    const parsed = JSON.parse(readFileSync(state.file(), 'utf-8')) as RunningSnapshot
    expect(parsed.remainingSec).toBe(1200)
  })

  it('E1/E2 存进去再读出来，内容一致', () => {
    const state = makeRunningState(dir, logger)
    const original = snap()
    state.save(original)
    const loaded = state.load()
    expect(loaded).toEqual(original)
  })

  it('E6 文件损坏：不崩，返回 null，并把坏文件改名备份 + 记日志', () => {
    const state = makeRunningState(dir, logger)
    writeFileSync(state.file(), '{ 这不是 JSON', 'utf-8')

    const loaded = state.load()
    expect(loaded).toBeNull()
    // 坏文件被改名备份了
    const backups = readdirSync(dir).filter((f) => f.startsWith('running.json.corrupt-'))
    expect(backups).toHaveLength(1)
    // 记了日志
    expect(logs.some((l) => l.startsWith('ERROR'))).toBe(true)
  })

  it('E6b 结构不对（字段缺了）也当损坏处理', () => {
    const state = makeRunningState(dir, logger)
    writeFileSync(state.file(), JSON.stringify({ v: 1, phase: 'focus' }), 'utf-8')
    expect(state.load()).toBeNull()
    expect(readdirSync(dir).some((f) => f.startsWith('running.json.corrupt-'))).toBe(true)
  })

  it('E6c 快照文件不存在：返回 null，不报错', () => {
    const state = makeRunningState(dir, logger)
    expect(state.load()).toBeNull()
    expect(logs.filter((l) => l.startsWith('ERROR'))).toHaveLength(0)
  })

  it('E8 clear 之后读不到（旧快照被消费掉了）', () => {
    const state = makeRunningState(dir, logger)
    state.save(snap())
    expect(state.load()).not.toBeNull()
    state.clear()
    expect(state.load()).toBeNull()
  })

  it('E8b 恢复后写回的新快照会覆盖旧的（不会恢复到更早的段）', () => {
    const state = makeRunningState(dir, logger)
    state.save(snap({ remainingSec: 1200, segmentSeq: 3 }))
    const loaded = state.load()
    expect(loaded?.segmentSeq).toBe(3)

    // 恢复之后写回一份新快照
    state.save(snap({ remainingSec: 1180, segmentSeq: 3 }))
    const again = state.load()
    expect(again?.remainingSec).toBe(1180)
  })

  it('E9 换段后写回的快照是新的一段（段序号变大）', () => {
    const state = makeRunningState(dir, logger)
    state.save(snap({ segmentSeq: 3 }))
    state.save(snap({ segmentSeq: 4, phase: 'short' }))
    const loaded = state.load()
    expect(loaded?.segmentSeq).toBe(4)
    expect(loaded?.phase).toBe('short')
  })
})
