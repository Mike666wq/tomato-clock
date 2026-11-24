// 探针：真机拖动时，pointermove 到底有没有进到渲染层？
//
// 现状：滑条能打开，但按下之后拖动全程音量不变（停在按下那一下的值）。
// 两种可能：
//   A. pointermove 根本没送到渲染层（窗口/捕获这一层的问题）
//   B. pointermove 到了，但组件的处理函数没执行（React 那一层的问题）
//
// 办法：挂**原生**监听（不 preventDefault、不 stopPropagation，不干扰业务），
// 记录每个事件的类型和 clientX；同时读滑条拇指的位置（= 组件的 local 状态）。
// 两者对照就能定位断在哪一层。
//
// 用法：node scripts\probe-drag-events.mjs

import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 鼠标驱动 ----------
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

// ---------- CDP ----------
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

// ⚠ 上一轮跑完滑条可能还开着（volOpen 留在渲染层里），
//   开着的时候喇叭按钮被滑条替换掉了，就找不到按钮了。
//   滑条 3 秒不动会自动收起 —— 等它收，别用 Page.reload：
//   重载会把「鼠标已经悬停在岛上 → 不再触发 mouseenter」这个状态搞乱，
//   展开就再也触发不了（实测 expanded=false 而 hover=true）。
if (await evaluate(island, `!!document.querySelector('.island__vol')`)) {
  console.log('  [诊断] 滑条还开着，等它自动收起…')
  await sleep(3600)
}

// ---------- 挂探针（原生、被动、不干扰业务） ----------
await evaluate(
  island,
  `(() => {
    window.__probe = []
    const rec = (e) => {
      window.__probe.push({
        type: e.type,
        clientX: Math.round(e.clientX),
        buttons: e.buttons,
        target: e.target && e.target.className ? String(e.target.className) : (e.target ? e.target.tagName : '?'),
        captured: (() => { try { return document.querySelector('.island__vol')?.hasPointerCapture?.(e.pointerId) } catch { return null } })()
      })
    }
    // 挂在 window 上（冒泡阶段）——只要事件到了文档就会记下来
    for (const t of ['pointerdown','pointermove','pointerup','mousemove','mousedown','mouseup','lostpointercapture','gotpointercapture']) {
      window.addEventListener(t, rec, true)
    }
    return true
  })()`
)

// ---------- 准备：展开 + 假状态 + 打开滑条 ----------
await evaluate(
  island,
  `(() => {
    window.island.settings.save({ showMusicControl: true })
    window.island.media.devFake({
      source: 'Tencent.QQMusic', title: '繁星之梦', artist: '唐云歌',
      playing: true, volume: 35, volumeOk: true, pending: ''
    })
    window.island.island.setMode('expanded', true)
    return true
  })()`
)
await sleep(600)

async function bounds() {
  return await evaluate(island, `window.island?.island?.devBounds?.() ?? null`)
}
async function trackPoint(ratio) {
  const b = await bounds()
  const rect = await evaluate(
    island,
    `(() => {
      const el = document.querySelector('.island__vol-track')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })()`
  )
  if (!rect) return null
  return { x: Math.round(b.x + rect.x + rect.w * ratio), y: Math.round(b.y + rect.y + rect.h / 2) }
}
async function btnPoint(label) {
  const b = await bounds()
  const rect = await evaluate(
    island,
    `(() => {
      const el = [...document.querySelectorAll('.island__music-btn')].find((x) => x.getAttribute('aria-label') === '${label}')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`
  )
  if (!rect) return null
  return { x: Math.round(b.x + rect.x), y: Math.round(b.y + rect.y) }
}

