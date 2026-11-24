// 真机鼠标验证：灵动岛音量滑条能不能**真的拖动**（v0.3.6）。
//
// 为什么要"真机"：CDP 的 Input.dispatchMouseEvent 是**合成输入**，
// 不带指针捕获语义，拖动路径跟真实鼠标不是一回事。
// 这次用 Windows 真实的 SetCursorPos + mouse_event 发输入，
// 走的是和用户一样的那条路。
//
// ⚠ **证据从哪来**：断言读的是**独立进程**（tools/smtc/publish/smtc.exe vol get）
//   读回来的系统主音量，不是主进程里那个数。
//   主进程 setVolume 时会先乐观记下目标值（为了让滑条跟手），
//   拿它当证据 = 自己证明自己，那个乐观值必须被真实读回覆盖才算数。
//   独立进程是全新启动的，不带任何乐观状态，读到的是系统里的真值。
//
// ⚠ 会真的改系统音量和鼠标位置，测完都还原。
//
// 用法：
//   1) 起开发版（scripts/start-instance.mjs --dev --profile .tmp\e2e）
//   2) node scripts\measure-vol-real.mjs

import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { assertNotLocked } from './preflight.mjs'

// 屏幕锁着就别做真机输入验证（事件全被锁屏遮罩吃掉，测出来是假的）
assertNotLocked()

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

// ---------- 独立进程读系统真值 ----------
//
// ⚠ 曾经的坑：以为「另起一个进程读音量」会读到**不同的默认输出设备**，
//   于是读写对不上。那次的错在于读的程序跟写音量用的程序**不是一套代码**
//   （用的角色/接口不一样）。这里用**同一个 helper 二进制**的 vol get ——
//   同一份代码、同一个默认端点角色（eMultimedia），所以读的就是同一个设备。
//   脚本里还会交叉验证：拖动前独立进程读的值必须与主进程读的值一致。
const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')
if (!existsSync(SMTC_EXE)) {
  console.log(`NO_SMTC_EXE（找不到 ${SMTC_EXE}）`)
  process.exit(1)
}
/** 独立进程读系统主音量（0-100）；读不到返回 null */
function realVolume() {
  try {
    const out = execFileSync(SMTC_EXE, ['vol', 'get'], { encoding: 'utf-8', timeout: 10000 })
    const parsed = JSON.parse(out.trim().split('\n').pop())
    if (!parsed.ok) return null
    return Number(parsed.value)
  } catch {
    return null
  }
}
/** 独立进程设系统主音量（测试后还原用） */
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

/**
 * 记住鼠标原来的位置 —— 真机测试会把它挪走，测完要还原
 * （用户在用他的电脑，不能把他的光标留在别处）。
 */
async function captureCursor() {
  const raw = await mouse('get 0 0')
  const m = /POS\s+(-?\d+)\s+(-?\d+)/.exec(raw)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}
const cursorStart = await captureCursor()
console.log(`  [诊断] 鼠标原位置：${cursorStart ? `${cursorStart.x},${cursorStart.y}` : '读不到'}`)

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

// ---- 把开发实例的岛横向挪开 ----
// 机器上同时跑着用户自己装的那份（0.3.3），两个岛会**完全重叠**
// （都在 x=783）：真机鼠标分不清点的是哪个，还挡着用户那份。
// 挪到屏幕左边去，物理坐标从窗口实际位置算，不用猜。
//
// ⚠ **每次都重置**：别的验证脚本（probe-degraded、measure-music-always-on）
//   也会挪岛，共享同一个开发实例 → 位置会被改掉。
//   这里统一挪到同一个地方，脚本之间就互不干扰。
//
// ⚠ **打包版没有 devOffset**（开发期口子被编译掉了）：
//   那时不能挪岛，靠下面的**窗口枚举**定位 ——
//   但机器上还有用户那份 0.3.6 在跑，**两个岛会重叠**，
//   所以必须先把用户那份关掉，或者靠"窗口标题 + 进程路径"认出被测那个。
const DEV_OFFSET_X = -500
const devOffsetAvailable = await evaluate(
  island,
  `typeof window.island?.island?.devOffset === 'function'`
)
if (devOffsetAvailable) {
  await evaluate(island, `window.island?.island?.devOffset?.(${DEV_OFFSET_X})`)
  await sleep(600)
} else {
  console.log('  [诊断] 打包版：没有 devOffset，岛不能挪开')
}

