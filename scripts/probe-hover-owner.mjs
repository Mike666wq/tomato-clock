// 诊断：鼠标移到某个 DIP 坐标后，那个点上到底是哪个窗口？
//
// 为什么要单独查：point-owner.ps1 和 real-mouse.ps1 是**两个独立的 pwsh 进程**，
// 它们的 DPI 感知状态可能不一样 —— 于是「点一下说是这个窗口」和
// 「鼠标实际移到那儿」用的可能是两套坐标。
//
// 办法：**在同一个进程里**既移鼠标又查窗口（同一个进程 = 同一套 DPI 感知）。
//
// 用法：node scripts\probe-hover-owner.mjs

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = process.cwd()
const ps1 = path.join(root, 'scripts', 'hover-owner.ps1')
const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
  stdio: ['pipe', 'pipe', 'pipe']
})
ps.stdout.setEncoding('utf-8')
let buf = ''
const waiters = []
ps.stdout.on('data', (c) => {
  buf += c
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
ps.stderr.on('data', (c) => console.log(`  [stderr] ${c.trim()}`))

const cmd = (c) =>
  new Promise((resolve) => {
    waiters.push(resolve)
    ps.stdin.write(`${c}\n`)
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) 岛的位置（从 CDP 拿，DIP）
const port = process.env.CDP_PORT ?? '9222'
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('island.html'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const cdp = (method, params) =>
  new Promise((resolve) => {
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
const evaluate = (expr) =>
  cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })

await evaluate(`window.island?.island?.devOffset?.(-500); true`)
await sleep(500)
const b = await evaluate(`(async () => await window.island?.island?.devBounds?.())()`)
console.log(`岛位置（DIP）= ${JSON.stringify(b)}`)

// 2) 在同一个进程里：移到点上 → 读光标位置 → 查那个点的窗口
const target = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + 12) }
console.log(`目标点（DIP）= ${target.x},${target.y}`)
console.log(await cmd(`probe ${target.x} ${target.y}`))

ps.kill()
process.exit(0)
