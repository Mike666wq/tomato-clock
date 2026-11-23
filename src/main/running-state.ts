// 崩溃恢复快照的存取（规格 E 组）。
//
// 为什么单独一个文件，不塞进 data.json：
//   - data.json 装的是"设置 + 全部历史记录"，每 30 秒重写它一次
//     = 每 30 秒把所有历史记录重新序列化一遍，记录越多越慢。
//   - 快照是临时状态（一段跑完就没了），混进用户数据里两边互相污染。
//   - E6 要求"坏文件改名备份不崩"，独立文件才能单独做这件事。
//
// 全部走原子写：先写 .tmp，再 rename（同目录，rename 在 Windows 上是原子的）。
//
// 这个模块**不 import electron**：目录由调用方传进来，日志由调用方注入。
// 这样它能在单元测试里用临时目录直接测，不用起 Electron。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { RunningSnapshot } from '../shared/types'

/** 日志接口。默认往控制台打；主进程会注入带落盘的那种 */
export type SnapshotLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type RunningState = {
  /** 落盘（原子写） */
  save: (snapshot: RunningSnapshot) => void
  /** 读快照；没有或损坏时返回 null（损坏的会先改名备份） */
  load: () => RunningSnapshot | null
  /** 清掉快照（没有要恢复的东西时用） */
  clear: () => void
  /** 快照文件的完整路径（给日志用） */
  file: () => string
}

/** 快照文件名 */
const SNAPSHOT_NAME = 'running.json'

/** 判断一个解析出来的东西是不是像样的快照 */
function isValid(v: unknown): v is RunningSnapshot {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<RunningSnapshot>
  return (
    s.v === 1 &&
    typeof s.phase === 'string' &&
    typeof s.segmentTotalSec === 'number' &&
    typeof s.remainingSec === 'number' &&
    typeof s.focusRounds === 'number'
  )
}

export function makeRunningState(dir: string, logger?: SnapshotLogger): RunningState {
  const file = (): string => path.join(dir, SNAPSHOT_NAME)
  const log = logger ?? {
    info: (m: string) => console.log(`[pomodoro] INFO ${m}`),
    warn: (m: string) => console.warn(`[pomodoro] WARN ${m}`),
    error: (m: string) => console.error(`[pomodoro] ERROR ${m}`)
  }

  return {
    file,

    save(snapshot: RunningSnapshot): void {
      const target = file()
      const tmp = `${target}.tmp`
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8')
        renameSync(tmp, target)
      } catch (err) {
        // 落盘失败不能把主进程带崩：顶多是没有恢复能力而已
        log.warn(`写恢复快照失败：${(err as Error).message}`)
        try {
          rmSync(tmp, { force: true })
        } catch {
          /* 忽略 */
        }
      }
    },

    load(): RunningSnapshot | null {
      const target = file()
      if (!existsSync(target)) return null
      try {
        const text = readFileSync(target, 'utf-8')
        const parsed: unknown = JSON.parse(text)
        if (!isValid(parsed)) throw new Error('快照结构不对')
        return parsed
      } catch (err) {
        // E6：损坏 → 改名备份 + 记日志，然后走默认值（全新开始），不崩
        const backup = `${target}.corrupt-${Date.now()}`
        try {
          renameSync(target, backup)
          log.error(`恢复快照损坏，已备份为 ${path.basename(backup)}：${(err as Error).message}`)
        } catch (e) {
          log.error(`恢复快照损坏且备份失败：${(err as Error).message} / ${(e as Error).message}`)
        }
        return null
      }
    },

    clear(): void {
      try {
        rmSync(file(), { force: true })
      } catch (err) {
        log.warn(`清恢复快照失败：${(err as Error).message}`)
      }
    }
  }
}