/**
 * 岛的窗口屏幕坐标。
 *
 * ⚠ **打包版没有 devBounds**（开发期口子被编译掉了）→ 用 `window.screenX/screenY`。
 *   这两个属性在打包版里**照样有**（是标准 Web API，不是开发期口子），
 *   而且它们给的就是**当前**窗口位置 —— 展开/收起后会变，正好符合需要。
 *
 *   ⚠ **不要再用窗口枚举**：它要起一个 PowerShell（~300ms 起），
 *   有时还要循环重试 —— **加起来可能超过 3 秒**，
 *   而滑条"3 秒不动就自动收起" —— 滑条会在拿到坐标之前就自己消失。
 *   （实测栽在这：`.island__vol` 明明刚 PASS 过，下一个查询就没了。）
 *
 *   ⚠ **免安装单文件版的窗口属于解包后的临时 exe**，
 *   按原始文件路径枚举不到它（得沿父进程链找）—— 用 screenX 就没这问题。
 */
async function getIslandBounds() {
  const dev = await evaluate(island, `window.island?.island?.devBounds?.() ?? null`)
  if (dev && typeof dev.x === 'number') return dev
  // 打包版：window.screenX/screenY（标准 Web API，打包版也有）
  const s = await evaluate(
    island,
    `({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })`
  )
  if (!s || typeof s.x !== 'number') return null
  return { x: s.x, y: s.y, width: s.w, height: s.h }
}

// 岛的窗口屏幕坐标（DOM 的 rect 是窗口内视口坐标，要加窗口位置才是屏幕坐标）
const bounds = await getIslandBounds()
if (!bounds) {
  console.log('NO_BOUNDS（拿不到岛的窗口位置：devBounds 不可用，窗口枚举也失败）')
  process.exit(1)
}

/**
 * ⚠ **坐标体系（实测，别再改）**：
 *   这台机器 150% 缩放，屏幕上同一位置有两套数：
 *     - DIP：Electron 的 getBounds() / DOM rect / PowerShell 的 GetWindowRect、
 *       WindowFromPoint / **SetCursorPos** —— 全都是这一套
 *     - 物理像素：只有屏幕真实像素才是
 *
 *   实测（scripts/probe-cursor-scale.mjs）：
 *     把 DIP 直传给 SetCursorPos → 岛能收到 hover，展开=true
 *     把 DIP × 1.5 再传        → 岛收不到 hover，展开=false
 *
 *   之前"真机拖动测不出来"，根本原因就在这里 ——
 *   我按"SetCursorPos 要物理像素"乘了 1.5，鼠标一直落在屏幕的别处。
 *   不是产品的问题。
 */
const dpr = Number(await evaluate(island, `window.devicePixelRatio`)) || 1
console.log(`  [诊断] devicePixelRatio=${dpr}；岛的位置（开发实例，已横向挪开）=${JSON.stringify(bounds)}`)

// 准备：打开音乐行（开发期假状态）+ 展开岛 + 打开滑条
//
// ⚠ 上一轮跑完滑条可能还开着（volOpen 留在渲染层里），
//   开着的时候喇叭按钮被滑条替换掉了，就找不到按钮了。
//   滑条 3 秒不动会自动收起 —— 等它收。
if (await evaluate(island, `!!document.querySelector('.island__vol')`)) {
  console.log('  [诊断] 滑条还开着，等它自动收起…')
  await sleep(3600)
}

// ⚠ **打包版没有 devFake**（开发期口子被编译掉了）：
//   开发版靠假状态把音乐行叫出来（不然没有会话时那一行是空的），
//   打包版只能用**真状态**（真实音量是系统级的，跟有没有会话无关，
//   所以打包版的音乐行一直都在，音量按钮也一直在）。
const hasDevFake = await evaluate(island, `typeof window.island?.media?.devFake === 'function'`)
console.log(`  [诊断] 有 devFake（开发版口子）= ${hasDevFake}`)

