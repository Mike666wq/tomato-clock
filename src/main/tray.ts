// 托盘图标与菜单 —— 第 2 轮实现。
// 这里先留位置，保证目录结构与方案一致。

import type { BrowserWindow } from 'electron'

export interface TrayController {
  /** 根据当前阶段刷新托盘图标 */
  update(phaseLabel: string, running: boolean): void
  /** 显示主窗口 */
  show(win: BrowserWindow): void
}

export function createTray(_win: BrowserWindow): TrayController {
  // TODO(第 2 轮)：Tray + 菜单（开始/暂停/显示窗口/退出）
  return {
    update() {},
    show() {}
  }
}
