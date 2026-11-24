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

import { BrowserWindow, Menu, screen } from 'electron'
import path from 'node:path'
import { ISLAND, type IslandMode } from '../shared/island'
import { log } from './logger'

/** 展开 / 收起的尺寸过渡时长（方案第四节：220ms，接近 iOS 灵动岛那条曲线） */
const SIZE_ANIM_MS = 220

export type IslandActions = {
  /** 打开主窗口（完整界面） */
  openMain: () => void
  /** 打开主窗口并停在设置页 */
  openSettings: () => void
  /** 隐藏灵动岛（托盘里能再叫回来） */
  hideIsland: () => void
  /** 退出应用 */
  quit: () => void
}

export type IslandController = {
  win: BrowserWindow
  show(): void
  hide(): void
  isVisible(): boolean
  setMode(mode: IslandMode, music?: boolean): void
  getMode(): IslandMode
  /** 开发期：横向挪开（避开用户自己那份的岛）。0 = 回到正中。 */
  setDevOffsetX(dx: number): void
  destroy(): void
}

/** 窗口宽度 = 胶囊宽度 + 左右余量（余量给阴影） */
function windowWidth(mode: IslandMode): number {
  return (mode === 'expanded' ? ISLAND.expandedW : ISLAND.collapsedW) + ISLAND.sidePad * 2
}

/**
 * 窗口高度 = 胶囊高度 + 底部余量（余量给阴影）。
 *
 * music 为真表示展开态下面还要多一行音乐控制（v0.2.2），
 * 那一行出现/消失时窗口高度要跟着变，否则胶囊会被截掉或者多出一块空白。
 */
function windowHeight(mode: IslandMode, music: boolean): number {
  const h = mode === 'expanded' ? (music ? ISLAND.expandedHMusic : ISLAND.expandedH) : ISLAND.collapsedH
  return h + ISLAND.bottomPad
}

/**
 * 贴主屏顶端居中。
 *
 * 用 workArea 而不是 bounds：workArea 已经排除了系统 UI（这台机器任务栏在左侧，
 * 会把可用区左边界推到 x=48），而且单位是 DIP，不用自己换算 150% 缩放。
 *
 * 展开/收起时窗口宽度会变，居中位置也跟着变，所以每次改尺寸都要重新算一遍，
 * 不能靠加固定偏移量。
 *
 * `offsetX` 只在开发期用（`island:dev-offset`）：机器上同时跑着用户自己装的那份，
 * 两个岛会**完全重叠**，真机鼠标分不清点的是哪个。把开发实例的岛横向挪开，
 * 既不挡用户那份，也不让鼠标点错窗口。
 */
function placeTopCenter(win: BrowserWindow, offsetX = 0): void {
  const area = screen.getPrimaryDisplay().workArea
  const b = win.getBounds()
  const x = Math.round(area.x + (area.width - b.width) / 2) + offsetX
  win.setPosition(x, area.y)
}

export function createIsland(actions: IslandActions): IslandController {
  let mode: IslandMode = 'collapsed'
  let music = false
  let animTimer: NodeJS.Timeout | null = null
  /** 开发期的横向偏移（DIP）；打包版里永远是 0 */
  let devOffsetX = 0

  const win = new BrowserWindow({
    width: windowWidth(mode),
    height: windowHeight(mode, music),
    frame: false,
    transparent: true,
    // 不能写 resizable:false：Windows 上那样连程序化 setSize 都会被吞掉，
    // 展开之后再也收不回去。frameless 窗口本来就没有可拖的边框，
    // 用户手动改尺寸这件事也就不存在。
    resizable: true,
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
    // 毛玻璃是"伪"的：透明窗口 + CSS 圆角 + 噪点/高光/内阴影四层。
    // 真亚克力（backgroundMaterial:'acrylic'）走过一遍，结论是不用：
    //   - 材质铺满整个窗口矩形，CSS 的 border-radius 裁不住它
    //   - setShape 只裁内容不裁材质
    //   - 想要真糊，形状只能交给 DWM 圆角：固定 8px、四角同圆、不可控，
    //     而且展开收起的尺寸动画会一跳一跳
    // 详见 docs/验证方法.md 第九节，别再重测一遍。
    backgroundMaterial: 'none',
    // 圆角交给 CSS 画，DWM 不要插手（否则透明窗口的四角会被系统切掉）
    roundedCorners: false,
    title: '灵动岛',
    webPreferences: {
      preload: path.join(__dirname, '../preload/island.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => {
    placeTopCenter(win, devOffsetX)
    win.show()
  })

  // 胶囊常驻：关它只是隐藏，不能把应用带走
  win.on('close', (e) => {
    e.preventDefault()
    win.hide()
  })

  // 用户不能拖边缘改大小（会把胶囊拉变形）。
  // 注意：不能靠 resizable:false —— Windows 上那样连程序化 setSize 都禁用，
  // 展开之后就再也收不回去。所以保持 resizable:true，在这里拦掉用户的手动改尺寸。
  win.on('will-resize', (e) => {
    e.preventDefault()
  })

  // 右键菜单：打开主界面 / 隐藏灵动岛 / 退出
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: '打开主界面', click: () => actions.openMain() },
      { label: '设置', click: () => actions.openSettings() },
      { label: '隐藏灵动岛', click: () => actions.hideIsland() },
      { type: 'separator' },
      { label: '退出', click: () => actions.quit() }
    ]).popup({ window: win })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (import.meta.env.DEV && devUrl) {
    void win.loadURL(`${devUrl}/island.html`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/island.html'))
  }

  const setMode = (next: IslandMode, withMusic?: boolean): void => {
    mode = next
    if (typeof withMusic === 'boolean') music = withMusic
    animateSize(windowWidth(mode), windowHeight(mode, music))
    log.info(`灵动岛切换到 ${next}${music ? '（带音乐行）' : ''}`)
  }

  /**
   * 展开 / 收起的尺寸过渡。
   *
   * 窗口尺寸变了必须重新贴顶居中（宽度变了，居中位置也变），
   * 所以每一步都重新算位置。
   */
  const animateSize = (targetW: number, targetH: number): void => {
    if (animTimer) clearInterval(animTimer)
    const b = win.getBounds()
    const startW = b.width
    const startH = b.height
    if (startW === targetW && startH === targetH) return

    const t0 = Date.now()
    animTimer = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / SIZE_ANIM_MS)
      const e = 1 - Math.pow(1 - p, 3) // ease-out cubic，接近 iOS 那条曲线
      win.setSize(
        Math.round(startW + (targetW - startW) * e),
        Math.round(startH + (targetH - startH) * e)
      )
      placeTopCenter(win, devOffsetX)
      if (p >= 1) {
        if (animTimer) clearInterval(animTimer)
        animTimer = null
        log.info(`灵动岛尺寸动画结束: ${JSON.stringify(win.getBounds())}`)
      }
    }, 16)
  }

  return {
    win,
    show: () => {
      if (!win.isVisible()) win.show()
    },
    hide: () => win.hide(),
    isVisible: () => win.isVisible(),
    setMode,
    getMode: () => mode,
    setDevOffsetX: (dx: number) => {
      devOffsetX = Number.isFinite(dx) ? Math.round(dx) : 0
      placeTopCenter(win, devOffsetX)
    },
    destroy: () => {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