const FAKE_STATE = `{
  source: 'Tencent.QQMusic', title: '繁星之梦', artist: '唐云歌',
  playing: true, volume: 35, volumeOk: true, pending: ''
}`

await evaluate(
  island,
  `(() => {
    window.island.settings.save({ showMusicControl: true })
    ${hasDevFake ? `window.island.media.devFake(${FAKE_STATE})` : ''}
    window.island.island.setMode('expanded', true)
    return true
  })()`
)
await sleep(600)

/**
 * 悬停展开。
 *
 * ⚠ **必须"移开→移回"**：如果鼠标已经停在岛上，浏览器**不会**再发 mouseenter
 *   （实测：CSS 的 :hover 是 true，但 React 的 expanded 一直是 false）。
 *   所以每次都先挪到远处，等它离开，再移进来。
 */
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

// 等音乐行出现（假状态 + 展开都要生效）
const gotExpanded = await ensureExpanded()
console.log(`  [诊断] 岛展开 = ${gotExpanded}`)
console.log(`  [诊断] 展开后窗口位置=${JSON.stringify(await currentBounds())}`)

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
  // 假状态被 helper 的空 state 清掉时，重新打一次（只有开发版有假状态）
  if (hasDevFake) {
    await evaluate(island, `window.island.media.devFake(${FAKE_STATE})`)
  }
}
check(
  hasDevFake ? '音乐行出现（假状态 + 展开）' : '音乐行出现（真状态 + 展开）',
  musicReady,
  `ready=${musicReady}`
)
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
/**
 * DOM 坐标 → 屏幕坐标。
 *
 * ⚠ **每次都要重新读窗口位置**：岛展开/收起时窗口宽度会变，
 *   变了就重新贴顶居中 —— 窗口的 x 也就跟着变了。
 *   用展开前量到的 bounds 去算展开后的按钮位置，会点到别的地方去。
 */
async function currentBounds() {
  return await getIslandBounds()
}

async function screenPoint(selector, ratio) {
  // ⚠ **每次都实时取窗口位置**：
  //   打包版用 `window.screenX/screenY`（一次 CDP 调用，快），
  //   它跟着展开/收起实时变 —— 正好符合"每次都要重新读"的需要。
  //   （开发版走 devBounds，同样是实时的。）
  const b = await currentBounds()
  if (!b) return null
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
  // DIP 直传（见上面的坐标体系说明）
  return {
    x: Math.round(b.x + rect.x + rect.w * ratio),
    y: Math.round(b.y + rect.y + rect.h / 2)
  }
}

/**
 * 展开后的窗口位置（**缓存**）。
 *
 * ⚠ **为什么缓存**：窗口枚举（find-window-by-path.ps1）每次跑都拿到
 *   **那一刻**的窗口尺寸 —— 岛展开/收起时宽度会变（189 ↔ 360），
 *   窗口重新贴顶居中，x 也跟着变。
 *   拖动滑条的过程中窗口可能因为别的原因变化，
 *   于是"算坐标用的窗口位置"和"实际窗口位置"对不上 → 点空。
 *
 *   展开之后缓存一次，拖动全程用同一个值 —— 期间窗口不会变
 *   （音乐行展开后尺寸是固定的）。
 *
 * ⚠ **必须在展开成功后立刻缓存**：这时窗口才是展开态的尺寸。
 *   （实测：在展开前缓存会拿到收起态的 188 宽 → 算出的按钮坐标在岛外面。）
 */

/** 按 aria-label 找按钮，返回屏幕坐标 */
async function screenPointByLabel(label) {
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
  return { x: Math.round(b.x + rect.x), y: Math.round(b.y + rect.y) }
}

