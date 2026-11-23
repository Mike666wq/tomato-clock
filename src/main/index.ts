// 主进程入口：窗口、托盘、全局快捷键、计时核心、结束强提醒、本地持久化、单实例锁。
//
// 一条不可动摇的架构约定（方案第八节）：计时状态归主进程持有，
// 窗口关掉（收进托盘）计时照样走，渲染层只读状态、发动作。

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { jsonStore, setStoreHooks } from './store/json-store'
import { settingsStore } from './store/settings-store'
import { setupScreenshot, setupIslandScreenshot } from './screenshot'
import { Timer, type TimerAction } from './timer'
import { createTray, type TrayController } from './tray'
import { createIsland, type IslandController } from './island'
import { createReminder, type ReminderController } from './reminder'
import { createMusicController, type MediaCommand, type MusicController } from './media'
import { makeRunningState, type RunningState } from './running-state'
import { getShortcutLabels, registerShortcuts, replaceShortcut, type ShortcutId } from './shortcuts'
import { buildStats } from './stats'
import { exportCsv } from './csv'
import { log } from './logger'
import { nowDate, setClockOffset } from './clock'
import { localDateKey, msUntilNextMidnight, sessionDayKey } from '../shared/day'
import {
  DEFAULT_SETTINGS,
  PHASE_LABEL,
  UI_THEME_BG,
  resolveUiTheme,
  timerConfigOf,
  type InterruptKind,
  type Notice,
  type PhaseCompleteInfo,
  type RecordSummary,
  type Session,
  type Settings
} from '../shared/types'
import { formatAccelerator } from '../shared/format'

/**
 * 窗口底色跟主题走。
 *
 * 无边框窗口在内容渲染前会露出窗口底色，纸感是浅底——底色还写死深色的话，
 * 每次启动都会先闪一下黑。所以这里按主题算，纸感用纸色、霓虹用近黑。
 */
function windowBgOf(settings: Settings): string {
  const r = resolveUiTheme(
    settings.uiTheme ?? 'paper',
    settings.uiMode ?? 'system',
    nativeTheme.shouldUseDarkColors
  )
  return UI_THEME_BG[r.theme][r.mode]
}

/** 记录卡片等不到人回应就自动落记录的时限 */
const RECORD_AUTO_CLOSE_MS = 60_000

/** 窗口最小尺寸。再小的话圆环和底部那组就挤不下了 */
const MIN_WIN_W = 420
const MIN_WIN_H = 560

let mainWindow: BrowserWindow | null = null
let island: IslandController | null = null
let tray: TrayController | null = null
let timer: Timer | null = null
let reminder: ReminderController | null = null
let music: MusicController | null = null
/** 崩溃恢复快照的存取（规格 E 组） */
let runningState: RunningState | null = null
/** 当前模板 id：写进快照只作记录用 */
let activePresetId = 'builtin-classic'
/** 落盘防抖：状态变化后 1 秒才写（规格 E4） */
let persistTimer: NodeJS.Timeout | null = null
/** 心跳：每 30 秒落一次盘 */
let persistHeartbeat: NodeJS.Timeout | null = null
/** 上次落盘时的段序号：用来发现"换段了" */
let lastPersistedSeq = -1
let isQuitting = false
let recordAutoClose: NodeJS.Timeout | null = null
/** 跨零点重算的定时器（到了零点推一次新的汇总） */
let midnightTimer: NodeJS.Timeout | null = null
/** 窗口位置/大小的落盘防抖：拖动时别一路写盘 */
let boundsTimer: NodeJS.Timeout | null = null
/** 渲染层还没加载完时收到的通知，先存着，等页面就绪再补发 */
const pendingNotices: Notice[] = []

function pushNotice(text: string, tone: Notice['tone']): void {
  const notice: Notice = { id: randomUUID(), text, tone }
  pendingNotices.push(notice)
  broadcast('notice:show', notice)
}

