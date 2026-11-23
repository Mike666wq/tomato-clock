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

/**
 * 等真实状态回流的超时。
 *
 * 命令发出去之后，界面先进入过渡态（pending），
 * 真实状态回来就改图标；这么久还没回来就恢复原样。
 */
const PENDING_TIMEOUT_MS = 400

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
  /** 开发期：伪造一条"正在放歌"的状态（截图/测量用；打包产物里没有这个口子） */
  setDevState(state: MediaSnapshot | null): void
  /** 当前系统主音量（0-100）；null = 拿不到 */
  getVolume(): number | null
  /** 设系统主音量（0-100）；**界面会立刻本地更新**，不等子进程回读 */
  setVolume(percent: number): void
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
  let pendingTimer: NodeJS.Timeout | null = null
  /**
   * 音量**独立于媒体状态**单独记一份。
   *
   * 以前它挂在 MediaSnapshot 里，可"没有音乐会话"时整个状态是 null，
   * 音量也就跟着读不到了 —— 而音量是系统级的，跟有没有歌在放没关系。
   */
  let volume: number | null = null
  let volumeOk = false
  /**
   * 开发期的"假状态"（截图/测量时伪造一条正在放歌）。
   *
   * 有它的时候，helper 推来的**空 state 不该把界面清掉** ——
   * 不然界面每被清一次，音量滑条那个 DOM 节点就重建一次，
   * 绑在它上面的事件监听全丢（实测踩过：按下能生效、拖动收不到 move）。
   */
  let devFake: MediaSnapshot | null = null

  const setState = (next: MediaSnapshot | null): void => {
    const same =
      state !== null &&
      next !== null &&
      state.title === next.title &&
      state.artist === next.artist &&
      state.playing === next.playing &&
      state.source === next.source &&
      state.volume === next.volume &&
      state.volumeOk === next.volumeOk &&
      state.pending === next.pending
    if (same) return
    state = next
    onChange(next)
  }

  /** 清掉"等真实状态回流"的过渡态 */
  const clearPending = (): void => {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }

  const stop = (): void => {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    clearPending()
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
      // ⚠ **退出码要分清"自己崩"和"被外部终止"**：
      //   0xFFFFFFFF（-1，Windows 上显示成 4294967295）是**被外部杀掉**的典型值，
      //   不是自己崩的。两者混在一起写日志，以后就分不清是不是被人关掉了。
      const external = code === 4294967295 || code === -1
      if (restarts > MAX_RESTARTS) {
        log.warn(
          `smtc 子进程连续退出（code=${code}${external ? '，是被外部终止的' : ''}），不再重试，音乐控制停用`
        )
        enabled = false
        return
      }
      log.info(
        external
          ? `smtc 子进程被外部终止（code=${code}，不是崩溃），${RESTART_DELAY_MS / 1000}s 后重试`
          : `smtc 子进程退出（code=${code}），${RESTART_DELAY_MS / 1000}s 后重试`
      )
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
      const volumeValue = Number(parsed['volume'] ?? 0)
      const volumeValueOk = Boolean(parsed['volumeOk'])
      volume = volumeValue
      volumeOk = volumeValueOk
      // 真实状态回来了 → 过渡态结束
      clearPending()
      if (!title && !artist) {
        // 没有媒体在放：整行藏掉
        // （开发期的假状态除外：它在的时候别把它清掉）
        if (!devFake) setState(null)
      } else {
        setState({ source, title, artist, playing, volume, volumeOk, pending: '' })
      }
      return
    }
    if (kind === 'volume') {
      // 音量变了（外部按了音量键，或我们自己设的）
      const ok = Boolean(parsed['ok'])
      const value = Number(parsed['value'] ?? 0)
      volume = value
      volumeOk = ok
      if (!state) return
      setState({ ...state, volume: value, volumeOk: ok })
      return
    }
    if (kind === 'ack') {
      const cmd = String(parsed['command'] ?? '')
      const ok = Boolean(parsed['ok'])
      if (cmd === 'vol') {
        // 音量命令的回执：音量值由 kind=volume 那条带
        return
      }
      if (!state) return
      if (!ok) {
        // 命令**没生效**（helper 试过了，SMTC 和媒体键都没能让它动）
        // → 直接恢复原样，不假装点过了
        clearPending()
        setState({ ...state, pending: '' })
        return
      }
      // ⚠ **不做乐观更新**：以前收到 ok 就把按钮切成"暂停"，
      //   结果是"看起来点了、其实音乐没停"（QQ 音乐只肯读不肯收）。
      //   现在只进入过渡态，等**真实状态**回流才改图标。
      setState({ ...state, pending: cmd })
      clearPending()
      pendingTimer = setTimeout(() => {
        pendingTimer = null
        if (state && state.pending === cmd) setState({ ...state, pending: '' })
      }, PENDING_TIMEOUT_MS)
      return
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
    setDevState(state: MediaSnapshot | null): void {
      devFake = state
      if (state) setState({ ...state, pending: '' })
      else setState(null)
    },
    getVolume(): number | null {
      return volumeOk ? volume : null
    },
    setVolume(percent: number): void {
      const v = Math.max(0, Math.min(100, Math.round(percent)))
      log.info(`设系统音量：${v}%`)
      // 音量是系统级的，跟有没有歌在放无关 —— 状态为 null 也要记
      volume = v
      volumeOk = true
      // **界面先本地更新**：拖滑条时要跟手，不能等子进程回读
      if (state) setState({ ...state, volume: v })
      if (!child || !child.stdin || child.stdin.destroyed) return
      try {
        child.stdin.write(`vol ${v}\n`)
      } catch (err) {
        log.warn(`设音量失败: ${(err as Error).message}`)
      }
    },
    dispose(): void {
      enabled = false
      stop()
      setState(null)
    }
  }
}