// ---------- 拖动前的核对：**必须在点开滑条之前** ----------
//
// ⚠ **为什么放前面**：滑条 3 秒不动会自动收起（VOL_HIDE_MS）。
//   核对要起独立进程读系统音量，耗掉一两秒 ——
//   如果放在点开之后，滑条会在这段时间里自己收走，
//   后面就找不到滑条元素（实测打包版就栽在这）。
//
// 原值：**用独立进程读**（不是主进程里那个乐观值）
const original = await realVolume()
const originalUi = await uiVolume()
check(
  '拖动前：独立进程读到的系统音量 == 主进程读到的（同一个设备）',
  original !== null && originalUi !== null && Math.abs(original - originalUi) <= 1,
  `独立进程=${original} 主进程=${originalUi}`
)
if (original === null) {
  console.log('  [诊断] 独立进程读不到系统音量 —— 音频设备或默认端点有问题')
}

// 先把鼠标移到喇叭按钮上（真实移动），再按下滑条
//
// ⚠ **鼠标不能中途挪走**：岛是"悬停展开、离开收起"的。
//   一旦把鼠标挪到别处（下面第一版就是这么写的），岛收起来、
//   窗口缩小并重新居中，刚才量的按钮坐标就失效了。
//   所以：鼠标从始至终停在岛上，只在"岛内"换位置。
const btnScreen = await screenPointByLabel('音量')
if (!btnScreen) {
  console.log('NO_VOLUME_BUTTON')
  process.exit(1)
}
const bNow = await currentBounds()
console.log(`  [诊断] 喇叭按钮屏幕坐标（DIP）=${JSON.stringify(btnScreen)}；当前窗口=${JSON.stringify(bNow)}`)

// 岛内换位置：先挪到岛的左端（还在岛里），再挪到按钮上
const insideIsland = { x: bNow.x + 20, y: bNow.y + 12 }
await mouse(`move ${insideIsland.x} ${insideIsland.y}`)
await sleep(300)
await mouse(`move ${btnScreen.x} ${btnScreen.y}`)
await sleep(400)

// 点之前先确认：那个点上确实是喇叭按钮（别点了个寂寞）
const hitLabel = await evaluate(
  island,
  `(() => {
    const el = document.elementFromPoint(${btnScreen.x - bNow.x}, ${btnScreen.y - bNow.y})
    return el ? (el.getAttribute('aria-label') || el.className || el.tagName) : 'null'
  })()`
)
console.log(`  [诊断] 该点上的元素 = ${hitLabel}`)
await mouse(`down ${btnScreen.x} ${btnScreen.y}`)
await sleep(150)
await mouse('up')
await sleep(700)

const opened = await evaluate(island, `!!document.querySelector('.island__vol')`)
check('真机点击喇叭 → 滑条打开', opened === true, `island__vol=${opened}`)
if (!opened) {
  process.exit(1)
}

// ⚠ **滑条 3 秒不动会自动收起**（VOL_HIDE_MS）。
//   上面"拖动前"的核对要起独立进程读音量，耗掉一两秒 ——
//   滑条可能已经收起来了，后面就找不到滑条元素（实测打包版就栽在这）。
//   所以核对完**重新点开一次**，再立刻开始拖。
const sliderGone = !(await evaluate(island, `!!document.querySelector('.island__vol')`))
if (sliderGone) {
  console.log('  [诊断] 滑条被自动收起了，重新点开')
  const again = await screenPointByLabel('音量')
  if (again) {
    await mouse(`move ${again.x} ${again.y}`)
    await sleep(250)
    await mouse(`down ${again.x} ${again.y}`)
    await sleep(100)
    await mouse('up')
    await sleep(300)
  }
}
const sliderOpen = await evaluate(island, `!!document.querySelector('.island__vol')`)
check('滑条是开着的（能拖）', sliderOpen === true, `.island__vol=${sliderOpen}`)

