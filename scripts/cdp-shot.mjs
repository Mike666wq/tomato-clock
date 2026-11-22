// 开发期自动化截图：通过 DevTools 协议给某个窗口拍一张图。
//
// 用法：
//   $env:CDP_PORT='9222'          # 端口（开发期默认 9222）
//   $env:CDP_TARGET='island'      # main | island | 其它子串
//   $env:CDP_OUT='C:\path\x.png'  # 输出文件
//   $env:CDP_EVAL="表达式"          # 截图前先执行（可选）
//   $env:CDP_DELAY='1200'         # 执行后等多久再截（毫秒）
//   node scripts/cdp-shot.mjs
//
// 为什么不用 capturePage 的环境变量那条路：那条路拍完就退出应用，
// 一次只能拍一个窗口。这里可以连着拍好几个状态。

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const want = process.env.CDP_TARGET ?? 'main'
const out = process.env.CDP_OUT ?? 'shot.png'
const expr = process.env.CDP_EVAL ?? ''
const delay = Number(process.env.CDP_DELAY ?? '800')

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
    setTimeout(() => reject(new Error(`${method} timeout`)), 20000)
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
    : want === 'island'
      ? pages.filter((p) => pathOf(p).includes('island'))
      : pages.filter((p) => p.url.includes(want))
if (!picked.length) {
  console.log(`NO_TARGET(${want})`)
  process.exit(1)
}

const ws = await connect(picked[0].webSocketDebuggerUrl)
console.log(`# target: ${picked[0].url}`)

if (expr) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  })
  console.log(`# eval => ${JSON.stringify(r?.result?.value ?? r?.result?.description ?? null)}`)
}

if (delay > 0) await new Promise((r) => setTimeout(r, delay))

const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' })
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(`# saved ${out}`)

ws.close()
process.exit(0)