// 悬停展开
//
// ⚠ **必须"移开→移回"**：如果鼠标已经停在岛上，浏览器**不会**再发 mouseenter
//   （实测：CSS 的 :hover 是 true，但 React 的 expanded 一直是 false）。
//   所以每次都先挪到远处，等它离开，再移进来。
async function ensureExpanded() {
  for (let i = 0; i < 6; i++) {
    await mouse('move 5 5')
    await sleep(400)
    const b = await bounds()
    await mouse(`move ${Math.round(b.x + b.width / 2)} ${Math.round(b.y + 12)}`)
    await sleep(700)
    const expanded = await evaluate(island, `!!document.querySelector('.island--expanded')`)
    if (expanded) return true
  }
  return false
}
const gotExpanded = await ensureExpanded()
console.log(`  [诊断] 展开成功 = ${gotExpanded}`)
if (!gotExpanded) {
  console.log(
    `  [诊断] hover=${await evaluate(island, `!!document.querySelector('.island:hover')`)} 窗口=${JSON.stringify(await bounds())}`
  )
  process.exit(1)
}

// 点喇叭
const vb = await btnPoint('音量')
if (!vb) {
  console.log('NO_VOLUME_BUTTON')
  console.log('  [诊断] state=', JSON.stringify(await evaluate(island, `window.island?.media?.getState?.()`)))
  console.log(
    '  [诊断] settings=',
    JSON.stringify(await evaluate(island, `window.island?.settings?.get?.()`))
  )
  console.log(
    '  [诊断] music元素=',
    await evaluate(island, `!!document.querySelector('.island__music')`),
    '按钮数=',
    await evaluate(island, `document.querySelectorAll('.island__music-btn').length`),
    '滑条存在=',
    await evaluate(island, `!!document.querySelector('.island__vol')`),
    'expanded=',
    await evaluate(island, `!!document.querySelector('.island--expanded')`)
  )
  process.exit(1)
}
const b1 = await bounds()
await mouse(`move ${b1.x + 20} ${b1.y + 12}`)
await sleep(300)
await mouse(`move ${vb.x} ${vb.y}`)
await sleep(400)
await mouse(`down ${vb.x} ${vb.y}`)
await sleep(150)
await mouse('up')
await sleep(600)
console.log(`滑条打开了 = ${await evaluate(island, `!!document.querySelector('.island__vol')`)}`)

// 清掉探针记录，只看拖动这段
await evaluate(island, `window.__probe = []`)

// ---------- 拖动 ----------
const t0 = await trackPoint(0.8)
console.log(`按下点（DIP）=${JSON.stringify(t0)}`)
await mouse(`move ${t0.x} ${t0.y}`)
await sleep(300)
await mouse(`down ${t0.x} ${t0.y}`)
await sleep(300)
console.log(`按下后 拇指位置 = ${await evaluate(island, `document.querySelector('.island__vol-thumb')?.style.left ?? 'none'`)}`)

for (const ratio of [0.6, 0.4, 0.2, 0.1]) {
  const p = await trackPoint(ratio)
  await mouse(`move ${p.x} ${p.y}`)
  await sleep(400)
  const thumb = await evaluate(island, `document.querySelector('.island__vol-thumb')?.style.left ?? 'none'`)
  const vol = await evaluate(island, `window.island?.media?.getVolume?.() ?? null`)
  // 独立进程读系统真值（不经主进程）
  let real = null
  try {
    const out = execFileSync(path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe'), ['vol', 'get'], {
      encoding: 'utf-8',
      timeout: 10000
    })
    real = JSON.parse(out.trim().split('\n').pop()).value
  } catch {
    real = '读不到'
  }
  console.log(
    `  移到 ${ratio * 100}%（DIP ${p.x},${p.y}）→ 拇指=${thumb} 主进程音量=${vol} 系统真值=${real}`
  )
}

await mouse('up')
await sleep(500)

const probe = await evaluate(island, `window.__probe`)
console.log(`\n=== 原生监听记到的事件（${probe?.length ?? 0} 个） ===`)
for (const p of probe ?? []) {
  console.log(`  ${p.type.padEnd(20)} clientX=${String(p.clientX).padStart(4)} buttons=${p.buttons} captured=${p.captured} target=${p.target}`)
}

ps.kill()
process.exit(0)
