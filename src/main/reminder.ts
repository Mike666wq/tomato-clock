// 结束强提醒：置顶窗 + 声音 + 闪烁 —— 第 3 轮实现。
// 这里先留位置，保证目录结构与方案一致。

export interface ReminderOptions {
  title: string
  body: string
  /** 闪烁次数 */
  flashes?: number
}

export interface ReminderController {
  fire(win: import('electron').BrowserWindow, options: ReminderOptions): void
}

export function createReminder(): ReminderController {
  // TODO(第 3 轮)：alwaysOnTop + 播放 wav + 窗口边框呼吸 3 次
  return {
    fire() {}
  }
}
