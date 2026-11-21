// 结束强提醒：窗口置顶 + 切到前台 + 系统通知。
//
// 声音和边框闪烁由渲染层做（渲染层收到 'reminder:fire' 后播放 wav 并加闪烁动画），
// 这里只负责窗口层面的"你不可能错过"。
//
// 为什么不依赖系统提示音：Windows 专注助手会把它们吞掉，
// 这是调研里"提醒形同虚设"的根源，所以声音自己带 wav。

import { app, Notification, type BrowserWindow } from 'electron'
import { log } from './logger'

export interface ReminderOptions {
  title: string
  body: string
}

export interface ReminderController {
  /** 置顶 + 拉起窗口 + 发系统通知 */
  fire(win: BrowserWindow, options: ReminderOptions): void
  /** 取消置顶（记录卡片关闭时调用） */
  release(win: BrowserWindow): void
}

export function createReminder(): ReminderController {
  return {
    fire(win, options) {
      if (!win.isDestroyed()) {
        try {
          win.setAlwaysOnTop(true, 'screen-saver')
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        } catch (err) {
          log.error(`提醒时拉起窗口失败: ${(err as Error).message}`)
        }
      }

      try {
        if (Notification.isSupported()) {
          new Notification({ title: options.title, body: options.body }).show()
        } else {
          log.warn('系统不支持通知，只用了窗口置顶')
        }
      } catch (err) {
        log.error(`发送系统通知失败: ${(err as Error).message}`)
      }
    },

    release(win) {
      if (win.isDestroyed()) return
      try {
        win.setAlwaysOnTop(false)
      } catch {
        /* 忽略 */
      }
    }
  }
}

export { app }
