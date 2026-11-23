// 真机鼠标验证：灵动岛音量滑条能不能**真的拖动**（v0.3.6）。
//
// 为什么要"真机"：CDP 的 Input.dispatchMouseEvent 是**合成输入**，
// 不带指针捕获语义，拖动路径跟真实鼠标不是一回事。
// 这次用 Windows 真实的 SetCursorPos + mouse_event 发输入，
// 走的是和用户一样的那条路。
//
// 用法：
//   1) 起开发版（scripts/start-instance.mjs --dev --profile .tmp\e2e）
//   2) node scripts\measure-vol-real.mjs
//
// ⚠ 会真的改系统音量，测完恢复。

import { spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
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
function evaluate(ws, expression) {
  return send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }).then((r) => r?.result?.value ?? null)
}

// ---------- 真机鼠标驱动 ----------
const ps = spawn(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'scripts', 'real-mouse.ps1')],
  { stdio: ['pipe', 'pipe', 'pipe'] }
)
ps.stdout.setEncoding('utf-8')
let psBuf = ''
const psWaiters = []
ps.stdout.on('data', (chunk) => {
  psBuf += chunk
  let idx = psBuf.indexOf('\n')
  while (idx >= 0) {
    const line = psBuf.slice(0, idx).trim()
    psBuf = psBuf.slice(idx + 1)
    idx = psBuf.indexOf('\n')
    if (!line) continue
    const w = psWaiters.shift()
    if (w) w(line)
  }
})
ps.stderr.setEncoding('utf-8')
ps.stderr.on('data', (chunk) => {
  const t = chunk.trim()
  if (t) console.log(`  [鼠标驱动] ${t}`)
})
function mouse(cmd) {
  return new Promise((resolve) => {
    psWaiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })
}

// ---------- 连岛 ----------
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

async function uiVolume() {
  const v = await evaluate(island, `window.island?.media?.getVolume?.() ?? null`)
  return typeof v === 'number' ? v : null
}

// 岛的窗口屏幕坐标（DOM 的 rect 是窗口内视口坐标，要加窗口位置才是屏幕坐标）
const bounds = await evaluate(island, `window.island?.island?.devBounds?.() ?? null`)
if (!bounds) {
  console.log('NO_BOUNDS（开发期 IPC 不可用）')
  process.exit(1)
}

// 准备：打开音乐行（开发期假状态）+ 展开岛 + 打开滑条
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

// 等音乐行出现（假状态 + 展开都要生效）
// 把**真机鼠标**移到岛上 → 触发 hover 展开（渲染层只认 hover，不认 IPC）
// ⚠ 先挪到别处：Windows 会合并鼠标移动消息，光标本来就在那儿的话
//   再移过去可能**不产生移动事件**，hover 就不会触发（踩过）。
await mouse('move 5 5')
await sleep(200)
const pos1 = await mouse('get 0 0')
const islandCenter = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + 12) }
await mouse(`move ${islandCenter.x} ${islandCenter.y}`)
await sleep(600)
const pos2 = await mouse('get 0 0')
console.log(`  [诊断] 光标位置：移到 (5,5) 后=${pos1}；移到岛上后=${pos2}（期望 ${islandCenter.x},${islandCenter.y}）`)

