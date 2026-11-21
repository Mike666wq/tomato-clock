// 托盘：图标随阶段变化，菜单提供 开始/暂停 · 显示窗口 · 退出。
//
// 左键点击显示窗口，右键弹出菜单。关闭窗口不退出，只收进托盘。

import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import path from 'node:path'
import { PHASE_LABEL, type TimerState } from '../shared/types'
import { log } from './logger'

export interface TrayActions {
  toggle: () => void
  show: () => void
  quit: () => void
}

export interface TrayController {
  update: (state: TimerState) => void
  destroy: () => void
}

function iconFile(state: TimerState): string {
  if (!state.running) return 'tray-paused.png'
  return state.phase === 'focus' ? 'tray-focus.png' : 'tray-break.png'
}

export function createTray(win: BrowserWindow, actions: TrayActions): TrayController {
  const iconPath = (name: string): string => path.join(app.getAppPath(), 'resources', name)

  let tray: Tray
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath('tray-focus.png')))
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
      { type: 'separator' },
      { label: '退出', click: () => actions.quit() }
    ])
  }

  let last: TimerState = {
    phase: 'focus',
    running: false,
    totalSec: 0,
    remainingSec: 0,
    focusRounds: 0,
    completed: { focus: 0, short: 0, long: 0 }
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
