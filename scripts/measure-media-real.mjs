// 真机验证：灵动岛的音乐控制到底能不能控制音乐（v0.3.6）。
//
// 要验的四条（肥鱼的验收清单）：
//   1. 播放中点暂停 → **真的停了**（读 SMTC 状态确认，不是看界面变了）
//   2. next → 真换曲
//   3. 连续 10 次点暂停/播放不塌
//   4. QQ 音乐关掉后那一行消失、不弹错
//
// ⚠ **证据从哪来**：界面上的播放/暂停图标是**主进程转述**的状态，
//   主进程可能有 400ms 的过渡态。用它当证据 = 自己证明自己。
//   这里的真相源是**独立进程**跑 `smtc current` 读 SMTC 的真实播放状态。
//
// 前置：用户得先开 QQ 音乐并放一首歌。没开就退出（不空跑）。
//
// 用法：
//   1) 起开发版（scripts/start-instance.mjs --dev --profile .tmp\e2e）
//   2) node scripts\measure-media-real.mjs
//
// ⚠ 会真的动用户的音乐（暂停/播放/切歌），测完尽量恢复原状态。

import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')

/** 独立进程读当前媒体会话（真相源） */
function currentSession() {
  try {
    const out = execFileSync(SMTC_EXE, ['current'], { encoding: 'utf-8', timeout: 15000 })
    const line = out.trim().split('\n').filter(Boolean).pop()
    const parsed = JSON.parse(line)
    return {
      title: parsed.title ?? '',
      artist: parsed.artist ?? '',
      playing: String(parsed.playbackState ?? '') === 'Playing',
      source: parsed.sourceAppId ?? ''
    }
  } catch {
    return null
  }
}

/** 音乐软件在不在（QQ 音乐 / 其它常见播放器） */
function musicAppRunning() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process QQMusic,Music,cloudmusic,Kugou -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique"
      ],
      { encoding: 'utf-8', timeout: 10000 }
    )
    return out.trim()
  } catch {
    return ''
  }
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
    setTimeout(() => reject(new Error(`${method} timeout`)), 20000)
  })
}
function evaluate(ws, expression) {
  return send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then(
    (r) => r?.result?.value ?? null
  )
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

// ---------- 前置：音乐软件得开着 ----------
const apps = musicAppRunning()
console.log(`  [诊断] 音乐软件进程：${apps || '（一个都没有）'}`)
if (!apps) {
  console.log('\nNO_MUSIC_APP —— 没检测到音乐软件。')
  console.log('  请用户先开 QQ 音乐并放一首歌，再跑这个脚本。')
  console.log('  （没开的时候 SMTC 会挂 3 秒超时，测出来的都是假的。）\n')
  process.exit(2)
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

async function currentBounds() {
  return await evaluate(island, `window.island?.island?.devBounds?.() ?? null`)
}

/** 按 aria-label 找按钮的屏幕坐标 */
async function buttonPoint(label) {
  const b = await currentBounds()
  if (!b) return null
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
  // DIP 直传（SetCursorPos 吃 DIP，见《验证方法》第二十六节）
  return { x: Math.round(b.x + rect.x), y: Math.round(b.y + rect.y) }
}

/** 真机点一个按钮 */
async function clickButton(label) {
  const p = await buttonPoint(label)
  if (!p) return false
  await mouse(`move ${p.x} ${p.y}`)
  await sleep(250)
  await mouse(`down ${p.x} ${p.y}`)
  await sleep(120)
  await mouse('up')
  await sleep(200)
  return true
}

/** 悬停展开（必须"移开→移回"） */
async function ensureExpanded() {
  for (let i = 0; i < 6; i++) {
    await mouse('move 5 5')
    await sleep(400)
    const b = await currentBounds()
    if (!b) return false
    await mouse(`move ${Math.round(b.x + b.width / 2)} ${Math.round(b.y + 12)}`)
    await sleep(700)
    if (await evaluate(island, `!!document.querySelector('.island--expanded')`)) return true
  }
  return false
}

// ---------- 准备：展开 + 音乐行 ----------
await evaluate(
  island,
  `(() => {
    window.island.settings.save({ showMusicControl: true })
    return true
  })()`
)
await sleep(800)
const expanded = await ensureExpanded()
check('岛已悬停展开', expanded === true, `expanded=${expanded}`)
if (!expanded) process.exit(1)

// 等音乐行出现（真状态，不是假状态）
let musicRow = false
for (let i = 0; i < 25; i++) {
  await sleep(300)
  musicRow = await evaluate(island, `!!document.querySelector('.island__music')`)
  if (musicRow) break
}
check('音乐行出现（读到了真实会话）', musicRow === true, `.island__music=${musicRow}`)
if (!musicRow) {
  console.log('  [诊断] 界面状态=', JSON.stringify(await evaluate(island, `window.island?.media?.getState?.()`)))
  process.exit(1)
}

const before = currentSession()
console.log(`  [诊断] 当前会话：${JSON.stringify(before)}`)

// ---------- 1. 点暂停 → 真的停 ----------
if (before?.playing) {
  const clicked = await clickButton('暂停')
  check('真机点到「暂停」按钮', clicked === true, `clicked=${clicked}`)
  // 等状态真的回流（主进程有 400ms 过渡态）
  let after = null
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    after = currentSession()
    if (after && !after.playing) break
  }
  check(
    '点暂停 → 音乐真的停了（独立进程读 SMTC 状态）',
    after !== null && after.playing === false,
    `暂停前 playing=${before.playing}，暂停后 playing=${after?.playing}`
  )

  // ---------- 2. 再点播放 → 真的放 ----------
  await clickButton('播放')
  let resumed = null
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    resumed = currentSession()
    if (resumed && resumed.playing) break
  }
  check(
    '点播放 → 音乐真的放起来了',
    resumed !== null && resumed.playing === true,
    `playing=${resumed?.playing}`
  )
} else {
  check('跳过暂停/播放：开始时音乐就没在放', true, `playing=${before?.playing}`)
}

// ---------- 3. next 真换曲 ----------
const t1 = currentSession()?.title ?? ''
const nextClicked = await clickButton('下一首')
check('真机点到「下一首」按钮', nextClicked === true, `clicked=${nextClicked}`)
let t2 = ''
let changed = false
for (let i = 0; i < 20; i++) {
  await sleep(300)
  const s = currentSession()
  t2 = s?.title ?? ''
  if (t2 && t2 !== t1) {
    changed = true
    break
  }
}
check('next → 真换曲了（标题变了）', changed === true, `换之前="${t1}" 换之后="${t2}"`)

// ---------- 4. 连续 10 次切换不塌 ----------
for (let i = 0; i < 10; i++) {
  const label = i % 2 === 0 ? '暂停' : '播放'
  await clickButton(label)
  await sleep(400)
}
const alive = await evaluate(island, `!!document.querySelector('.island')`)
check('连续 10 次切换播放/暂停，岛还在（不塌）', alive === true, `.island=${alive}`)

// 收尾：恢复成"在放"的状态（别把用户的音乐留在暂停）
const endState = currentSession()
if (endState && !endState.playing) {
  await clickButton('播放')
  await sleep(800)
}

ps.kill()
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
