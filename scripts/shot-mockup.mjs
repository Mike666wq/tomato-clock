// 给 UI 静态稿拍照（开发期工具，不参与打包）。
//
// 用法：
//   node_modules\.bin\electron scripts\shot-mockup.mjs <html> <out.png> [宽] [高] [查询串]
//   例：... mock-a.html out.png 560 700 "screen=main,theme=dark"
//   （查询串用逗号分隔：& 在 .cmd 里会被 cmd 拆开）
//
// 为什么用 electron 而不是浏览器：项目里已经装了它，不用再引 puppeteer/playwright；
// capturePage 出来的图尺寸与 DPI 都准，不会像 PrintWindow 那样按 DPI 放大后被裁掉。
//
// 注意：这台机器的环境里预置了 ELECTRON_RUN_AS_NODE=1，要先清掉，
// 否则 electron 会退化成纯 Node，报 "bad option"。

import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

delete process.env.ELECTRON_RUN_AS_NODE

const [, , htmlArg, outArg, wArg, hArg, queryArg] = process.argv
if (!htmlArg || !outArg) {
  console.error('用法：electron scripts/shot-mockup.mjs <html> <out.png> [宽] [高]')
  app.exit(1)
}
const width = Number(wArg ?? 520)
const height = Number(hArg ?? 700)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    frame: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: false
    }
  })
  try {
    const query = Object.fromEntries(
      (queryArg ?? '')
        .split(',')
        .filter(Boolean)
        .map((kv) => kv.split('='))
    )
    await win.loadFile(path.resolve(htmlArg), { query })
    // 等字体和布局稳下来
    await new Promise((r) => setTimeout(r, 900))
    const image = await win.webContents.capturePage()
    mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true })
    writeFileSync(path.resolve(outArg), image.toPNG())
    console.log(`[shot-mockup] saved ${outArg}`)
  } catch (err) {
    console.error(`[shot-mockup] failed: ${err.message}`)
  } finally {
    app.quit()
  }
})
