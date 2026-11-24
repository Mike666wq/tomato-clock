// 诊断：悬停到底有没有触发？
// 用法：node scripts\probe-hover.mjs

import { spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('island.html'))
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

const ps = spawn(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'scripts', 'real-mouse.ps1')],
  { stdio: ['pipe', 'pipe', 'pipe'] }
)
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
const mouse = (cmd) =>
  new Promise((resolve) => {
    waiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })

await evaluate(`window.island?.island?.devOffset?.(-500); true`)
await sleep(500)
const b = await evaluate(`(async () => await window.island?.island?.devBounds?.())()`)
console.log(`岛位置（DIP）= ${JSON.stringify(b)}`)

const target = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + 12) }
console.log(`目标悬停点 = ${target.x},${target.y}`)

// 记录 mouseenter 有没有发生
await evaluate(`
  window.__entered = 0;
  document.addEventListener('mouseenter', () => { window.__entered++ }, true);
  document.addEventListener('mouseover', () => { window.__entered += 100 }, true);
  true
`)

await mouse('move 5 5')
await sleep(500)
console.log(`移到 (5,5)：cursor=${await mouse('get 0 0')}`)
await mouse(`move ${target.x} ${target.y}`)
await sleep(1200)
console.log(`移到岛上：cursor=${await mouse('get 0 0')}`)

const r = await evaluate(`
  (() => {
    const el = document.elementFromPoint(${target.x} - ${b.x}, ${target.y} - ${b.y});
    return {
      entered: window.__entered,
      hover: !!document.querySelector('.island:hover'),
      expanded: !!document.querySelector('.island--expanded'),
      elementAtPoint: el ? (el.className || el.tagName) : 'null',
      elementAtPointChain: (() => {
        const out = [];
        let e2 = el;
        while (e2 && out.length < 5) { out.push(e2.className || e2.tagName); e2 = e2.parentElement; }
        return out;
      })()
    };
  })()
`)
console.log(JSON.stringify(r, null, 2))
ps.kill()
process.exit(0)