function showWindow(): void {
  const win = mainWindow
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * 今天（本地日期）的 YYYY-MM-DD。
 *
 * 用注入的时钟：跨零点的行为要能测，不能只能等真的午夜。
 */
function todayKey(): string {
  return localDateKey(nowDate())
}

async function buildSummary(): Promise<RecordSummary> {
  const sessions = await jsonStore.listSessions()
  const today = todayKey()
  let todayCount = 0
  let todayFocusSec = 0
  let totalFocusSec = 0

  for (const s of sessions) {
    if (s.kind !== 'focus') continue
    totalFocusSec += s.actualSec ?? 0
    if (!s.completed) continue
    // 「今天」按**开始时间**算（规格第四节）。
    // 以前这里按结束时间算、统计页按开始时间算 ——
    // 跨零点的那一条番茄，主界面说 0 个、统计页说 1 个（v0.6 缺陷 D3）。
    if (sessionDayKey(s.startedAt) === today) {
      todayCount += 1
      todayFocusSec += s.actualSec ?? 0
    }
  }

  return { todayCount, todayFocusSec, totalFocusSec }
}

async function pushSummary(): Promise<void> {
  broadcast('records:summary', await buildSummary())
}

/** 显示 / 隐藏灵动岛，并把这个选择记进设置（下次启动照旧） */
async function setIslandVisible(visible: boolean): Promise<void> {
  if (visible) island?.show()
  else island?.hide()
  try {
    await settingsStore.save({ islandVisible: visible })
  } catch (err) {
    log.error(`记灵动岛显示状态失败：${(err as Error).message}`)
  }
  log.info(`灵动岛已${visible ? '显示' : '隐藏'}`)
}

/**
 * 到了零点重算一次"今天"，推给所有窗口（v0.6 缺陷 D4）。
 *
 * 以前只在"落了记录"和"启动时"推汇总：程序开着一夜不产生记录，
 * 主界面就一直显示昨天的数字，而统计页（5 秒轮询）已经归零了 ——
 * 同一个"今天"，两个数。
 *
 * 用定时器而不是轮询：一个自用工具不该每 5 秒醒一次，费电。
 */
function scheduleMidnightRefresh(): void {
  if (midnightTimer) {
    clearTimeout(midnightTimer)
    midnightTimer = null
  }
  const ms = msUntilNextMidnight(nowDate())
  midnightTimer = setTimeout(() => {
    midnightTimer = null
    void pushSummary()
    scheduleMidnightRefresh()
  }, ms)
}

/** 立刻写一次快照（规格 E4：原子写） */
function writeSnapshot(force = false): void {
  if (!runningState || !timer) return
  const snap = timer.getSnapshot()
  runningState.save({ ...snap, presetId: activePresetId, running: force ? false : snap.running })
  lastPersistedSeq = snap.segmentSeq
}

/**
 * 状态变化后安排一次落盘（规格 E4）。
 *
 * 两档：
 *   - **换段了**（跳过 / 阶段切换 / 重置）→ 立刻写，不等防抖。
 *     否则跳过之后有 1 秒窗口，文件里还留着上一段（规格 E9）。
 *   - 其它变化（每秒的倒计时、任务名改动）→ 1 秒防抖后写一次。
 */
function schedulePersist(): void {
  if (!runningState || !timer) return
  const seq = timer.getSnapshot().segmentSeq
  if (seq !== lastPersistedSeq) {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    writeSnapshot()
    return
  }
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeSnapshot()
  }, 1000)
}

