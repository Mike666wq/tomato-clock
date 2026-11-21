// 主进程入口：窗口、托盘、全局快捷键、计时核心、单实例锁。
//
// 一条不可动摇的架构约定（方案第八节）：计时状态归主进程持有，
// 窗口关掉（收进托盘）计时照样走，渲染层只读状态、发动作。

import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import path from 'node:path'
import { jsonStore } from './store/json-store'
import { setupScreenshot } from './screenshot'
import { Timer, type TimerAction } from './timer'
import { createTray, type TrayController } from './tray'
import { log } from './logger'
import { DEFAULT_SETTINGS, type PhaseKind } from '../shared/types'

// 必须与 src/renderer/styles/tokens.css 的 --bg 保持一致。
// 渲染层所有颜色只允许在 tokens.css 里出现，这里是唯一的例外（窗口底色，
// 避免无边框窗口在内容渲染前闪一下白）。改动时两处一起改。
const WINDOW_BG = '#0E1013'

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let timer: Timer | null = null
let isQuitting = false

function showWindow(): void {
  const win = mainWindow
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
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
    ['CommandOrControl+Alt+O', () => showWindow()]
  ]

  for (const [accelerator, handler] of bindings) {
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (ok) {
        log.info(`全局快捷键已注册: ${accelerator}`)
      } else {
        log.error(`全局快捷键注册失败（可能已被其他程序占用）: ${accelerator}`)
      }
    } catch (err) {
      log.error(`全局快捷键注册异常 ${accelerator}: ${(err as Error).message}`)
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

    const settings = await jsonStore.getSettings()
    timer = new Timer(settings)

    // 状态变化 → 广播给所有窗口 + 刷新托盘
    timer.subscribe((state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('timer:state', state)
      }
      tray?.update(state)
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

    // 开发期：快速摆到指定阶段，用来验证阶段流转
    if (import.meta.env.DEV) {
      ipcMain.handle('timer:dev-seed', (_e, phase: PhaseKind, elapsed: number) =>
        timer?.devSeed?.(phase, elapsed)
      )
    }

    ipcMain.on('window:minimize', () => mainWindow?.minimize())
    ipcMain.on('window:close', () => mainWindow?.hide())
    ipcMain.on('window:show', () => showWindow())

    registerShortcuts()

    if (import.meta.env.DEV) {
      setupScreenshot(mainWindow)
      // 开发期预览：指定初始阶段与已过秒数，方便截不同状态的视觉稿
      const phase = process.env['POMODORO_PHASE'] as PhaseKind | undefined
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
    globalShortcut.unregisterAll()
    timer?.dispose()
    tray?.destroy()
  })
}
