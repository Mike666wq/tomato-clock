// 主进程入口：窗口、托盘、全局快捷键、计时核心、结束强提醒、本地持久化、单实例锁。
//
// 一条不可动摇的架构约定（方案第八节）：计时状态归主进程持有，
// 窗口关掉（收进托盘）计时照样走，渲染层只读状态、发动作。

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { jsonStore } from './store/json-store'
import { setupScreenshot, setupIslandScreenshot } from './screenshot'
import { Timer, type TimerAction } from './timer'
import { createTray, type TrayController } from './tray'
import { createIsland, type IslandController } from './island'
import { createReminder, type ReminderController } from './reminder'
import { createMusicController, type MediaCommand, type MusicController } from './media'
import { getShortcutLabels, registerShortcuts, replaceShortcut, type ShortcutId } from './shortcuts'
import { buildStats } from './stats'
import { exportCsv } from './csv'
import { log } from './logger'
import {
  DEFAULT_SETTINGS,
  PHASE_LABEL,
  timerConfigOf,
  type InterruptKind,
  type Notice,
  type PhaseCompleteInfo,
  type RecordSummary,
  type Session,
  type Settings
} from '../shared/types'
import { formatAccelerator } from '../shared/format'

// 必须与 src/renderer/styles/tokens.css 的 --bg 保持一致。
// 渲染层所有颜色只允许在 tokens.css 里出现，这里是唯一的例外（窗口底色，
// 避免无边框窗口在内容渲染前闪一下白）。改动时两处一起改。
const WINDOW_BG = '#0E1013'

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
let isQuitting = false
let recordAutoClose: NodeJS.Timeout | null = null
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

/** 今天（本地日期）的 YYYY-MM-DD */
function todayKey(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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
    if (new Date(s.endedAt).toLocaleDateString('sv-SE') === today) {
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
  const current = await jsonStore.getSettings()
  await jsonStore.saveSettings({ ...current, islandVisible: visible })
  log.info(`灵动岛已${visible ? '显示' : '隐藏'}`)
}

/** 一个阶段自然跑完（或被跳过）：落记录 + 强提醒 + 打开记录卡片 */
async function handlePhaseComplete(info: PhaseCompleteInfo): Promise<void> {
  // 主题：只有专注段挂主题，休息段不挂（方案第四节）
  const settings = await jsonStore.getSettings()
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
    backgroundColor: WINDOW_BG,
    title: '番茄钟',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 恢复上次窗口位置（越界则摆回屏幕内）
  void jsonStore.getSettings().then((settings) => {
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

  // 记住窗口位置与大小
  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    const b = win.getBounds()
    void jsonStore.getSettings().then(async (settings) => {
      await jsonStore.saveSettings({ ...settings, window: { x: b.x, y: b.y, w: b.width, h: b.height } })
    })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)

  // 关闭窗口不退出，收进托盘（计时继续走）
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      saveBounds()
      win.hide()
    }
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 开发期开放 DevTools 协议端口，便于自动化验证 IPC 与界面状态
  if (import.meta.env.DEV) {
    app.commandLine.appendSwitch('remote-debugging-port', '9222')
  }

  app.on('second-instance', () => showWindow())

  void app.whenReady().then(async () => {
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

    const settings = await jsonStore.getSettings()
    timer = new Timer(timerConfigOf(settings))
    // 灵动岛上次被藏起来过 → 这次也不显示
    if (settings.islandVisible === false) island?.hide()

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
    })

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

    ipcMain.handle('settings:get', () => jsonStore.getSettings())

    // 保存设置。计时进行中改时长/切模板只影响下一段（Timer 内部处理），这里只落盘 + 通知计时器
    ipcMain.on('settings:save', (_e, patch: Partial<Settings>) => {
      void jsonStore.getSettings().then(async (current) => {
        const next: Settings = { ...current, ...patch }
        await jsonStore.saveSettings(next)
        timer?.updateSettings(timerConfigOf(next))
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
    })

    // 统计：今日按小时分布 / 近 7 天趋势 / 打断原因排行 / 主题维度
    ipcMain.handle('stats:get', async () => {
      const [sessions, settings] = await Promise.all([
        jsonStore.listSessions(),
        jsonStore.getSettings()
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
    globalShortcut.unregisterAll()
    timer?.dispose()
    tray?.destroy()
    island?.destroy()
    music?.dispose()
  })}

