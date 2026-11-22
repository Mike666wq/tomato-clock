// 开发期自动化验证：通过 DevTools 协议驱动渲染层，检查 IPC 通路与计时状态。
// 用法：node scripts/cdp-check.mjs ["要执行的表达式"]

const port = process.env.CDP_PORT ?? '9222'

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

function evaluate(ws, expression, awaitPromise = true) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result?.result?.value ?? msg.result?.result?.description ?? null)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise, returnByValue: true }
      })
    )
    setTimeout(() => reject(new Error('evaluate timeout')), 15000)
  })
}

const exprs = process.argv.slice(2)
const list = exprs.length
  ? exprs
  : [
      'typeof window.pomodoro',
      'window.pomodoro.timer.getState()',
      "document.querySelector('.ring__time')?.textContent",
      "document.querySelector('.ring__hint')?.textContent"
    ]

// 开发模式渲染页是 http://localhost:5173/，安装版是 file:// 下的 index.html
// CDP_TARGET 可以指定挑哪个页面：'main'（主窗口）/ 'island'（灵动岛），其余按子串匹配
const want = process.env.CDP_TARGET ?? ''
const pages = (await targets()).filter(
  (t) =>
    t.type === 'page' &&
    (t.url.includes('5173') || t.url.includes('index.html') || t.url.includes('island.html'))
)
const pathOf = (t) => {
  try {
    return new URL(t.url).pathname
  } catch {
    return t.url
  }
}
const picked = want
  ? want === 'main'
    ? pages.filter((p) => pathOf(p) === '/' || pathOf(p).endsWith('index.html'))
    : want === 'island'
      ? pages.filter((p) => pathOf(p).includes('island'))
      : pages.filter((p) => p.url.includes(want))
  : pages
if (!picked.length) {
  console.log(want ? `NO_TARGET(${want})` : 'NO_PAGE_TARGET')
  process.exit(1)
}

const ws = await connect(picked[0].webSocketDebuggerUrl)
console.log(`# target: ${picked[0].url}`)
for (const e of list) {
  try {
    const v = await evaluate(ws, e)
    console.log(`${e}\n  => ${JSON.stringify(v)}`)
  } catch (err) {
    console.log(`${e}\n  !! ${err.message}`)
  }
}
ws.close()
process.exit(0)
