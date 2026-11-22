// 托盘：图标随阶段变化，菜单提供 开始/暂停 · 显示窗口 · 退出。
//
// 左键点击显示窗口，右键弹出菜单。关闭窗口不退出，只收进托盘。

import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { PHASE_LABEL, type TimerState } from '../shared/types'
import { log } from './logger'

export interface TrayActions {
  toggle: () => void
  show: () => void
  /** 灵动岛当前是否显示（决定菜单里写"隐藏"还是"显示"） */
  islandVisible: () => boolean
  /** 显示 / 隐藏灵动岛 */
  toggleIsland: () => void
  quit: () => void
}

export interface TrayController {
  update: (state: TimerState) => void
  destroy: () => void
}

/**
 * 托盘图标路径。开发时在项目 resources/，打包后有两种可能：
 *   1) 被打进 app.asar → app.getAppPath()/resources
 *   2) 作为 extraResources 放在 resources/ 目录 → process.resourcesPath/resources
 * 两个都找一遍，找不到就用第一个（读不到会记日志，不静默）。
 */
function resolveIconPath(name: string): string {
  const candidates = [
    path.join(app.getAppPath(), 'resources', name),
    path.join(process.resourcesPath, 'resources', name),
    path.join(app.getAppPath(), '..', 'resources', name)
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  log.error(`找不到托盘图标: ${name}（已尝试 ${candidates.length} 个路径）`)
  return candidates[0]
}

function iconFile(state: TimerState): string {
  if (!state.running) return 'tray-paused-32.png'
  return state.phase === 'focus' ? 'tray-focus-32.png' : 'tray-break-32.png'
}

export function createTray(win: BrowserWindow, actions: TrayActions): TrayController {
  const iconPath = (name: string): string => resolveIconPath(name)

  let tray: Tray
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath('tray-focus-32.png')))
  } catch (err) {
    log.error(`创建托盘失败: ${(err as Error).message}`)
    return { update: () => {}, destroy: () => {} }
  }

  const buildMenu = (state: TimerState): Electron.Menu => {
    const phaseLabel = PHASE_LABEL[state.phase]
    const left = Math.floor(state.remainingSec / 60)
    const right = state.remainingSec % 60
    const clock = `${String(left).padStart(2, '0')}:${String(right).padStart(2, '0')}`

    return Menu.buildFromTemplate([
      {
        label: state.running ? '暂停' : '开始',
        click: () => actions.toggle()
      },
      { label: `${phaseLabel} · ${clock}`, enabled: false },
      { type: 'separator' },
      { label: '显示窗口', click: () => actions.show() },
      {
        label: actions.islandVisible() ? '隐藏灵动岛' : '显示灵动岛',
        click: () => actions.toggleIsland()
      },
      { type: 'separator' },
      { label: '退出', click: () => actions.quit() }
    ])
  }

  let last: TimerState = {
    phase: 'focus',
    running: false,
    totalSec: 0,
    remainingSec: 0,
    activeSec: 0,
    focusRounds: 0,
    completed: { focus: 0, short: 0, long: 0 },
    topicId: null,
    activeTopicId: null
  }

  const refresh = (): void => {
    try {
      tray.setImage(nativeImage.createFromPath(iconPath(iconFile(last))))
      tray.setToolTip(`番茄钟 · ${PHASE_LABEL[last.phase]}${last.running ? '' : '（已暂停）'}`)
    } catch (err) {
      log.error(`刷新托盘图标失败: ${(err as Error).message}`)
    }
  }

  refresh()

  tray.on('click', () => actions.show())
  tray.on('right-click', () => {
    tray.popUpContextMenu(buildMenu(last))
  })
  // 保留左键菜单兼容：部分环境不触发 click
  tray.on('double-click', () => actions.show())

  void win

  return {
    update(state) {
      last = state
      refresh()
    },
    destroy() {
      try {
        tray.destroy()
      } catch {
        /* 忽略销毁异常 */
      }
    }
  }
}
