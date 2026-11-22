// 开发辅助：视觉稿截图。
//
// 用法（仅开发模式）：
//   $env:POMODORO_SHOT = 'C:\path\to\shot.png'
//   pnpm dev
// 窗口渲染完成后自动截图并退出，用 Electron 自己的 capturePage()，
// 尺寸与设备缩放都准，不会出现 PrintWindow 按 DPI 放大后被裁切的问题。
//
// 整段被 import.meta.env.DEV 包住：打包产物里不会留下任何入口。

import { app, BrowserWindow, desktopCapturer, screen } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export function setupScreenshot(win: BrowserWindow): void {
  if (!import.meta.env.DEV) return

  const target = process.env['POMODORO_SHOT']
  if (!target) return

  const shoot = async (): Promise<void> => {
    try {
      // 等首帧渲染完再截，否则可能拍到空白
      await new Promise((r) => setTimeout(r, 3000))
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

/**
 * 开发辅助：灵动岛的视觉稿截图。
 *
 * 用法（仅开发模式）：
 *   $env:POMODORO_ISLAND_SHOT = 'C:\path\to\island.png'
 *   pnpm dev
 *
 * 灵动岛是透明窗口，capturePage 只能拍到它自己（四周是透明的），
 * 看不出"贴在屏幕顶端"的现场感。所以这里用 desktopCapturer 抓整块屏，
 * 再按灵动岛窗口的位置裁一块出来 —— 那是用户真实看到的样子。
 */
export function setupIslandScreenshot(win: BrowserWindow): void {
  if (!import.meta.env.DEV) return

  const target = process.env['POMODORO_ISLAND_SHOT']
  if (!target) return

  win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        // 等首帧渲染完再截，否则拍到的是空胶囊
        await new Promise((r) => setTimeout(r, 3000))

        const display = screen.getDisplayMatching(win.getBounds())
        const scale = display.scaleFactor
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: Math.round(display.bounds.width * scale),
            height: Math.round(display.bounds.height * scale)
          }
        })
        const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
        if (!src) throw new Error('没有抓到屏幕源')

        const b = win.getBounds()
        // 裁一块比胶囊大一圈的桌面，好看清"它悬在屏幕顶端"这件事
        const padX = 140
        const padBottom = 190
        const rect = {
          x: Math.max(0, Math.round((b.x - display.bounds.x) * scale) - padX),
          y: Math.max(0, Math.round((b.y - display.bounds.y) * scale)),
          width: Math.round(b.width * scale) + padX * 2,
          height: Math.round(b.height * scale) + padBottom
        }
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, src.thumbnail.crop(rect).toPNG())
        console.log(`[screenshot] island saved ${target}`)

        // 再存一张窗口自身的透明 PNG，方便看胶囊本体的圆角与描边
        const own = await win.webContents.capturePage()
        await fs.writeFile(target.replace(/\.png$/i, '-win.png'), own.toPNG())
        console.log(`[screenshot] island window saved ${target.replace(/\.png$/i, '-win.png')}`)
      } catch (err) {
        console.error(`[screenshot] island failed: ${(err as Error).message}`)
      } finally {
        app.quit()
      }
    })()
  })
}