/** 一个阶段自然跑完（或被跳过）：落记录 + 强提醒 + 打开记录卡片 */
async function handlePhaseComplete(info: PhaseCompleteInfo): Promise<void> {
  // 主题：只有专注段挂主题，休息段不挂（方案第四节）
  const settings = await settingsStore.get()
  const topicId = info.topicId ?? null
  const topic = topicId ? settings.topics.find((t) => t.id === topicId) : undefined

  const session: Session = {
    id: randomUUID(),
    kind: info.phase,
    startedAt: info.startedAt,
    endedAt: info.endedAt,
    plannedSec: info.plannedSec,
    actualSec: info.actualSec,
    pausedSec: info.pausedSec,
    // 跳过的段记成"没完成"（规格 C1）：统计里"我试过但没做完"也看得见
    completed: info.completed,
    task: info.task,
    interrupt: 'none',
    topicId: topicId ?? undefined,
    // 存一份当时的主题名：以后改名了，历史记录还读得懂
    topicNameSnapshot: topic?.name ?? ''
  }

  // 先落盘：用户不回应也不能丢数据
  await jsonStore.addSession(session)
  await pushSummary()

  // 跳过的那一段：不响铃、不弹卡片、不把窗口抢到前台。
  // 用户是自己跳过的，再来一套"到点提醒"是打扰。
  if (!info.completed) {
    log.info(`跳过了一段 ${info.phase}：已记录（未完成）`)
    return
  }

  const title = info.phase === 'focus' ? '专注结束' : `${PHASE_LABEL[info.phase]}结束`
  const body =
    info.phase === 'focus' ? '起来活动一下，准备进入休息' : '回到工作，继续下一个番茄'

  // 1) 窗口置顶 + 切到前台  2) 系统通知
  reminder?.fire(mainWindow!, { title, body })
  // 3) 声音 + 边框闪烁（渲染层做）
  broadcast('reminder:fire', { title, body, phase: info.phase })
  // 记录卡片
  broadcast('record:open', session)

  if (recordAutoClose) clearTimeout(recordAutoClose)
  recordAutoClose = setTimeout(() => {
    // 60 秒没人回应：按"已完成、无任务、无打断"落一条（记录本来就已经落盘了）
    broadcast('record:close')
    reminder?.release(mainWindow!)
    recordAutoClose = null
  }, RECORD_AUTO_CLOSE_MS)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: DEFAULT_SETTINGS.window.w,
    height: DEFAULT_SETTINGS.window.h,
    minWidth: MIN_WIN_W,
    minHeight: MIN_WIN_H,
    frame: false,
    show: false,
    backgroundColor: UI_THEME_BG.paper.light,
    title: '番茄钟',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 恢复上次窗口位置（越界则摆回屏幕内）
  void settingsStore.get().then((settings) => {
    // 窗口底色跟着主题走（纸感是浅底，别闪黑）
    win.setBackgroundColor(windowBgOf(settings))
    const w = settings.window ?? DEFAULT_SETTINGS.window
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    const x =
      typeof w.x === 'number' ? Math.min(Math.max(w.x, area.x), area.x + area.width - 100) : undefined
    const y =
      typeof w.y === 'number' ? Math.min(Math.max(w.y, area.y), area.y + area.height - 100) : undefined
    if (x !== undefined && y !== undefined) win.setPosition(x, y)
    // 记住的尺寸可能比最小尺寸还小（旧版本存进去的）——强行修正，
    // 不然一启动就是一个塞不下的窗口
    if (w.w && w.h) {
      const width = Math.max(w.w, MIN_WIN_W)
      const height = Math.min(Math.max(w.h, MIN_WIN_H), area.height)
      win.setSize(width, height)
    }
  })

  win.once('ready-to-show', () => win.show())

  // preload 是界面和主进程之间的唯一通道，加载失败必须看得见
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    log.error(`preload 加载失败 ${preloadPath}: ${error.message}`)
  })
  win.webContents.on('did-finish-load', () => {
    void win.webContents
      .executeJavaScript('typeof window.pomodoro')
      .then((r) => log.info(`preload API 自检: ${String(r)}`))
      .catch((err: Error) => log.error(`preload API 自检失败: ${err.message}`))
  })
  win.webContents.on('console-message', (event) => {
    // Electron 45 起 console-message 改为传事件对象
    const level = String(event.level)
    if (level === 'warning' || level === 'error') {
      log.warn(`renderer[${level}]: ${event.message}`)
    }
  })

  /**
   * 记住窗口位置与大小。
   *
   * 只写 window 这一个字段，而且走设置单例的队列 ——
   * 以前是"读整份设置 → 改 window → 写回整份"，用的那份快照可能比
   * 主题改动更旧，于是拖一下窗口就把主题顶回去了（v0.6 缺陷 D2）。
   *
   * 拖动会连着触发几十次 resize/move，所以防抖 300ms。
   */
  const writeBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    const b = win.getBounds()
    void settingsStore
      .save({ window: { x: b.x, y: b.y, w: b.width, h: b.height } })
      .catch((err) => log.error(`记窗口位置失败：${(err as Error).message}`))
  }
  const saveBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      writeBounds()
    }, 300)
  }
  /** 关窗口前要立刻写下去，不能等防抖 */
  const flushBounds = (): void => {
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
    writeBounds()
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)

  // 关闭窗口不退出，收进托盘（计时继续走）
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      flushBounds()
      win.hide()
    }
  })

  /**
   * 双击标题栏 = 最大化/还原（Windows 的肌肉记忆，缺了会觉得窗口卡住了）。
   *
   * 为什么在主进程认：标题栏是 `-webkit-app-region: drag` 的拖拽区，
   * **拖拽区不把鼠标事件送给页面**（实测 dblclick 一次都不触发），
   * 所以渲染层根本收不到这个双击。
   * `input-event` 是 Electron 自己在浏览器进程里收到的鼠标事件，带 clickCount，
   * 在这里认 clickCount===2 就够了。
   *
   * 只认窗口最上面那一条（y < 30）：再往下是阶段标签和内容区，
   * 双击那里不该动窗口。纸感的主题栏高 32、其它主题 44，30 都在标题栏里。
   */
  win.webContents.on('input-event', (_e, input) => {
    const ev = input as Electron.MouseInputEvent
    if (ev.type !== 'mouseDown' || ev.button !== 'left') return
    if (ev.clickCount !== 2) return
    if (ev.y > 30) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  // DEV 判断不能省：这一段里的开发期变量名不能进打包产物
  if (import.meta.env.DEV && devUrl) {
    // 开发期支持 ?page=stats 之类的预览参数
    const q: string[] = []
    const phase = process.env['POMODORO_PHASE']
    const elapsed = process.env['POMODORO_ELAPSED']
    const page = process.env['POMODORO_PAGE']
    if (phase) q.push(`phase=${phase}`)
    if (elapsed) q.push(`elapsed=${elapsed}`)
    if (page) q.push(`page=${page}`)
    void win.loadURL(q.length ? `${devUrl}?${q.join('&')}` : devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerAllShortcuts(): void {
  const failed = registerShortcuts({
    toggle: () => timer?.apply('toggle'),
    show: () => showWindow()
  })
  for (const acc of failed) {
    // 光写日志用户看不见，要推到界面上（用给人看的写法）
    pushNotice(`快捷键 ${formatAccelerator(acc, process.platform)} 注册失败，可能被其他程序占用`, 'warn')
  }
}

/**
 * 开发期：把 userData 指到别处，免得和用户正式版抢单实例锁。
 *
 * 必须在 requestSingleInstanceLock 之前改 —— 锁是按 userData 目录算的。
 * 打包版里 import.meta.env.DEV 是 false，这一段整段摇掉，产物里没有这个口子。
 */
if (import.meta.env.DEV && process.env['POMODORO_USER_DATA']) {
  app.setPath('userData', process.env['POMODORO_USER_DATA'])
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 开发期开放 DevTools 协议端口，便于自动化验证 IPC 与界面状态
  if (import.meta.env.DEV) {
    app.commandLine.appendSwitch('remote-debugging-port', '9222')
  }

  app.on('second-instance', () => showWindow())

  void app.whenReady().then(async () => {
    // 数据文件坏了要告诉用户（v0.6 缺陷 D6）：
    // 改名备份 + 记 ERROR + 界面上给一条提示，不许静默当默认数据。
    setStoreHooks({
      onCorrupt: (backupPath, error) => {
        pushNotice(`数据文件损坏，已备份为 ${path.basename(backupPath)}`, 'warn')
        log.error(`数据文件损坏：${error.message}`)
      }
    })

    mainWindow = createWindow()
    reminder = createReminder()
    // 灵动岛：常驻贴顶的透明胶囊（v0.2）
    island = createIsland({
      openMain: () => showWindow(),
      openSettings: () => {
        showWindow()
        mainWindow?.webContents.send('nav:page', 'settings')
      },
      hideIsland: () => void setIslandVisible(false),
      quit: () => {
        isQuitting = true
        app.quit()
      }
    })

    const settings = await settingsStore.init()
    activePresetId = settings.activePresetId
    timer = new Timer(timerConfigOf(settings))
    // 灵动岛上次被藏起来过 → 这次也不显示
    if (settings.islandVisible === false) island?.hide()

    // ---- 崩溃恢复（规格 E 组）----
    //
    // 总纲 E0：应用退出 = 暂停。关掉期间时间不前进，
    // 所以恢复出来的永远是"暂停态 + 退出那一刻的剩余"，不推算、不补记。
    runningState = makeRunningState(app.getPath('userData'), log)
    const snapshot = runningState.load()
    if (snapshot) {
      timer.restore(snapshot)
      log.info(
        `已恢复上次的状态：${snapshot.phase} 剩余 ${snapshot.remainingSec}s（暂停态，规格 E0）`
      )
      // E8：恢复成功后立刻把快照写回成"恢复后的状态"。
      // 等价于消费掉旧快照——下一次启动读到的是这一份，不会恢复到更早的段。
      writeSnapshot(true)
    } else {
      // 没有可恢复的：把可能残留的旧快照清掉
      runningState.clear()
    }

    // 音乐控制：默认关，开了才拉起 SMTC 子进程（v0.2.2）
    music = createMusicController((state) => {
      broadcast('media:state', state)
    })
    if (settings.showMusicControl) music.enable()

    // 状态变化 → 广播给所有窗口 + 刷新托盘
    timer.subscribe((state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('timer:state', state)
      }
      tray?.update(state)
      // 状态变了 → 安排落盘（规格 E4）
      schedulePersist()
    })

    // 心跳：每 30 秒落一次盘（规格 E4）。
    // 崩溃/断电时最多丢 30 秒的进度，而恢复时按"暂停"处理，不补那段时间。
    persistHeartbeat = setInterval(() => writeSnapshot(), 30_000)

    // 一个阶段跑完：落记录 + 强提醒
    timer.onPhaseComplete((info) => {
      void handlePhaseComplete(info)
    })

    tray = createTray(mainWindow!, {
      toggle: () => timer?.apply('toggle'),
      show: () => showWindow(),
      islandVisible: () => island?.isVisible() ?? false,
      toggleIsland: () => void setIslandVisible(!(island?.isVisible() ?? false)),
      quit: () => {
        isQuitting = true
        app.quit()
      }
    })

    ipcMain.handle('timer:get-state', () => timer?.getState())
    ipcMain.on('timer:action', (_e, action: TimerAction) => timer?.apply(action))
    // 当前这一段的任务名（灵动岛就地编辑）
    ipcMain.on('timer:set-task', (_e, text: string) => timer?.setTask(String(text ?? '')))

    ipcMain.handle('records:summary', () => buildSummary())
    ipcMain.on('records:submit', (_e, id: string, task: string, interrupt: InterruptKind) => {
      if (recordAutoClose) {
        clearTimeout(recordAutoClose)
        recordAutoClose = null
      }
      void jsonStore.updateSession(id, { task, interrupt }).then(async () => {
        await pushSummary()
        broadcast('record:close')
        reminder?.release(mainWindow!)
      })
    })

    ipcMain.handle('settings:get', () => settingsStore.get())

    /**
     * 保存设置。
     *
     * 走设置单例（v0.6 缺陷 D1）：所有写排队、合并的是内存里的当前值，
     * 所以两个不相干的设置同时保存不会再互相覆盖。
     *
     * 写盘前会校验：传进来一个坏值（比如 uiTheme: 123），
     * **磁盘一个字节都不变**，界面上给一条提示。
     */
    ipcMain.on('settings:save', (_e, patch: Partial<Settings>) => {
      // 改动前的值：用来判断"灵动岛/音乐/开机自启"这些要不要立刻生效
      const before = settingsStore.peek()
      void settingsStore
        .save(patch)
        .then(async (next) => {
          const current = before
          timer?.updateSettings(timerConfigOf(next))
          activePresetId = next.activePresetId
          // 设置里的「显示灵动岛」开关要立刻生效，不用重启
          if (patch.islandVisible !== undefined && patch.islandVisible !== current.islandVisible) {
            if (patch.islandVisible) island?.show()
            else island?.hide()
          }
          // 「显示音乐控制」同样立刻生效：开 = 拉起子进程，关 = 杀掉
          if (
            patch.showMusicControl !== undefined &&
            patch.showMusicControl !== current.showMusicControl
          ) {
            if (patch.showMusicControl) music?.enable()
            else music?.disable()
          }
          // 切模板/改时长后，所有窗口都要知道当前模板变了
          broadcast('settings:changed', next)
          // 换主题要立刻换窗口底色，不然换完还有一层旧底色透出来
          if (patch.uiTheme !== undefined || patch.uiMode !== undefined) {
            mainWindow?.setBackgroundColor(windowBgOf(next))
          }
          if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== current.launchAtLogin) {
            try {
              app.setLoginItemSettings({
                openAtLogin: next.launchAtLogin,
                path: process.execPath,
                args: app.isPackaged ? [] : [app.getAppPath()]
              })
              log.info(`开机自启已${next.launchAtLogin ? '开启' : '关闭'}`)
            } catch (err) {
              log.error(`设置开机自启失败: ${(err as Error).message}`)
              pushNotice('设置开机自启失败', 'warn')
            }
          }
        })
        .catch((err: Error) => {
          // 校验没过 / 写盘失败：磁盘保持原样，界面上给一句人话
          log.error(`保存设置失败：${err.message}`)
          pushNotice(`设置没保存：${err.message}`, 'warn')
        })
    })

    // 统计：今日按小时分布 / 近 7 天趋势 / 打断原因排行 / 主题维度
    ipcMain.handle('stats:get', async () => {
      const [sessions, settings] = await Promise.all([
        jsonStore.listSessions(),
        settingsStore.get()
      ])
      return buildStats(sessions, settings.topics)
    })

    // 快捷键：查看与改键（失败走同一条提示链路）
    ipcMain.handle('shortcuts:get', () => getShortcutLabels())
    ipcMain.handle('shortcuts:set', (_e, id: ShortcutId, accelerator: string) => {
      const res = replaceShortcut(id, accelerator)
      if (!res.ok) {
        log.error(`改键失败 ${id} → ${accelerator}: ${res.error ?? ''}`)
        pushNotice(res.error ?? '快捷键修改失败', 'warn')
      }
      return res
    })

    // CSV 导出（带 UTF-8 BOM，Excel 打开不乱码）
    ipcMain.handle('csv:export', async () => {
      const sessions = await jsonStore.listSessions()
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      // 开发期可以指定输出路径，跳过原生保存对话框（自动化验证用）
      const devOut = import.meta.env.DEV ? process.env['POMODORO_CSV_OUT'] : undefined
      if (devOut) {
        await exportCsv(devOut, sessions)
        log.info(`已导出记录到 ${devOut}`)
        return { ok: true, path: devOut }
      }
      const res = await dialog.showSaveDialog(mainWindow!, {
        title: '导出记录',
        defaultPath: path.join(app.getPath('documents'), `番茄钟记录-${stamp}.csv`),
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (res.canceled || !res.filePath) return { ok: false }
      await exportCsv(res.filePath, sessions)
      log.info(`已导出记录到 ${res.filePath}`)
      return { ok: true, path: res.filePath }
    })

    // 渲染层挂载后主动来取之前攒下的通知（推送早于界面订阅会丢，所以改成拉取式）
    ipcMain.handle('notice:take', () => pendingNotices.splice(0, pendingNotices.length))

    // 开发期：快速把计时器摆到指定阶段，用来验证阶段流转
    if (import.meta.env.DEV) {
      ipcMain.handle('timer:dev-seed', (_e, phase: PhaseCompleteInfo['phase'], elapsed: number) =>
        timer?.devSeed?.(phase, elapsed)
      )
      // 开发期：把"现在"往前推（毫秒），用来验证跨零点时界面会重算。
      // 真的等一个午夜不现实，测试要能自动化。
      ipcMain.handle('clock:dev-set', (_e, offsetMs: number) => {
        setClockOffset(Number(offsetMs) || 0)
        // 时钟变了，"下一个零点"也跟着变 → 重新安排跨点点的重算
        scheduleMidnightRefresh()
        return nowDate().toISOString()
      })
      // 开发期：正常退出（= app.quit，会走 before-quit 落盘）。
      // 用来自动化验证崩溃恢复（规格 E1）：托盘里的"退出"没法用脚本点。
      ipcMain.on('app:dev-quit', () => {
        isQuitting = true
        app.quit()
      })
    }

    ipcMain.on('window:minimize', () => mainWindow?.minimize())
    ipcMain.on('window:close', () => mainWindow?.hide())
    ipcMain.on('window:show', () => showWindow())

    // 灵动岛：收起/展开（改窗口大小后重新贴顶居中）、打开主窗口
    ipcMain.on('island:set-mode', (_e, mode: 'collapsed' | 'expanded', withMusic?: boolean) =>
      island?.setMode(mode, withMusic)
    )
    ipcMain.on('island:open-main', () => showWindow())
    // 就地编辑任务名之前，让浮层真的拿到键盘焦点（否则字符打到主窗口里）
    ipcMain.on('island:focus', () => {
      const win = island?.win
      if (!win || win.isDestroyed()) return
      win.focus()
      win.webContents.focus()
    })

    // 音乐控制（v0.2.2）：状态从 SMTC 子进程来，命令也是发给它
    ipcMain.handle('media:get-state', () => music?.getState() ?? null)
    ipcMain.on('media:command', (_e, cmd: MediaCommand) => music?.command(cmd))

    registerAllShortcuts()

    // 启动时把汇总推给界面（重启后底部状态行要能恢复）
    void pushSummary()

    // 安排跨零点的重算：程序开着一夜，明天早上"今天"要自己对上（v0.6 缺陷 D4）
    scheduleMidnightRefresh()

    if (import.meta.env.DEV) {
      setupScreenshot(mainWindow)
      if (island) setupIslandScreenshot(island.win)
      // 开发期预览：指定初始阶段与已过秒数，方便截不同状态的视觉稿
      const phase = process.env['POMODORO_PHASE'] as PhaseCompleteInfo['phase'] | undefined
      const elapsed = Number(process.env['POMODORO_ELAPSED'])
      if (phase || Number.isFinite(elapsed)) {
        timer?.devSeed?.(phase, Number.isFinite(elapsed) ? elapsed : 0)
      }
    }

    log.info('应用启动完成')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  app.on('before-quit', () => {
    isQuitting = true
    if (recordAutoClose) clearTimeout(recordAutoClose)
    if (midnightTimer) {
      clearTimeout(midnightTimer)
      midnightTimer = null
    }
    // 退出前落一次盘（规格 E1）。
    // force=true = 按"退出即暂停"记录（E0）：关掉期间时间不前进，
    // 重新打开就是暂停态，剩余 = 退出这一刻的剩余。
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (persistHeartbeat) {
      clearInterval(persistHeartbeat)
      persistHeartbeat = null
    }
    writeSnapshot(true)
    globalShortcut.unregisterAll()
    timer?.dispose()
    tray?.destroy()
    island?.destroy()
    music?.dispose()
  })}

