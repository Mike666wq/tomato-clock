// 灵动岛音量滑条的布局与行为测量（v0.3.6）。
//
// 规矩：**像素问题不许目测**（肥鱼立的）。
// 滑条的宽高、拇指位置、滚轮步进、拖动落值、3 秒收起 —— 全部量出来。
//
// 用法：先起开发版，再 node scripts\measure-vol.mjs
//
// ⚠ 测量会**真的改系统音量**（拖动/滚轮），测完恢复原值。

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 滚轮一格的步进（跟岛里的常量一致） */
const VOL_WHEEL_STEP_EXPECTED = 5

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

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

// 音量读数：**从岛的媒体状态读**（那就是 helper 读回来的系统音量）。
//
// ⚠ 别用另一个进程去读系统音量：Windows 的"默认输出设备"按角色/eMultimedia 选，
//   不同进程、不同时刻可能拿到**不同的设备**（蓝牙耳机 / 扬声器），
//   于是"写进去的"和"读出来的"对不上，测出来是假的失败（踩过）。
//   helper 自己写完会读回校验（不一致就 ok=false），所以它读到的就是真的。
async function uiVolume() {
  const v = await evaluate(island, `window.island?.media?.getVolume?.() ?? null`)
  return typeof v === 'number' ? v : null
}

// 系统音量（只用于最后把音量恢复回去 —— 那是"真系统音量"，用独立进程更直接）
const smtc = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')
function systemVolume() {
  try {
    return JSON.parse(execFileSync(smtc, ['vol', 'get'], { encoding: 'utf-8' })).value
  } catch {
    return null
  }
}

// ---- 连岛的页面（不是主窗口） ----
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

const originalVolume = await uiVolume()

// ---- 伪造一条"正在放歌"的媒体状态（开发版口子） ----
// 每 150ms 重播一次：helper 在没有音乐软件时会推空 state 把这一行冲掉，
// 所以测量期间要一直按住它。
await evaluate(
  island,
  `(() => {
    window.island.settings.save({ showMusicControl: true })
    window.__fake = setInterval(() => {
      window.island.media.devFake({
        source: 'Tencent.QQMusic',
        title: '繁星之梦',
        artist: '唐云歌',
        playing: true,
        volume: 35,
        volumeOk: true,
        pending: ''
      })
    }, 150)
    return true
  })()`
)

// ---- 把岛展开（悬停 120ms） ----
const islandBox = await evaluate(
  island,
  `(() => {
    const el = document.querySelector('.island')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`
)
if (!islandBox) {
  console.log('NO_ISLAND')
  process.exit(1)
}
await send(island, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: islandBox.x, y: islandBox.y })
// 直接用 API 展开，别赌 hover（岛是独立置顶窗口，CDP 的鼠标位置
// 不一定落在它上面，hover 展开时灵时不灵）
await evaluate(island, `window.island?.island?.setMode('expanded', true)`)
for (let i = 0; i < 30; i++) {
  await sleep(200)
  const expanded = await evaluate(island, `!!document.querySelector('.island--expanded')`)
  if (expanded) break
  await evaluate(island, `window.island?.island?.setMode('expanded', true)`)
}
const isExpanded = await evaluate(island, `!!document.querySelector('.island--expanded')`)
check('岛已展开', isExpanded === true, `island--expanded=${isExpanded}`)

const musicShown = await evaluate(island, `!!document.querySelector('.island__music')`)
check('音乐行出现（伪造的媒体状态生效）', musicShown === true, `island__music=${musicShown}`)
console.log(
  '  [探针] preload media 接口:',
  JSON.stringify(await evaluate(island, `Object.keys(window.island?.media ?? {})`))
)
console.log(
  '  [探针] setVolume 类型:',
  await evaluate(island, `typeof window.island?.media?.setVolume`)
)

/** 确保滑条是开着的（3 秒不动会自动收起，测量步骤一多就会被收掉） */
async function ensureVolOpen() {
  const open = await evaluate(island, `!!document.querySelector('.island__vol')`)
  if (open) return true
  await evaluate(island, `window.island?.island?.setMode('expanded', true)`)
  await sleep(300)
  const btn = await evaluate(
    island,
    `(() => {
      const b = [...document.querySelectorAll('.island__music-btn')].find((x) => x.getAttribute('aria-label') === '音量')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`
  )
  if (!btn) {
    console.log('  [探针] 找不到音量按钮（音乐行在不在：' +
      (await evaluate(island, `!!document.querySelector('.island__music')`)) + '）')
    return false
  }
  await send(island, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(btn.x), y: Math.round(btn.y), button: 'left', clickCount: 1 })
  await send(island, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(btn.x), y: Math.round(btn.y), button: 'left', clickCount: 1 })
  await sleep(350)
  return await evaluate(island, `!!document.querySelector('.island__vol')`)
}

