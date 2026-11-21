// 开发辅助：视觉稿截图。
//
// 用法（仅开发模式）：
//   $env:POMODORO_SHOT = 'C:\path\to\shot.png'
//   pnpm dev
// 窗口渲染完成后自动截图并退出，用 Electron 自己的 capturePage()，
// 尺寸与设备缩放都准，不会出现 PrintWindow 按 DPI 放大后被裁切的问题。
//
// 整段被 import.meta.env.DEV 包住：打包产物里不会留下任何入口。

import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export function setupScreenshot(win: BrowserWindow): void {
  if (!import.meta.env.DEV) return

  const target = process.env['POMODORO_SHOT']
  if (!target) return

  const shoot = async (): Promise<void> => {
    try {
      // 等首帧渲染完再截，否则可能拍到空白
      await new Promise((r) => setTimeout(r, 1500))
      const image = await win.webContents.capturePage()
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, image.toPNG())
      console.log(`[screenshot] saved ${target}`)
    } finally {
      app.quit()
    }
  }

  win.webContents.once('did-finish-load', () => void shoot())
}
