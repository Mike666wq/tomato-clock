// 验收：外部改了系统音量（键盘音量键 / 别的程序），岛上的滑条位置要跟上。
//
// 这是肥鱼给的验收清单里的一条：
//   "用真实键盘音量键改音量，滑条位置跟手"。
//
// 怎么测"外部改"：
//   用**独立进程**改系统音量（tools/smtc/publish/smtc.exe vol set N）——
//   它跟主进程那个 helper 是两个进程，改的是同一个系统端点，
//   所以对岛来说这就是"外部改"。
//
// ⚠ 断言读的是**独立进程读回来的系统真值**，不是主进程里那个数
//   （主进程会乐观更新自己记的值，拿它当证据就是自己证明自己）。

import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')

function realVolume() {
  try {
    const out = execFileSync(SMTC_EXE, ['vol', 'get'], { encoding: 'utf-8', timeout: 10000 })
    const parsed = JSON.parse(out.trim().split('\n').pop())
    return parsed.ok ? Number(parsed.value) : null
  } catch {
    return null
  }
}
function setRealVolume(percent) {
  try {
    const out = execFileSync(SMTC_EXE, ['vol', 'set', String(percent)], {
      encoding: 'utf-8',
      timeout: 10000
    })
    return JSON.parse(out.trim().split('\n').pop())
  } catch {
    return null
  }
}

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
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === mid) {
        ws.removeEventListener('message', onMessage)
        resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
const evaluate = (expr) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })

// ---- 真机鼠标驱动（展开岛要用 hover，IPC 管不了） ----
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
  let i = psBuf.indexOf('\n')
  while (i >= 0) {
    const line = psBuf.slice(0, i).trim()
    psBuf = psBuf.slice(i + 1)
    i = psBuf.indexOf('\n')
    if (!line) continue
    const w = psWaiters.shift()
    if (w) w(line)
  }
})
function mouse(cmd) {
  return new Promise((resolve) => {
    psWaiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

// 准备：音乐行 + 展开（让滑条能打开）
await evaluate(`
  window.island.media.devFake({
    source: 'Tencent.QQMusic', title: '繁星之梦', artist: '唐云歌',
    playing: true, volume: 35, volumeOk: true, pending: ''
  })
  window.island.settings.save({ showMusicControl: true })
  true
`)
await sleep(1200)

// 悬停展开（必须"移开→移回"：鼠标已经在岛上时不会再发 mouseenter）
async function ensureExpanded() {
  for (let i = 0; i < 6; i++) {
    await mouse('move 5 5')
    await sleep(400)
    const b = await evaluate(`window.island?.island?.devBounds?.() ?? null`)
    if (!b) return false
    await mouse(`move ${Math.round(b.x + b.width / 2)} ${Math.round(b.y + 12)}`)
    await sleep(700)
    if (await evaluate(`!!document.querySelector('.island--expanded')`)) return true
  }
  return false
}
const expanded = await ensureExpanded()
check('岛已悬停展开', expanded === true, `expanded=${expanded}`)
if (!expanded) {
  process.exit(1)
}

// 用真机鼠标点喇叭，把滑条打开
const btnScreen = await evaluate(`
  (async () => {
    const b = await window.island?.island?.devBounds?.()
    if (!b) return null
    const el = [...document.querySelectorAll('.island__music-btn')].find((x) => x.getAttribute('aria-label') === '音量')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(b.x + r.x + r.width / 2), y: Math.round(b.y + r.y + r.height / 2) }
  })()
`)
if (!btnScreen) {
  console.log('NO_VOLUME_BUTTON')
  process.exit(1)
}
// ⚠ 直接移到按钮上，不做"先挪到旁边"：
//   岛是"悬停展开、离开收起"，挪到旁边的动作如果落在岛外，
//   岛会收起来、窗口缩小并重新居中，刚量的坐标就失效了。
await mouse(`move ${btnScreen.x} ${btnScreen.y}`)
await sleep(400)
const hitLabel = await evaluate(`
  (async () => {
    const b = await window.island?.island?.devBounds?.()
    const el = document.elementFromPoint(${btnScreen.x} - b.x, ${btnScreen.y} - b.y)
    return el ? (el.getAttribute('aria-label') || el.className || el.tagName) : 'null'
  })()
`)
console.log(`  [诊断] 按钮坐标=${JSON.stringify(btnScreen)} 该点元素=${hitLabel}`)
await mouse(`down ${btnScreen.x} ${btnScreen.y}`)
await sleep(150)
await mouse('up')
await sleep(600)

const sliderOpen = await evaluate(`!!document.querySelector('.island__vol')`)
check('滑条已打开', sliderOpen === true, `island__vol=${sliderOpen}`)
if (!sliderOpen) {
  process.exit(1)
}

const original = realVolume()
console.log(`  [诊断] 起始系统音量 = ${original}`)

/** 读滑条当前显示的百分比（拇指位置） */
async function sliderPercent() {
  const v = await evaluate(
    `(() => {
      const el = document.querySelector('.island__vol')
      if (!el) return null
      const n = Number(el.getAttribute('aria-valuenow'))
      return Number.isFinite(n) ? n : null
    })()`
  )
  return typeof v === 'number' ? v : null
}

let allFollow = true
const detail = []
for (const target of [40, 70, 55]) {
  setRealVolume(target)
  // 等 helper 的轮询把新值推回来（200ms 一次）
  let seen = null
  for (let i = 0; i < 25; i++) {
    await sleep(100)
    seen = await sliderPercent()
    if (seen === target) break
  }
  const real = realVolume()
  const ok = seen === target && real === target
  if (!ok) allFollow = false
  detail.push(`外部设成${target} → 滑条显示${seen}，系统真值${real}`)
}
check(
  '外部改音量 → 滑条位置跟上（最多 2.5 秒）',
  allFollow,
  detail.join('；')
)

// 还原
setRealVolume(original ?? 25)
await sleep(600)
const restored = realVolume()
check(
  '测试后系统音量已还原',
  restored !== null && Math.abs(restored - (original ?? 25)) <= 1,
  `现在=${restored} 原值=${original}`
)

const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
ps.kill()
process.exit(failed.length ? 1 : 0)