// ---- 点喇叭 → 滑条出现 ----
const volBtn = await evaluate(
  island,
  `(() => {
    const btns = [...document.querySelectorAll('.island__music-btn')]
    const b = btns.find((x) => x.getAttribute('aria-label') === '音量')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`
)
if (!volBtn) {
  check('音量按钮出现（volumeOk=true 才显示）', false, '没找到音量按钮')
} else {
  check('音量按钮出现（volumeOk=true 才显示）', true, `位置 ${volBtn.x.toFixed(0)},${volBtn.y.toFixed(0)}`)
  await send(island, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(volBtn.x), y: Math.round(volBtn.y), button: 'left', clickCount: 1 })
  await send(island, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(volBtn.x), y: Math.round(volBtn.y), button: 'left', clickCount: 1 })
  await sleep(500)
}

const volInfo = await evaluate(
  island,
  `(() => {
    const vol = document.querySelector('.island__vol')
    if (!vol) return null
    const track = vol.querySelector('.island__vol-track')
    const thumb = vol.querySelector('.island__vol-thumb')
    const tr = track.getBoundingClientRect()
    const th = thumb.getBoundingClientRect()
    const music = document.querySelector('.island__music')
    const mr = music.getBoundingClientRect()
    return {
      trackH: tr.height,
      trackW: tr.width,
      thumbW: th.width,
      thumbH: th.height,
      thumbCenter: th.x + th.width / 2,
      trackLeft: tr.x,
      trackRight: tr.x + tr.width,
      musicH: mr.height,
      valueNow: vol.getAttribute('aria-valuenow')
    }
  })()`
)
if (!volInfo) {
  check('点喇叭后滑条出现', false, '没找到 .island__vol')
} else {
  check('点喇叭后滑条出现', true, `轨道 ${volInfo.trackW.toFixed(0)}×${volInfo.trackH.toFixed(0)}`)
  // 轨道 4px、拇指 12px —— 这是 **CSS px**，不用按宽度折算
  // （宽度不是缩放因子，之前拿 trackW/100 当缩放比是错的）
  check(
    '轨道高 = 4px、拇指 = 12px',
    Math.abs(volInfo.trackH - 4) < 0.6 && Math.abs(volInfo.thumbW - 12) < 0.6,
    `轨道高=${volInfo.trackH.toFixed(2)}（期望 4）拇指=${volInfo.thumbW.toFixed(2)}×${volInfo.thumbH.toFixed(2)}（期望 12）`
  )
  // 拇指位置 = 35%
  const expectCenter = volInfo.trackLeft + volInfo.trackW * 0.35
  check(
    '拇指位置在 35% 处',
    Math.abs(volInfo.thumbCenter - expectCenter) < 2,
    `拇指中心=${volInfo.thumbCenter.toFixed(2)} 期望=${expectCenter.toFixed(2)}`
  )
  check(
    '滑条占了歌名区的位置（行高不变）',
    Math.abs(volInfo.musicH - 42) < 12,
    `音乐行高=${volInfo.musicH.toFixed(1)}px（规格 42px 上下）`
  )
}

// ---- 滚轮 ±5%（基准是伪造状态里的 35，不是系统原值） ----
const FAKE_VOL = 35
const beforeWheel = await uiVolume()
await ensureVolOpen()
const volBox = await evaluate(
  island,
  `(() => {
    const v = document.querySelector('.island__vol')
    if (!v) return null
    const r = v.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`
)
if (volBox) {
  // React 的 onWheel 是原生 wheel 事件的委托，合成事件能触发；
  // 这里用页面内派发，避免 CDP 坐标落到别的窗口上（岛是独立窗口）
  await evaluate(
    island,
    `(() => {
      const v = document.querySelector('.island__vol')
      if (!v) return false
      v.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
      return true
    })()`
  )
  await sleep(900)
}
const afterWheel = await uiVolume()
const ariaAfter = await evaluate(island, `document.querySelector('.island__vol')?.getAttribute('aria-valuenow') ?? null`)
check(
  '滚轮往上 = 音量 +5（音量真的变了）',
  afterWheel === FAKE_VOL + VOL_WHEEL_STEP_EXPECTED,
  `音量 ${beforeWheel} → ${afterWheel}（伪造状态 ${FAKE_VOL} + 5 = ${FAKE_VOL + VOL_WHEEL_STEP_EXPECTED}）；滑条读数=${ariaAfter}`
)

