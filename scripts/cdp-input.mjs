// 开发期工具：在某个窗口里点一下（可指定连点几次），用来验交互。
//
// 用法：
//   $env:CDP_PORT='9222'
//   $env:CDP_TARGET='main'
//   $env:CDP_CLICK='120,16'      # 视口坐标（CSS 像素）
//   $env:CDP_CLICK_COUNT='2'     # 连点几次（2 = 双击）
//   node scripts/cdp-input.mjs
//
// 为什么需要：无边框窗口的拖拽区（-webkit-app-region: drag）会不会把双击
// 事件送给页面，只能实测——这决定了"双击标题栏最大化"能不能在渲染层实现。

const port = process.env.CDP_PORT ?? '9222'
const want = process.env.CDP_TARGET ?? 'main'
const click = process.env.CDP_CLICK ?? '0,0'
const count = Number(process.env.CDP_CLICK_COUNT ?? '1')

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
const [x, y] = click.split(',').map(Number)

for (let i = 1; i <= count; i++) {
  await send(ws, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: i,
    buttons: 1
  })
  await send(ws, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: i,
    buttons: 0
  })
  await new Promise((r) => setTimeout(r, 40))
}

console.log(`# clicked ${click} x${count}`)
ws.close()
process.exit(0)
