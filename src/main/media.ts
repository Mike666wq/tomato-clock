// 媒体控制（v0.2.2）：灵动岛展开态底部那一行「♪ 歌名 - 歌手」+ 三个按钮。
//
// 实现方式：常驻一个 C# 子进程（tools/smtc），它用 WinRT 的 SMTC 读当前会话、
// 发播放控制命令；主进程只负责 spawn、解析 stdout、把状态广播给渲染层。
//
// 为什么是子进程而不是在主进程里直接调 WinRT：
//   Electron 的主进程是 Node，没有 WinRT 投影；硬塞进来要带一整套 winmd 互操作
//   程序集（之前 PowerShell 那条路就是死在这）。子进程隔离干净，崩了也不带累主进程。
//
// 降级是常态，不是异常：
//   - 没装 .NET 运行时 / 找不到 exe → 音乐那一行永远不出现
//   - 没开音乐软件 → 状态为 null，那一行直接消失（不留空行、不报错）
//   - 子进程崩了 → 状态清空，安静重启几次，还不行就放弃
// 这些情况都不弹提示、不写错误条：用户没开 QQ 音乐是正常状态，不是故障。

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { log } from './logger'
import type { MediaSnapshot } from '../shared/types'

export type MediaCommand = 'play' | 'pause' | 'next' | 'prev'

export type MusicController = {
  /** 打开：启动子进程并开始轮询 */
  enable(): void
  /** 关闭：杀掉子进程，状态清空 */
  disable(): void
  isEnabled(): boolean
  /** 当前状态；null = 没有音乐在放 */
  getState(): MediaSnapshot | null
  /** 发控制命令 */
  command(cmd: MediaCommand): void
  dispose(): void
}

/** 子进程崩溃后最多安静重试几次 */
const MAX_RESTARTS = 3
/** 重试间隔 */
const RESTART_DELAY_MS = 5000

/**
 * 找 smtc.exe。
 *
 * 打包后它在 extraResources 里：<resourcesPath>/resources/smtc/smtc.exe
 * 开发期在项目里：<项目>/tools/smtc/publish/smtc.exe
 */
function resolveExe(): string | null {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'resources', 'smtc', 'smtc.exe'))
  }
  try {
    candidates.push(path.join(app.getAppPath(), 'tools', 'smtc', 'publish', 'smtc.exe'))
  } catch {
    /* app 还没就绪时取不到路径，忽略 */
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export function createMusicController(onChange: (state: MediaSnapshot | null) => void): MusicController {
  let child: ChildProcess | null = null
  let enabled = false
  let state: MediaSnapshot | null = null
  let restarts = 0
  let restartTimer: NodeJS.Timeout | null = null
  let buffer = ''

  const setState = (next: MediaSnapshot | null): void => {
    const same =
      state !== null &&
      next !== null &&
      state.title === next.title &&
      state.artist === next.artist &&
      state.playing === next.playing &&
      state.source === next.source
    if (same) return
    state = next
    onChange(next)
  }

  const stop = (): void => {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (child) {
      const c = child
      child = null
      c.removeAllListeners()
      try {
        c.kill()
      } catch {
        /* 已经退了 */
      }
    }
    buffer = ''
  }

  const spawnChild = (): void => {
    const exe = resolveExe()
    if (!exe) {
      // 找不到就彻底安静：这一版没有音乐控制，但别的功能照常
      log.warn('没找到 smtc.exe，音乐控制不可用（不影响其它功能）')
      enabled = false
      setState(null)
      return
    }
    try {
      child = spawn(exe, ['watch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      log.warn(`启动 smtc 子进程失败: ${(err as Error).message}`)
      enabled = false
      setState(null)
      return
    }

    const c = child
    c.stdout?.setEncoding('utf-8')
    c.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
        if (!line) continue
        handleLine(line)
      }
    })
    c.stderr?.setEncoding('utf-8')
    c.stderr?.on('data', (chunk: string) => {
      const t = chunk.trim()
      if (t) log.info(`smtc: ${t}`)
    })
    c.on('error', (err: Error) => {
      log.warn(`smtc 子进程出错: ${err.message}`)
      setState(null)
    })
    c.on('exit', (code) => {
      if (child !== c) return
      child = null
      setState(null)
      if (!enabled) return
      restarts += 1
      if (restarts > MAX_RESTARTS) {
        log.warn(`smtc 子进程连续退出（code=${code}），不再重试，音乐控制停用`)
        enabled = false
        return
      }
      log.info(`smtc 子进程退出（code=${code}），${RESTART_DELAY_MS / 1000}s 后重试`)
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (enabled) spawnChild()
      }, RESTART_DELAY_MS)
    })
  }

  const handleLine = (line: string): void => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const kind = String(parsed['kind'] ?? '')
    if (kind === 'state') {
      const title = String(parsed['title'] ?? '')
      const artist = String(parsed['artist'] ?? '')
      const source = String(parsed['source'] ?? '')
      const playing = Boolean(parsed['playing'])
      if (!title && !artist) {
        // 没有媒体在放：整行藏掉
        setState(null)
      } else {
        setState({ source, title, artist, playing })
      }
      return
    }
    if (kind === 'ack') {
      // 命令回执：ok 就乐观更新播放状态，让按钮立刻反应
      const cmd = String(parsed['command'] ?? '')
      const ok = Boolean(parsed['ok'])
      if (!ok) return
      if (cmd === 'play' && state) setState({ ...state, playing: true })
      if (cmd === 'pause' && state) setState({ ...state, playing: false })
    }
  }

  return {
    enable(): void {
      if (enabled) return
      enabled = true
      restarts = 0
      spawnChild()
    },
    disable(): void {
      enabled = false
      stop()
      setState(null)
    },
    isEnabled: () => enabled,
    getState: () => state,
    command(cmd: MediaCommand): void {
      if (!child || !child.stdin || child.stdin.destroyed) return
      try {
        child.stdin.write(`${cmd}\n`)
      } catch (err) {
        log.warn(`发音乐命令失败: ${(err as Error).message}`)
      }
    },
    dispose(): void {
      enabled = false
      stop()
      setState(null)
    }
  }
}