// ---- 拖动：松手必须落最终值 ----
// 先在页面里挂计数器，看 mouse 事件到底有没有到（别猜）
await ensureVolOpen()
await evaluate(
  island,
  `(() => {
    window.__mc = { down: 0, move: 0, up: 0 }
    const v = document.querySelector('.island__vol')
    if (!v) return false
    v.addEventListener('mousedown', () => window.__mc.down++)
    v.addEventListener('mousemove', () => window.__mc.move++)
    v.addEventListener('mouseup', () => window.__mc.up++)
    return true
  })()`
)
const dragBox = await evaluate(
  island,
  `(() => {
    const t = document.querySelector('.island__vol-track')
    if (!t) return null
    const r = t.getBoundingClientRect()
    return { left: r.x, right: r.x + r.width, y: r.y + r.height / 2, w: r.width }
  })()`
)
await ensureVolOpen()
const dragOpen = await evaluate(island, `!!document.querySelector('.island__vol')`)
check('拖动前滑条还在（没被 3 秒规则收掉）', dragOpen === true, `滑条=${dragOpen}`)
if (dragBox) {
  const toX = (p) => Math.round(dragBox.left + dragBox.w * p)
  // 只用**真实鼠标事件**驱动岛自己的实现 —— 不要在页面里另绑一套监听，
  // 两套同时改音量会互相打架，测出来的数是乱的（踩过）。
  await send(island, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: toX(0.8), y: Math.round(dragBox.y), button: 'left', clickCount: 1 })
  await sleep(150)
  const afterManualDown = await uiVolume()
  for (const p of [0.5, 0.3, 0.2]) {
    await send(island, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX(p), y: Math.round(dragBox.y), button: 'left', buttons: 1 })
    await sleep(80)
  }
  await send(island, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX(0.2), y: Math.round(dragBox.y), button: 'left', clickCount: 1 })
  await sleep(900)
  globalThis.__afterReal = afterManualDown
  console.log(`  [探针] 按下 80% 之后读到系统音量=${afterManualDown}`)

  // 最后一项：同一段代码，用**页面内合成的 mousemove** 驱动。
  // 如果合成事件能让音量跟着走、而 CDP 的真实 mousemove 不能，
  // 那就说明问题在"CDP 往独立置顶窗口派发拖动事件"这条路，
  // 而不是实现本身 —— 但这仍不等于真机通过，要如实说。
  await ensureVolOpen()
  const box2 = await evaluate(
    island,
    `(() => {
      const t = document.querySelector('.island__vol-track')
      if (!t) return null
      const r = t.getBoundingClientRect()
      return { left: r.x, w: r.width, y: r.y + r.height / 2 }
    })()`
  )
  if (box2) {
    await evaluate(
      island,
      `(() => {
        const el = document.querySelector('.island__vol')
        const t = document.querySelector('.island__vol-track')
        if (!el || !t) return false
        const r = t.getBoundingClientRect()
        const at = (p) => r.x + r.width * p
        const fire = (type, x, buttons) => {
          el.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: r.y + r.height / 2, buttons
          }))
        }
        fire('mousedown', at(0.8), 1)
        fire('mousemove', at(0.5), 1)
        fire('mousemove', at(0.3), 1)
        fire('mousemove', at(0.2), 1)
        fire('mouseup', at(0.2), 0)
        return true
      })()`
    )
    await sleep(900)
    globalThis.__afterSynthetic = await uiVolume()
    console.log(`  [探针] 合成 mousemove 走完之后音量=${globalThis.__afterSynthetic}`)
  }
}
const afterDrag = await uiVolume()
const mc = await evaluate(island, `window.__mc ?? null`)
check(
  '拖动松手落在最终值（20%），不是停在途中的某个数',
  afterDrag !== null && Math.abs(afterDrag - 20) <= 1,
  `音量=${afterDrag}（期望 20）；按下 80% 后读到=${globalThis.__afterReal}；mouse 计数=${JSON.stringify(mc)}`
)

// ---- 3 秒不动自动收起 ----
await sleep(3200)
const stillOpen = await evaluate(island, `!!document.querySelector('.island__vol')`)
check('3 秒不动后滑条自动收起', stillOpen === false, `滑条还在=${stillOpen}`)

// ---- 恢复音量（走同一条链路写回去，再用读回确认） ----
await evaluate(island, `window.island?.media?.setVolume?.(${originalVolume ?? 25})`)
await sleep(1000)
let restored = await uiVolume()
for (let i = 0; i < 5 && restored !== originalVolume; i++) {
  await evaluate(island, `window.island?.media?.setVolume?.(${originalVolume ?? 25})`)
  await sleep(500)
  restored = await uiVolume()
}
check(
  '测试后音量已恢复原值（读回确认，不靠推送时序）',
  restored === originalVolume,
  `现在=${restored} 原值=${originalVolume}（独立进程读到的系统音量=${systemVolume()}）`
)

await evaluate(island, `clearInterval(window.__fake)`)
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
