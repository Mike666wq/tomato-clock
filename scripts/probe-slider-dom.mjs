// 探针：打包版上点开滑条后，DOM 里到底还有什么（2026-11-24 下午）。
//
// 现象：measure-vol-real 在打包版上「拿不到滑条坐标」，
// 但前面那条「滑条是开着的」又 PASS 了 —— 说明两次查询之间状态变了。
// 这里把每一步的 DOM 都打出来，看是哪一步变的。

import { spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9226'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('island.html'))
if (!t) {
  console.log('NO_ISLAND_TARGET')
  process.exit(1)
}
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id
    const h = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id === mid) {
        ws.removeEventListener('message', h)
        resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
const evaluate = (expr) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })

const snapshot = async (tag) => {
  const r = await evaluate(`(() => ({
    expanded: !!document.querySelector('.island--expanded'),
    vol: !!document.querySelector('.island__vol'),
    track: !!document.querySelector('.island__vol-track'),
    music: !!document.querySelector('.island__music'),
    volClasses: [...document.querySelectorAll('[class*=vol]')].map(e => e.className)
  }))()`)
  console.log(`[${tag}] ${JSON.stringify(r)}`)
  return r
}

// 真机鼠标
const ps = spawn(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'scripts', 'real-mouse.ps1')],
  { stdio: ['pipe', 'pipe', 'pipe'] }
)
ps.stdout.setEncoding('utf-8')
let buf = ''
const waiters = []
ps.stdout.on('data', (chunk) => {
  buf += chunk
  let i = buf.indexOf('\n')
  while (i >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    i = buf.indexOf('\n')
    if (!line) continue
    const w = waiters.shift()
    if (w) w(line)
  }
})
const mouse = (cmd) =>
  new Promise((resolve) => {
    waiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })

await snapshot('起始')

// 打开音乐行
await evaluate(`window.island.settings.save({ showMusicControl: true }); true`)
await sleep(1200)

// 展开
const { execFileSync } = await import('node:child_process')
const raw = execFileSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'scripts', 'find-window-by-path.ps1'), '灵动岛', ''],
  { encoding: 'utf-8' }
).trim()
const m = /(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(raw)
console.log(`岛窗口 rect=${raw}`)
const b = m ? { x: +m[1], y: +m[2], w: +m[3] - +m[1], h: +m[4] - +m[2] } : null
console.log(`bounds=${JSON.stringify(b)}`)

for (let i = 0; i < 6; i++) {
  await mouse('move 5 5')
  await sleep(400)
  if (!b) break
  await mouse(`move ${Math.round(b.x + b.w / 2)} ${Math.round(b.y + 12)}`)
  await sleep(700)
  const s = await snapshot(`悬停第 ${i + 1} 次`)
  if (s.expanded) break
}

// 点音量按钮
const btn = await evaluate(`(() => {
  const el = [...document.querySelectorAll('.island__music-btn')].find(x => x.getAttribute('aria-label') === '音量')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
console.log(`音量按钮（视口坐标）=${JSON.stringify(btn)}`)
if (btn && b) {
  const sx = Math.round(b.x + btn.x)
  const sy = Math.round(b.y + btn.y)
  await mouse(`move ${sx} ${sy}`)
  await sleep(300)
  await mouse(`down ${sx} ${sy}`)
  await sleep(100)
  await mouse('up')
  await sleep(400)
  await snapshot('点完音量按钮后')
  await sleep(1500)
  await snapshot('再等 1.5 秒')
}

ps.kill()