// ⚠ **点开滑条后不要再取窗口位置**。
//
//   取窗口位置要起一个 PowerShell 查窗口（~300ms+），有时还要循环重试 ——
//   **加起来可能超过 3 秒**，而滑条"3 秒不动就自动收起" ——
//   滑条会在拿到坐标之前就自己消失（实测：`.island__vol` 明明刚 PASS 过，
//   下一个查询就没了）。
//
//   实测点开滑条前后窗口位置**没有变**（都是 698/360）——
//   歌名区换成滑条，宽度没变（滑条宽度是固定的），所以窗口不用重新居中。
//   展开后缓存的那个位置直接用就行。
const start = await screenPoint('.island__vol-track', 0.8)
if (!start) {
  console.log('  [诊断] 拿不到滑条的屏幕坐标（滑条元素找不到或窗口位置拿不到）')
} else {
  // ⚠ 按下之前先确认那个点上确实是滑条（别按了个寂寞）。
  //   滑条是**独立元素**，按错地方 → 触发不了它的 pointerdown →
  //   指针捕获没建立 → 也重置不了"3 秒自动收起"的定时器 → 滑条自己消失。
  const bNow2 = await currentBounds()
  const hit = await evaluate(
    island,
    `(() => {
      const el = document.elementFromPoint(${start.x - bNow2.x}, ${start.y - bNow2.y})
      if (!el) return 'null'
      return (el.className || el.tagName || '') + ' / ' + (el.getAttribute('aria-label') || '')
    })()`
  )
  console.log(`  [诊断] 滑条起点的坐标=${JSON.stringify(start)}，那个点上=${hit}`)
}
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
  if (!p) {
    // ⚠ 滑条元素在拖动过程中不见了（3 秒不动自动收起 / 按下后重建）。
    //   没有它就算失败，但要把原因说清楚，不能是个 null 崩掉。
    allMatch = false
    detail.push(`${s.ratio * 100}%→拿不到滑条坐标`)
    const why = await evaluate(
      island,
      `(() => ({
        vol: !!document.querySelector('.island__vol'),
        track: !!document.querySelector('.island__vol-track'),
        expanded: !!document.querySelector('.island--expanded')
      }))()`
    )
    console.log(`  [诊断] 拿不到滑条坐标时的界面状态：${JSON.stringify(why)}`)
    break
  }
  await mouse(`move ${p.x} ${p.y}`)
  // ⚠ **要等它稳定，不能读一次就下结论**：
  //   helper 设完音量后还有回读/推送的滞后，
  //   固定等 400ms 可能读到的是**上一格**的值
  //   （实测：20% 那格读到 30 —— 上一格的值）。
  //   所以轮询等它**变成目标值**，最多等 2 秒；超时才算不通过。
  let v = null
  for (let i = 0; i < 20; i++) {
    await sleep(120)
    v = await realVolume()
    if (v !== null && Math.abs(v - s.expect) <= 2) break
  }
  const ok = v !== null && Math.abs(v - s.expect) <= 2
  if (!ok) allMatch = false
  detail.push(`${s.ratio * 100}%→期望${s.expect} 实得${v}`)
}
check(
  '真机拖动：每段系统音量都跟上（指针捕获生效）',
  allMatch,
  detail.join('；')
)

await mouse('up')
await sleep(900)
const afterUp = await realVolume()
check(
  '松手落在最终值（10%）',
  afterUp !== null && Math.abs(afterUp - 10) <= 2,
  `松手后系统音量=${afterUp}（期望 10）`
)

// ---------- 还原：音量 + 鼠标位置 ----------
// ⚠ 真机测试会动用户的鼠标、也真的改系统音量 —— 测完都得还原
const restoreRes = setRealVolume(original ?? 25)
await sleep(700)
const restored = await realVolume()
check(
  '测试后系统音量已还原',
  restored !== null && Math.abs(restored - (original ?? 25)) <= 1,
  `现在=${restored} 原值=${original}（独立进程设回：${restoreRes ? restoreRes.ok : '失败'}）`
)

if (cursorStart) {
  await mouse(`move ${cursorStart.x} ${cursorStart.y}`)
  const back = await mouse('get 0 0')
  check(
    '鼠标位置已还原',
    back.startsWith(`POS ${cursorStart.x} ${cursorStart.y}`),
    `现在=${back} 原位=${cursorStart.x},${cursorStart.y}`
  )
}

ps.kill()
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
