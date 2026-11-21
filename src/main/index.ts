// 主进程入口：窗口、拖拽区、窗口位置记忆、单实例锁。
//
// 第 1 轮只做：窗口能开、能拖、能记住位置、主界面能显示。
// 计时状态归主进程持有这件事从第一行代码就定死了（方案第八节风险表），
// 所以主进程里预留了 timer 状态的位置，第 2 轮填。

import { app, BrowserWindow, ipcMain, screen } from 'electron'
import path from 'node:path'
import { jsonStore } from './store/json-store'
import { setupScreenshot } from './screenshot'
import { DEFAULT_SETTINGS } from '../shared/types'

// 必须与 src/renderer/styles/tokens.css 的 --bg 保持一致。
// 渲染层所有颜色只允许在 tokens.css 里出现，这里是唯一的例外（窗口底色，
// 避免无边框窗口在内容渲染前闪一下白）。改动时两处一起改。
const WINDOW_BG = '#0E1013'

let mainWindow: BrowserWindow | null = null

/** 计时状态 —— 主进程持有，窗口关掉也继续走（第 2 轮实现） */
const timerState = {
  phase: 'focus' as const,
  running: false,
  /** 阶段结束的时间戳（ms），null 表示未在计时 */
  endsAt: null as number | null,
  /** 已完成的专注轮数 */
  focusRounds: 0
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

  // 恢复上次窗口位置（越界则交给系统摆回屏幕内）
  void jsonStore.getSettings().then((settings) => {
    const w = settings.window ?? DEFAULT_SETTINGS.window
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    const x = typeof w.x === 'number' ? Math.min(Math.max(w.x, area.x), area.x + area.width - 100) : undefined
    const y = typeof w.y === 'number' ? Math.min(Math.max(w.y, area.y), area.y + area.height - 100) : undefined
    if (x !== undefined && y !== undefined) win.setPosition(x, y)
    if (w.w && w.h) win.setSize(Math.max(w.w, 420), Math.max(w.h, 520))
  })

  win.once('ready-to-show', () => win.show())

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
  win.on('close', saveBounds)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    // 开发期支持 ?phase=short 预览休息态色调、?elapsed=600 预览有弧度的进度
    const q: string[] = []
    const phase = process.env['POMODORO_PHASE']
    const elapsed = process.env['POMODORO_ELAPSED']
    if (phase) q.push(`phase=${phase}`)
    if (elapsed) q.push(`elapsed=${elapsed}`)
    void win.loadURL(q.length ? `${devUrl}?${q.join('&')}` : devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    mainWindow = createWindow()
    setupScreenshot(mainWindow)

    ipcMain.on('window:minimize', () => mainWindow?.minimize())
    ipcMain.on('window:close', () => mainWindow?.close())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  // 第 1 轮：直接退出。第 2 轮接上托盘后改成"关窗口不退出，只留托盘"。
  app.on('window-all-closed', () => app.quit())
}

export { timerState }
