// 诊断：真机点岛上的「暂停」按钮，到底**有没有真的发出媒体键**。
//
// 背景（2026-11-24 下午）：
//   0.3.7 真机验证里「点一下 → 真实播放状态反转」这条 FAIL：
//   点之前 playing=true，脚本轮询 7.5 秒一直是 true，脚本结束后再读却是 false。
//
//   两种可能：
//     a) 点击没落在按钮上（落到了岛的空白处 = 切换计时器）
//     b) 点击落了、命令也发了，但媒体键被别人吃了
//   用**两路独立证据**分开查：
//     - 计时器有没有被误切（a 的证据）
//     - 音频会话状态什么时候反转（b 的证据）
//
// 用法：node scripts\probe-island-click.mjs
//
// ⚠ 会切换用户的音乐播放状态，测完恢复原状。

import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')

function audioState() {
  try {
    const out = execFileSync(SMTC_EXE, ['audio'], { encoding: 'utf-8', timeout: 15000 })
    for (const line of out.trim().split('\n').filter(Boolean).reverse()) {
      const parsed = JSON.parse(line)
      if (parsed.kind === 'audioPlayer') {
        return parsed.playing === null ? null : Boolean(parsed.playing)
      }
    }
    return null
  } catch {
    return null
  }
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json`)).json()
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('ws error'))
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
function evaluate(ws, expression) {
  return send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then(
    (r) => r?.result?.value ?? null
  )
}

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

await evaluate(island, `window.island.settings.save({ showMusicControl: true }); true`)
await sleep(800)

// 展开
for (let i = 0; i < 6; i++) {
  await mouse('move 5 5')
  await sleep(400)
  const b = await evaluate(island, `window.island?.island?.devBounds?.() ?? null`)
  if (!b) break
  await mouse(`move ${Math.round(b.x + b.width / 2)} ${Math.round(b.y + 12)}`)
  await sleep(700)
  if (await evaluate(island, `!!document.querySelector('.island--expanded')`)) break
}
const expanded = await evaluate(island, `!!document.querySelector('.island--expanded')`)
console.log(`expanded=${expanded}`)
if (!expanded) {
  ps.kill()
  process.exit(1)
}

// 找「暂停」按钮（或者方向未知时的「播放/暂停」）
// ⚠ **devBounds() 是 async**：不 await 的话拿到的是 Promise，
//   序列化出来是 {} → 坐标算成 null → **点击根本没发生**（2026-11-24 踩过）。
const info = await evaluate(
  island,
  `(async () => {
    const btns = [...document.querySelectorAll('.island__music-btn')]
    const target = btns.find((x) => {
      const l = x.getAttribute('aria-label') || ''
      return l === '播放' || l === '暂停' || l === '播放/暂停'
    })
    if (!target) return { labels: btns.map((b) => b.getAttribute('aria-label')) }
    const b = await window.island?.island?.devBounds?.()
    const r = target.getBoundingClientRect()
    return {
      label: target.getAttribute('aria-label'),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      win: b,
      screenPoint: b ? { x: Math.round(b.x + r.x + r.width / 2), y: Math.round(b.y + r.y + r.height / 2) } : null
    }
  })()`
)
console.log(`按钮信息：${JSON.stringify(info)}`)
if (!info.screenPoint) {
  ps.kill()
  process.exit(1)
}

// 计时器状态（用来判断"是不是误点到岛的空白处"）
const timerBefore = await evaluate(island, `(async () => await window.island?.timer?.getState?.())()`)
console.log(`点之前计时器：running=${timerBefore?.running} remaining=${timerBefore?.remainingSec}`)

const before = audioState()
console.log(`点之前音频会话：playing=${before}`)

// 点
await mouse(`move ${info.screenPoint.x} ${info.screenPoint.y}`)
await sleep(300)
await mouse(`down ${info.screenPoint.x} ${info.screenPoint.y}`)
await sleep(120)
await mouse('up')

// 轮询：音频会话状态 + 计时器状态
let flipAt = null
const t0 = Date.now()
for (let i = 0; i < 40; i++) {
  await sleep(300)
  const s = audioState()
  const timer = await evaluate(island, `(async () => await window.island?.timer?.getState?.())()`)
  const el = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(
    `[${el}s] 音频 playing=${s}  计时器 running=${timer?.running} remaining=${timer?.remainingSec}`
  )
  if (s !== null && s !== before && flipAt === null) {
    flipAt = (Date.now() - t0) / 1000
    console.log(`  ↑ 音频状态反转了，耗时 ${flipAt.toFixed(2)}s`)
  }
  if (flipAt !== null && i > 6) break
}

const timerAfter = await evaluate(island, `(async () => await window.island?.timer?.getState?.())()`)
console.log(
  `\n点之后计时器：running=${timerAfter?.running} remaining=${timerAfter?.remainingSec}（之前 running=${timerBefore?.running}）`
)
console.log(
  `结论：计时器被误切 = ${timerAfter?.running !== timerBefore?.running ? '是（点击落到了岛的空白处）' : '否（点击落在按钮上）'}`
)
console.log(`音频状态反转耗时 = ${flipAt === null ? '没反转' : flipAt.toFixed(2) + 's'}`)

// 收尾：恢复
const now = audioState()
if (now !== null && now !== before) {
  console.log(`收尾：恢复音频状态到 playing=${before}`)
  await mouse(`move ${info.screenPoint.x} ${info.screenPoint.y}`)
  await sleep(250)
  await mouse(`down ${info.screenPoint.x} ${info.screenPoint.y}`)
  await sleep(120)
  await mouse('up')
  await sleep(2000)
  console.log(`恢复后音频 playing=${audioState()}`)
}

ps.kill()
