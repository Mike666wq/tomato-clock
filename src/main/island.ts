// 灵动岛：常驻在屏幕顶端中央的透明胶囊窗口。
//
// 它是独立窗口（不是主窗口的一部分），因此：
//   - 计时状态仍然只从主进程读，渲染层不自己算时间（和主窗口同一个状态机）
//   - 主窗口关掉收进托盘，不影响它
//   - 打包后与主窗口一起进 asar，入口是 out/renderer/island.html
//
// 形态按 docs/v0.2-灵动岛方案.md：
//   - 贴屏幕顶端 y=0，上边直角、下边圆角，像从屏幕边框里长出来
//   - 默认锁死顶部居中（自用场景越简单越不会出错）

import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { ISLAND, type IslandMode } from '../shared/island'
import { log } from './logger'

export type IslandController = {
  win: BrowserWindow
  show(): void
  hide(): void
  setMode(mode: IslandMode): void
  getMode(): IslandMode
  destroy(): void
}

/** 窗口宽度 = 胶囊宽度 + 左右余量 */
function windowWidth(mode: IslandMode): number {
  return (mode === 'expanded' ? ISLAND.expandedW : ISLAND.collapsedW) + ISLAND.sidePad * 2
}

/** 窗口高度 = 胶囊高度 + 底部余量 */
function windowHeight(mode: IslandMode): number {
  return (mode === 'expanded' ? ISLAND.expandedH : ISLAND.collapsedH) + ISLAND.bottomPad
}

/**
 * 贴主屏顶端居中。
 *
 * 用 workArea 而不是 bounds：workArea 已经排除了系统 UI（这台机器任务栏在左侧，
 * 会把可用区左边界推到 x=48），而且单位是 DIP，不用自己换算 150% 缩放。
 */
function placeTopCenter(win: BrowserWindow): void {
  const area = screen.getPrimaryDisplay().workArea
  const b = win.getBounds()
  const x = Math.round(area.x + (area.width - b.width) / 2)
  win.setPosition(x, area.y)
}

export function createIsland(): IslandController {
  let mode: IslandMode = 'collapsed'

  const win = new BrowserWindow({
    width: windowWidth(mode),
    height: windowHeight(mode),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // 自己的阴影由胶囊的 box-shadow 画，Windows 默认阴影会跟透明窗口打架
    hasShadow: false,
    // 不设 focusable: false —— 后面要在胶囊上输入任务名、点按钮
    focusable: true,
    show: false,
    // 透明窗口必须是全透明底色，否则窗口矩形会露出一块方形底
    backgroundColor: '#00000000',
    title: '灵动岛',
    webPreferences: {
      preload: path.join(__dirname, '../preload/island.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => {
    placeTopCenter(win)
    win.show()
  })

  // 胶囊常驻：关它只是隐藏，不能把应用带走
  win.on('close', (e) => {
    e.preventDefault()
    win.hide()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (import.meta.env.DEV && devUrl) {
    void win.loadURL(`${devUrl}/island.html`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/island.html'))
  }

  const setMode = (next: IslandMode): void => {
    mode = next
    win.setSize(windowWidth(mode), windowHeight(mode))
    placeTopCenter(win)
    log.info(`灵动岛切换到 ${mode}`)
  }

  return {
    win,
    show: () => win.show(),
    hide: () => win.hide(),
    setMode,
    getMode: () => mode,
    destroy: () => {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
