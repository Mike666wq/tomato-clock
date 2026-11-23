// 量静态稿的真实布局（开发期工具，不参与打包）。
//
// 用法：
//   node_modules\.bin\electron scripts\mock-measure.mjs <html> [查询串] [画板高度]
//   例：... mock-a.html "screen=main,theme=dark" 500
//   第三个参数会把画板高度改成指定值，用来验"窗口再矮会不会压叠/裁切"。
//
// 打印每个关键区块的实际位置和尺寸，用来定位压叠/裁切/重心偏移。
// 注意：这台机器预置了 ELECTRON_RUN_AS_NODE=1，要先清掉。

import { app, BrowserWindow } from 'electron'
import path from 'node:path'

delete process.env.ELECTRON_RUN_AS_NODE

const [, , htmlArg, queryArg, frameHArg] = process.argv
if (!htmlArg) {
  console.error('用法：electron scripts/mock-measure.mjs <html> [查询串]')
  app.exit(1)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 520,
    height: 700,
    frame: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  try {
    const query = Object.fromEntries(
      (queryArg ?? '')
        .split(',')
        .filter(Boolean)
        .map((kv) => kv.split('='))
    )
    await win.loadFile(path.resolve(htmlArg), { query })
    await new Promise((r) => setTimeout(r, 700))
    const out = await win.webContents.executeJavaScript(`(() => {
      const frameH = ${JSON.stringify(frameHArg ?? null)}
      if (frameH) {
        document.querySelectorAll('.frame').forEach((f) => { f.style.height = frameH + 'px' })
      }
      const sels = ['.frame', '.top', '.ring-area', '.ring', '.ring svg', '.ring__track', '.controls', '.status', '.chips', '.nav']
      const rows = sels.map((s) => {
        const el = document.querySelector(s)
        if (!el) return s + ' = (不存在)'
        const r = el.getBoundingClientRect()
        return s.padEnd(14) + ' x=' + Math.round(r.x) + ' y=' + Math.round(r.y) +
          ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) +
          ' bottom=' + Math.round(r.bottom)
      })
      const frame = document.querySelector('.frame').getBoundingClientRect()
      const ring = document.querySelector('.ring').getBoundingClientRect()
      rows.push('---')
      rows.push('frame h=' + Math.round(frame.height))
      rows.push('环上下留白: 上=' + Math.round(ring.top - frame.top) +
                ' 下=' + Math.round(frame.bottom - ring.bottom))
      const area = document.querySelector('.ring-area').getBoundingClientRect()
      rows.push('ring-area h=' + Math.round(area.height) + ' (ring h=' + Math.round(ring.height) + ')')
      rows.push('环是否溢出容器: ' + (ring.bottom > area.bottom + 0.5 || ring.top < area.top - 0.5 ? '是（会被裁）' : '否'))
      const t = document.querySelector('.time')
      rows.push('time 文本=' + JSON.stringify(t.textContent) + ' rect=' + JSON.stringify(t.getBoundingClientRect().toJSON()))
      return rows.join('\\n')
    })()`)
    console.log(out)
  } catch (err) {
    console.error(`[mock-measure] failed: ${err.message}`)
  } finally {
    app.quit()
  }
})
