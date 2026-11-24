// 探针：SetCursorPos 到底吃哪一套坐标？
//
// 这台机器 150% 缩放，同一个位置有两套数：
//   - DIP（虚拟化坐标）：Electron 的 getBounds() / DOM rect / PowerShell 的
//     GetWindowRect、WindowFromPoint 都是这一套
//   - 物理像素：屏幕真实像素
//
// 之前我按「SetCursorPos 要物理像素」把坐标乘了 1.5，鼠标落在别处，
// 岛收不到 hover。这个探针两种换算都试一遍，看哪一种能真的让岛展开。
//
// 用法：node scripts\probe-cursor-scale.mjs

import { spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
function mouse(cmd) {
  return new Promise((resolve) => {
    waiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`)
  return res.json()
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error(String(e.message ?? 'ws error')))
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
function evaluate(ws, expression) {
  return send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then(
    (r) => r?.result?.value ?? null
  )
}

const pages = (await targets()).filter((t) => t.type === 'page')
const islandT = pages.find((t) => {
  try {
    return new URL(t.url).pathname.endsWith('island.html')
  } catch {
    return false
  }
})
if (!islandT) {
  console.log('NO_ISLAND_TARGET')
  process.exit(1)
}
const island = await connect(islandT.webSocketDebuggerUrl)

const bounds = await evaluate(island, `window.island?.island?.devBounds?.() ?? null`)
const dpr = Number(await evaluate(island, `window.devicePixelRatio`)) || 1
console.log(`岛窗口（DIP）=${JSON.stringify(bounds)}  dpr=${dpr}`)

// 目标点：岛的水平中心 + 一点垂直位置（DIP）
const target = { x: bounds.x + bounds.width / 2, y: 12 }
console.log(`目标点（DIP）= ${target.x.toFixed(0)},${target.y.toFixed(0)}`)

async function tryHover(label, x, y) {
  // 先挪开：Windows 会合并鼠标移动消息，光标本来就在那儿可能不产生移动事件
  await mouse('move 5 5')
  await sleep(250)
  await mouse(`move ${x} ${y}`)
  await sleep(900)
  const expanded = await evaluate(island, `!!document.querySelector('.island--expanded')`)
  const hovered = await evaluate(island, `!!document.querySelector('.island:hover')`)
  console.log(`  ${label} → 传给 SetCursorPos (${x},${y})  展开=${expanded} hover=${hovered}`)
  return expanded
}

const a = await tryHover('按 DIP 直接传   ', Math.round(target.x), Math.round(target.y))
const b = await tryHover('按物理像素传(×1.5)', Math.round(target.x * dpr), Math.round(target.y * dpr))

console.log(`\n结论：DIP 直传 ${a ? '有效' : '无效'}；物理像素 ${b ? '有效' : '无效'}`)
ps.kill()
process.exit(0)
