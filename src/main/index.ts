// 主进程入口：窗口、托盘、全局快捷键、计时核心、结束强提醒、本地持久化、单实例锁。
//
// 一条不可动摇的架构约定（方案第八节）：计时状态归主进程持有，
// 窗口关掉（收进托盘）计时照样走，渲染层只读状态、发动作。

import { app, BrowserWindow, globalShortcut, ipcMain, Notification, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { jsonStore } from './store/json-store'
import { setupScreenshot } from './screenshot'
import { Timer, type TimerAction } from './timer'
import { createTray, type TrayController } from './tray'
import { createReminder, type ReminderController } from './reminder'
import { log } from './logger'
import {
  DEFAULT_SETTINGS,
  PHASE_LABEL,
  type InterruptKind,
  type Notice,
  type PhaseCompleteInfo,
  type RecordSummary,
  type Session
} from '../shared/types'

// 必须与 src/renderer/styles/tokens.css 的 --bg 保持一致。
// 渲染层所有颜色只允许在 tokens.css 里出现，这里是唯一的例外（窗口底色，
// 避免无边框窗口在内容渲染前闪一下白）。改动时两处一起改。
const WINDOW_BG = '#0E1013'

/** 记录卡片等不到人回应就自动落记录的时限 */
const RECORD_AUTO_CLOSE_MS = 60_000

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let timer: Timer | null = null
let reminder: ReminderController | null = null
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

/** 一个阶段自然跑完：落记录 + 强提醒 + 打开记录卡片 */
async function handlePhaseComplete(info: PhaseCompleteInfo): Promise<void> {
  const session: Session = {
    id: randomUUID(),
    kind: info.phase,
    startedAt: info.startedAt,
    endedAt: info.endedAt,
    plannedSec: info.plannedSec,
    actualSec: info.actualSec,
    pausedSec: info.pausedSec,
    completed: true,
    task: '',
    interrupt: 'none'
  }

  // 先落盘：用户不回应也不能丢数据
  await jsonStore.addSession(session)
  await pushSummary()

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
    minWidth: 420,
    minHeight: 520,
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
    if (w.w && w.h) win.setSize(Math.max(w.w, 420), Math.max(w.h, 520))
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
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerShortcuts(): void {
  const bindings: Array<[string, () => void]> = [
    ['CommandOrControl+Alt+Space', () => timer?.apply('toggle')],
    ['CommandOrControl+Alt+P', () => showWindow()]
  ]

  for (const [accelerator, handler] of bindings) {
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (ok) {
        log.info(`全局快捷键已注册: ${accelerator}`)
      } else {
        log.error(`全局快捷键注册失败（可能已被其他程序占用）: ${accelerator}`)
        // 光写日志用户看不见，要推到界面上
        pushNotice(`快捷键 ${accelerator} 注册失败，可能被其他程序占用`, 'warn')
      }
    } catch (err) {
      log.error(`全局快捷键注册异常 ${accelerator}: ${(err as Error).message}`)
      pushNotice(`快捷键 ${accelerator} 注册异常`, 'warn')
    }
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

    const settings = await jsonStore.getSettings()
    timer = new Timer(settings)

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
      quit: () => {
        isQuitting = true
        app.quit()
      }
    })

    ipcMain.handle('timer:get-state', () => timer?.getState())
    ipcMain.on('timer:action', (_e, action: TimerAction) => timer?.apply(action))

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

    registerShortcuts()

    // 启动时把汇总推给界面（重启后底部状态行要能恢复）
    void pushSummary()

    if (import.meta.env.DEV) {
      setupScreenshot(mainWindow)
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
  })
}

export { Notification }
