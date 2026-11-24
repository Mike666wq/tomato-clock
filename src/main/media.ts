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

/**
 * 媒体命令。
 *
 * `toggle` = 播放/暂停切换，**只在读不到会话时用**：
 * 那时不知道当前是在放还是在停，让 Windows 自己判断（媒体键本来就是切换语义）。
 */
export type MediaCommand = 'play' | 'pause' | 'next' | 'prev' | 'toggle'

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
  /** 重启子进程（自愈用：解锁/恢复后卡住的那个 WinRT 调用，换个进程就好） */
  restart(): void
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
 * helper 的**自愈退出码**。
 *
 * helper 连续读不到 SMTC 会话时会自己退出（码 3），让主进程拉一个新的 ——
 * 那是**正常的自愈**，不是崩溃，**不消耗崩溃重启的配额**。
 *
 * ⚠ 不区分的话：自愈退出 3 次之后 `enabled = false`，
 *   音乐控制就**彻底停用**了 —— 表现是"音量滑条拖了没反应、
 *   日志里显示设了 80%/60% 但系统音量纹丝不动"（实测踩过）。
 */
const SELF_HEAL_EXIT_CODE = 3

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
   * **音频会话给的播放方向**（2026-11-24 加）。
   *
   * 跟音量一样**单独记一份**：没有会话时整个媒体状态可能被清掉，
   * 但"在放还是在停"是系统级的事实，不该跟着会话一起丢。
   */
  let audioPlaying: boolean | null = null
  /**
   * 方向是峰值判的（实时）还是退回会话状态的（可能滞后几十秒）。
   * 跟 audioPlaying 一样单独记一份。
   */
  let audioPeakKnownState = false
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
      state.audioPlaying === next.audioPlaying &&
      state.audioPeakKnown === next.audioPeakKnown &&
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
      // ⚠ **自愈退出不算崩溃**：helper 读不到 SMTC 会话时会主动退出（码 3），
      //   让主进程拉一个新的。那是正常的自愈，**不消耗崩溃重启配额**。
      const selfHeal = code === SELF_HEAL_EXIT_CODE
      if (!selfHeal) {
        restarts += 1
      }
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
      if (selfHeal) {
        log.info(`smtc 子进程自愈退出（code=${code}，读不到会话），${RESTART_DELAY_MS / 1000}s 后重启`)
      } else {
        log.info(
          external
            ? `smtc 子进程被外部终止（code=${code}，不是崩溃），${RESTART_DELAY_MS / 1000}s 后重试`
            : `smtc 子进程退出（code=${code}），${RESTART_DELAY_MS / 1000}s 后重试`
        )
      }
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
      // ⚠ **音频会话给的播放方向**（2026-11-24 加）：
      //   true=正在出声，false=暂停，null=不知道（helper 读不到）。
      //   三种情况都要分清 —— 把"不知道"当成 false 就是**猜**，用户看得出来。
      const audioRaw = parsed['audioPlaying']
      const audioState: boolean | null =
        audioRaw === null || audioRaw === undefined ? null : Boolean(audioRaw)
      // 这个方向是峰值判的（实时）还是退回会话状态的（可能滞后几十秒）
      const audioPeakKnown = Boolean(parsed['audioPeakKnown'])
      // ⚠ 单独记一份（见上面 audioPlaying 的注释）：会话没了它也得留着
      audioPlaying = audioState
      audioPeakKnownState = audioPeakKnown
      volume = volumeValue
      volumeOk = volumeValueOk
      // 真实状态回来了 → 过渡态结束
      clearPending()
      // ⚠ **有会话 = title 或 artist 至少有一个**。
      //   没有会话时照样要把状态发出去 —— 因为**音量是系统级的**，
      //   跟有没有会话无关（不发的��，界面就拿不到 volumeOk → 音量入口被隐藏）。
      const hasSession = title !== '' || artist !== ''
      if (!hasSession) {
        // 没有媒体在放：整行藏掉
        // （开发期的假状态除外：它在的时候别把它清掉）
        if (!devFake) {
          setState({
            source: '',
            title: '',
            artist: '',
            playing: false,
            hasSession: false,
            audioPlaying: audioState,
            audioPeakKnown,
            volume,
            volumeOk,
            pending: ''
          })
        }
      } else {
        setState({
          source,
          title,
          artist,
          playing,
          hasSession: true,
          audioPlaying: audioState,
          audioPeakKnown,
          volume,
          volumeOk,
          pending: ''
        })
      }
      return
    }
    if (kind === 'volume') {
      // 音量变了（外部按了音量键，或我们自己设的）
      const ok = Boolean(parsed['ok'])
      const value = Number(parsed['value'] ?? 0)
      volume = value
      volumeOk = ok
      // ⚠ **音量跟会话无关**：没有媒体会话时也要广播出去。
      //   否则 `state` 是 null → 界面拿不到 volumeOk → **音量入口被隐藏** ——
      //   而音量是系统级的，明明读得到（实测：读得到 25，音量按钮却不显示）。
      if (!state) {
        // 没有会话就没有 state 可更新，但音量本身要能传到界面上。
        // 办法：造一个"只有音量"的状态发出去（界面据此显示音量入口）。
        if (devFake) {
          setState({
            ...devFake,
            volume: value,
            volumeOk: ok,
            pending: ''
          })
        } else {
          onChange({
            source: '',
            title: '',
            artist: '',
            playing: false,
            hasSession: false,
            audioPlaying: audioPlaying,
            audioPeakKnown: audioPeakKnownState,
            volume: value,
            volumeOk: ok,
            pending: ''
          })
        }
        return
      }
      setState({ ...state, volume: value, volumeOk: ok })
      return
    }
    if (kind === 'ack') {
      const cmd = String(parsed['command'] ?? '')
      const ok = Boolean(parsed['ok'])
      const changed = Boolean(parsed['changed'])
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
      if (!changed) {
        // ⚠ **命令发出去了，但没法确认有没有生效**（读不到 SMTC 状态时就是这个情况）。
        //   这时**不进过渡态**：进了就会让界面显示"正在暂停…"，
        //   然后 400ms 后弹回来 —— 看着像"点了没反应"。
        //   保持原样更诚实：用户看到的是"图标没变"，
        //   而不是"闪了一下又变回去"。
        //   （2026-11-24 中午：SMTC 读会话这条路在这台机器上是死的，
        //     命令只能靠全局媒体键发出去，效果无法验证。）
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

  /**
   * 往 helper 的 stdin 写一行。
   *
   * ⚠ **写给一个已经死掉的子进程 = 静默丢失**：
   *   `child.stdin.write` 对已退出的进程**不报错**（写进一个断掉的管道），
   *   于是主进程日志里明明写着「设系统音量：80%」，
   *   系统音量却纹丝不动 —— 极难查（实测踩过）。
   *
   * 所以：写之前先确认子进程还在；不在就**立刻重启**再写。
   */
  const writeToHelper = (line: string): boolean => {
    if (!child || child.exitCode !== null || !child.stdin || child.stdin.destroyed) {
      // 子进程不在了（自愈退出 / 崩了）→ 重启一个再来
      if (enabled && !child) {
        log.info('媒体子进程不在了，重启后再发命令')
        restarts = 0
        spawnChild()
      }
      if (!child || !child.stdin || child.stdin.destroyed) return false
    }
    try {
      child.stdin.write(line)
      return true
    } catch (err) {
      log.warn(`发媒体命令失败: ${(err as Error).message}`)
      return false
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
    /**
     * **重启 helper 子进程**（自愈用）。
     *
     * 为什么需要（2026-11-24）：SMTC 读会话这条路**时好时坏** ——
     * 昨晚还能读到歌名，之后就读不到了（`RequestAsync` 不返回）。
     * 一旦卡住，重启这个子进程往往能恢复：
     * 卡住的是进程内部那个 WinRT 调用和缓存的 manager，换个进程就是新的。
     *
     * 触发时机：解锁屏幕 / 从睡眠恢复（那正是"昨晚好用、今天不好用"的分界点）。
     */
    restart(): void {
      if (!enabled) return
      log.info('重启媒体子进程（解锁/恢复后自愈）')
      stop()
      // 清掉计数，否则这次重启会被当成"又崩了一次"而很快放弃
      restarts = 0
      spawnChild()
    },
    isEnabled: () => enabled,
    getState: () => state,
    command(cmd: MediaCommand): void {
      if (!writeToHelper(`${cmd}\n`)) return
    },
    setDevState(state: MediaSnapshot | null): void {
      devFake = state
      if (state) {
        // ⚠ **假状态不能带 volume / volumeOk**：
        //   音量是**系统级的真实值**，由 helper 的 kind=volume 行单独推送。
        //   假状态带一个假音量会把主进程记的音量带偏，
        //   拖动滑条时"主进程记的值"和"系统真值"就对不上
        //   （实测：主进程记 10，系统真值 25 —— 断言会误判成"拖动没生效"）。
        //   所以这里一律用**真实的 volume / volumeOk**。
        setState({ ...state, volume: volume ?? 0, volumeOk, pending: '' })
      } else {
        // ⚠ **清掉假状态 ≠ 把整个状态清空**：
        //   音量是系统级的，跟会话无关。直接 setState(null) 会把 volumeOk 一起丢掉 →
        //   界面拿不到它 → **音量入口被隐藏**（明明读得到音量）。
        //   所以清成"没有会话、但音量照常"的状态。
        setState({
          source: '',
          title: '',
          artist: '',
          playing: false,
          hasSession: false,
          audioPlaying: null,
          audioPeakKnown: false,
          volume: volume ?? 0,
          volumeOk,
          pending: ''
        })
      }
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
      // ⚠ 用 writeToHelper：写给死掉的子进程会**静默丢失**（见它的注释）
      writeToHelper(`vol ${v}\n`)
    },
    dispose(): void {
      enabled = false
      stop()
      setState(null)
    }
  }
}
