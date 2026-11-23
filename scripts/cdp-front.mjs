// 开发期工具：把某个窗口挪到指定位置并置前（截图前用）。
//
// 用法：
//   $env:CDP_PORT='9222'
//   $env:CDP_TARGET='main'
//   $env:CDP_BOUNDS='120,90,482,585'   # x,y,width,height
//   node scripts/cdp-front.mjs
//
// 为什么需要：真机截图用 GDI 抓桌面最终合成结果，窗口必须在前面、
// 还得躲开别的窗口（比如用户自己开着的正式版）。

const port = process.env.CDP_PORT ?? '9222'
const want = process.env.CDP_TARGET ?? 'main'
const bounds = process.env.CDP_BOUNDS ?? ''

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`)
  return res.json()
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? 'unknown'}`))
  })
}

function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => reject(new Error(`${method} timeout`)), 15000)
  })
}

const pages = (await targets()).filter((t) => t.type === 'page')
const pathOf = (t) => {
  try {
    return new URL(t.url).pathname
  } catch {
    return t.url
  }
}
const picked =
  want === 'main'
    ? pages.filter((p) => pathOf(p) === '/' || pathOf(p).endsWith('index.html'))
    : pages.filter((p) => p.url.includes(want))
if (!picked.length) {
  console.log(`NO_TARGET(${want})`)
  process.exit(1)
}

const ws = await connect(picked[0].webSocketDebuggerUrl)

// 置前：GDI 抓的是屏幕最终合成结果，窗口不在前面就拍不到它
await send(ws, 'Page.bringToFront', {}).catch(() => {})

if (bounds) {
  const [x, y, width, height] = bounds.split(',').map((n) => Number(n))
  const { windowId } = await send(ws, 'Browser.getWindowForTarget', {
    targetId: picked[0].id
  })
  await send(ws, 'Browser.setWindowBounds', {
    windowId,
    bounds: { left: x, top: y, width, height, windowState: 'normal' }
  })
  console.log(`# moved to ${bounds}`)
}

await new Promise((r) => setTimeout(r, 600))
console.log('# front ok')
ws.close()
process.exit(0)