let musicReady = false
for (let i = 0; i < 25; i++) {
  await sleep(200)
  const ready = await evaluate(
    island,
    `!!document.querySelector('.island__music') && !![...document.querySelectorAll('.island__music-btn')].find((x) => x.getAttribute('aria-label') === '音量')`
  )
  if (ready) {
    musicReady = true
    break
  }
  // 假状态被 helper 的空 state 清掉时，重新打一次
  await evaluate(
    island,
    `window.island.media.devFake({
      source: 'Tencent.QQMusic', title: '繁星之梦', artist: '唐云歌',
      playing: true, volume: 35, volumeOk: true, pending: ''
    })`
  )
}
check('音乐行出现（假状态 + 展开）', musicReady, `ready=${musicReady}`)
if (!musicReady) {
  console.log(
    '  [诊断] expanded=',
    await evaluate(island, `!!document.querySelector('.island--expanded')`),
    'music=',
    await evaluate(island, `!!document.querySelector('.island__music')`),
    'devFake=',
    await evaluate(island, `typeof window.island?.media?.devFake`),
    'state=',
    JSON.stringify(await evaluate(island, `window.island?.media?.getState?.()`)),
    'bounds=',
    JSON.stringify(await evaluate(island, `window.island?.island?.devBounds?.()`))
  )
  process.exit(1)
}

// 点喇叭（用真机鼠标点，坐标从屏幕换算）
async function screenPoint(selector, ratio) {
  const rect = await evaluate(
    island,
    `(() => {
      const el = document.querySelector('${selector}')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })()`
  )
  if (!rect) return null
  return {
    x: Math.round(bounds.x + rect.x + rect.w * ratio),
    y: Math.round(bounds.y + rect.y + rect.h / 2)
  }
}

// 先把鼠标移到喇叭按钮上（真实移动），再按下滑条
const btn = await screenPoint('.island__music-btn[data-on], .island__music-btn:last-child', 0)
const volBtn = await evaluate(
  island,
  `(() => {
    const b = [...document.querySelectorAll('.island__music-btn')].find((x) => x.getAttribute('aria-label') === '音量')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`
)
if (!volBtn) {
  console.log('NO_VOLUME_BUTTON')
  process.exit(1)
}
const btnScreen = { x: Math.round(bounds.x + volBtn.x), y: Math.round(bounds.y + volBtn.y) }
await mouse('move 5 5')
await sleep(200)
await mouse(`move ${btnScreen.x} ${btnScreen.y}`)
await sleep(300)
await mouse(`down ${btnScreen.x} ${btnScreen.y}`)
await sleep(120)
await mouse('up')
await sleep(500)

const opened = await evaluate(island, `!!document.querySelector('.island__vol')`)
check('真机点击喇叭 → 滑条打开', opened === true, `island__vol=${opened}`)
if (!opened) {
  process.exit(1)
}

// ---------- 真机拖动：按下 → 分 5 段移动 → 抬起 ----------
const original = await uiVolume()
const start = await screenPoint('.island__vol-track', 0.8)
await mouse(`move ${start.x} ${start.y}`)
await sleep(250)
await mouse(`down ${start.x} ${start.y}`)
await sleep(250)

const steps = [
  { ratio: 0.6, expect: 60 },
  { ratio: 0.4, expect: 40 },
  { ratio: 0.3, expect: 30 },
  { ratio: 0.2, expect: 20 },
  { ratio: 0.1, expect: 10 }
]
let allMatch = true
const detail = []
for (const s of steps) {
  const p = await screenPoint('.island__vol-track', s.ratio)
  await mouse(`move ${p.x} ${p.y}`)
  await sleep(320)
  const v = await uiVolume()
  const ok = v !== null && Math.abs(v - s.expect) <= 2
  if (!ok) allMatch = false
  detail.push(`${s.ratio * 100}%→期望${s.expect} 实得${v}`)
}
check(
  '真机拖动：每段音量都跟上（指针捕获生效）',
  allMatch,
  detail.join('；')
)

await mouse('up')
await sleep(700)
const afterUp = await uiVolume()
check(
  '松手落在最终值（10%）',
  afterUp !== null && Math.abs(afterUp - 10) <= 2,
  `松手后=${afterUp}（期望 10）`
)

// 恢复音量
await evaluate(island, `window.island?.media?.setVolume?.(${original ?? 25})`)
await sleep(900)
const restored = await uiVolume()
check('测试后音量已恢复原值', restored === original, `现在=${restored} 原值=${original}`)

ps.kill()
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
