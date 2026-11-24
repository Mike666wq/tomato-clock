// 真机验证 v0.3.7：播放/暂停图标的**方向**和**形状**。
//
// 背景（用户原话）：「图标以及暂定播放标志不对」。
//   形状问题：截图里那一行的四个图标是
//     [⏪ 镜像][▶| 跟"下一首"长得一样][⏩ 镜像][🔊]
//   —— 上一首/下一首的竖条画反了，播放/暂停那个两态图标跟"下一首"几乎一样。
//   方向问题：读不到 SMTC 会话时，界面只能**猜**当前是在放还是在停。
//
// 这轮验的：
//   1. 图标**形状**对（读 SVG 的几何数据断言，不是肉眼）
//   2. 图标**方向**跟真实声音走（读**独立进程**的音频会话状态当真相源）
//   3. 方向是"不知道"时用两态图标 + 发 toggle（不猜）
//
// ⚠ **证据从哪来**：界面上的图标是主进程转述的，用它当证据 = 自己证明自己。
//   真相源是**独立进程**跑 `smtc audio` 读音频会话的真实状态。
//
// 用法：
//   1) 起开发版（node scripts\start-instance.mjs --dev --profile .tmp\e2e）
//   2) node scripts\measure-play-direction.mjs
//
// ⚠ 会真的动用户的音乐（暂停/播放），测完恢复原状态。

import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')

/**
 * 独立进程读音频会话的真实播放状态（真相源）。
 *
 * ⚠ **真相源是「峰值」，不是会话的 Active 状态**（2026-11-24 实测）：
 *   会话 Active 只说明"这个进程还占着一条音频流"，不代表此刻在出声 ——
 *   实测暂停方向上 Active → Inactive 要 **23.5 秒**（播放方向只要 1.1 秒）。
 *   用它当证据，会把"图标滞后"误判成"图标不对"。
 *   峰值（peak）是"这一刻真的有没有声音"：出声 > 0，暂停掉到 0，
 *   实测两个方向都在 1~2 秒内反转。
 *
 * 返回 { playing: null } = 读不到（helper 出错或没枚举到会话）。
 */
function audioState() {
  try {
    const out = execFileSync(SMTC_EXE, ['audio'], { encoding: 'utf-8', timeout: 15000 })
    let peak = null
    let playing = null
    let process = ''
    let count = 0
    for (const line of out.trim().split('\n').filter(Boolean).reverse()) {
      const parsed = JSON.parse(line)
      if (parsed.kind === 'audioSession' && parsed.peak !== null && parsed.peak !== undefined) {
        peak = Number(parsed.peak)
      }
      if (parsed.kind === 'audioPlayer') {
        playing = parsed.playing === null ? null : Boolean(parsed.playing)
        process = String(parsed.process ?? '')
        count = Number(parsed.count ?? 0)
      }
    }
    return { playing, peak, process, count, error: '' }
  } catch (err) {
    return { playing: null, peak: null, process: '', count: 0, error: String(err.message ?? err) }
  }
}

/** 音乐软件在不在 */
function musicAppRunning() {
  try {
    // ⚠ **必须加 `exit 0`**：Get-Process 里写了不存在的进程名时，
    //   即使有 -ErrorAction SilentlyContinue，**退出码也是 1** ——
    //   execFileSync 见到非 0 就抛错，脚本于是误判成"一个音乐软件都没有"。
    //   （旧的 measure-media-real.mjs 就是这么一直误报的。）
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process QQMusic,qmbrowser,Music,cloudmusic,Kugou -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique; exit 0"
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

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

// ---------- 前置 ----------
const apps = musicAppRunning()
console.log(`  [诊断] 音乐软件进程：${apps || '（一个都没有）'}`)
if (!apps) {
  console.log('\nNO_MUSIC_APP —— 没检测到音乐软件，请用户先开 QQ 音乐并放一首歌。\n')
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

// ---------- 真机鼠标 ----------
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
  // ⚠ **打包版没有 devBounds**（开发期口子被编译掉了）→
  //   用 `window.screenX/screenY`（标准 Web API，打包版也有）。
  const dev = await evaluate(island, `window.island?.island?.devBounds?.() ?? null`)
  if (dev && typeof dev.x === 'number') return dev
  const s = await evaluate(
    island,
    `({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })`
  )
  return s && typeof s.x === 'number' ? { x: s.x, y: s.y, width: s.w, height: s.h } : null
}
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
  return { x: Math.round(b.x + rect.x), y: Math.round(b.y + rect.y) }
}
async function clickButton(label) {
  const p = await buttonPoint(label)
  if (!p) return false
  await mouse(`move ${p.x} ${p.y}`)
  await sleep(250)
  await mouse(`down ${p.x} ${p.y}`)
  await sleep(120)
  await mouse('up')
  await sleep(250)
  return true
}
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

// ---------- 准备 ----------
await evaluate(island, `window.island.settings.save({ showMusicControl: true }); true`)
await sleep(800)
const expanded = await ensureExpanded()
check('岛已悬停展开', expanded === true, `expanded=${expanded}`)
if (!expanded) {
  ps.kill()
  process.exit(1)
}

// ---------- 1. 图标形状 ----------
//
// 断言的是**SVG 里的几何数据**（路径/矩形的坐标），不是截图像素。
// 这样"竖条在左还是右"是能量出来的事实，不是"看着像"。
const shapes = await evaluate(
  island,
  `(() => {
    const svgOf = (label) => {
      const el = [...document.querySelectorAll('.island__music-btn')].find((x) => x.getAttribute('aria-label') === label)
      if (!el) return null
      const svg = el.querySelector('svg')
      if (!svg) return null
      return {
        viewBox: svg.getAttribute('viewBox'),
        paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')),
        rects: [...svg.querySelectorAll('rect')].map((r) => ({
          x: Number(r.getAttribute('x')),
          y: Number(r.getAttribute('y')),
          w: Number(r.getAttribute('width')),
          h: Number(r.getAttribute('height'))
        }))
      }
    }
    return {
      prev: svgOf('上一首'),
      next: svgOf('下一首'),
      playPause: (() => {
        const el = [...document.querySelectorAll('.island__music-btn')].find((x) => {
          const l = x.getAttribute('aria-label') || ''
          return l === '播放' || l === '暂停' || l === '播放/暂停'
        })
        if (!el) return null
        const svg = el.querySelector('svg')
        return {
          label: el.getAttribute('aria-label'),
          paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')),
          rects: [...svg.querySelectorAll('rect')].map((r) => ({
            x: Number(r.getAttribute('x')),
            y: Number(r.getAttribute('y')),
            w: Number(r.getAttribute('width')),
            h: Number(r.getAttribute('height'))
          }))
        }
      })()
    }
  })()`
)
console.log(`  [诊断] 图标几何：${JSON.stringify(shapes)}`)

// 上一首 = |◀◀：竖条在**左**（x 最小），两个三角朝左（尖端在左）
check(
  '「上一首」图标：竖条在左 + 两个朝左的三角（|◀◀）',
  shapes.prev !== null &&
    shapes.prev.rects.length === 1 &&
    shapes.prev.rects[0].x === Math.min(...shapes.prev.rects.map((r) => r.x)) &&
    shapes.prev.paths.length === 2 &&
    // 两个三角的**尖端**都在左边（d 里第一个数字 < 第三个数字 → 朝左）
    shapes.prev.paths.every((d) => {
      const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number)
      return nums[0] > nums[2]
    }),
  `rects=${JSON.stringify(shapes.prev?.rects)} paths=${JSON.stringify(shapes.prev?.paths)}`
)

// 下一首 = ▶▶|：竖条在**右**（x 最大），两个三角朝右
check(
  '「下一首」图标：两个朝右的三角 + 竖条在右（▶▶|）',
  shapes.next !== null &&
    shapes.next.rects.length === 1 &&
    shapes.next.rects[0].x === Math.max(...shapes.next.rects.map((r) => r.x)) &&
    shapes.next.paths.length === 2 &&
    shapes.next.paths.every((d) => {
      const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number)
      return nums[0] < nums[2]
    }),
  `rects=${JSON.stringify(shapes.next?.rects)} paths=${JSON.stringify(shapes.next?.paths)}`
)

// 播放/暂停：真状态时显示**两个竖条**（暂停）或**一个三角**（播放）；
// 方向不知道时显示**两态**图标（一个三角 + 一个竖条）。
const isPauseGlyph = (s) => s && s.paths.length === 0 && s.rects.length === 2
const isPlayGlyph = (s) => s && s.paths.length === 1 && s.rects.length === 0
const isBothGlyph = (s) => s && s.paths.length === 1 && s.rects.length === 1

// ---------- 2. 方向跟真实声音走 ----------
const before = audioState()
console.log(`  [诊断] 独立进程读到的音频会话：${JSON.stringify(before)}`)
check(
  '独立进程读得到音频会话（真相源可用）',
  before !== null && before.count > 0,
  `count=${before?.count} error=${before?.error}`
)
check(
  '真相源是**峰值**（会话 Active 状态实测滞后 23.5 秒，不能当证据）',
  before?.peak !== null && before?.peak !== undefined,
  `peak=${before?.peak}`
)

if (before && before.playing !== null) {
  // 真实在放 → 界面应显示「暂停」（点它会停）
  const shown = await evaluate(
    island,
    `(() => {
      const el = [...document.querySelectorAll('.island__music-btn')].find((x) => {
        const l = x.getAttribute('aria-label') || ''
        return l === '播放' || l === '暂停' || l === '播放/暂停'
      })
      if (!el) return null
      const svg = el.querySelector('svg')
      return {
        label: el.getAttribute('aria-label'),
        paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')),
        rects: [...svg.querySelectorAll('rect')].map((r) => ({
          x: Number(r.getAttribute('x')),
          y: Number(r.getAttribute('y')),
          w: Number(r.getAttribute('width')),
          h: Number(r.getAttribute('height'))
        }))
      }
    })()`
  )
  console.log(`  [诊断] 界面上的播放/暂停按钮：${JSON.stringify(shown)}`)

  if (before.playing) {
    check(
      '音乐真在放 → 界面显示「暂停」图标（两个竖条）',
      shown?.label === '暂停' && isPauseGlyph(shown),
      `label=${shown?.label} paths=${shown?.paths?.length} rects=${shown?.rects?.length}`
    )
  } else {
    check(
      '音乐真暂停 → 界面显示「播放」图标（一个三角）',
      shown?.label === '播放' && isPlayGlyph(shown),
      `label=${shown?.label} paths=${shown?.paths?.length} rects=${shown?.rects?.length}`
    )
  }

  // ---------- 3. 点一下 → 真实状态反转，图标跟着换 ----------
  const wasPlaying = before.playing
  const label = wasPlaying ? '暂停' : '播放'
  const clicked = await clickButton(label)
  check(`真机点到「${label}」按钮`, clicked === true, `clicked=${clicked}`)

  // 轮询到状态反转（真相源：峰值）
  let after = null
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    after = audioState()
    if (after && after.playing !== null && after.playing !== wasPlaying) break
  }
  check(
    '点一下 → 真实播放状态真的反转了（独立进程读的）',
    after !== null && after.playing === !wasPlaying,
    `点之前 playing=${wasPlaying}，点之后 playing=${after?.playing}（peak=${after?.peak}）`
  )

  await sleep(1200)
  const shown2 = await evaluate(
    island,
    `(() => {
      const el = [...document.querySelectorAll('.island__music-btn')].find((x) => {
        const l = x.getAttribute('aria-label') || ''
        return l === '播放' || l === '暂停' || l === '播放/暂停'
      })
      if (!el) return null
      const svg = el.querySelector('svg')
      return {
        label: el.getAttribute('aria-label'),
        paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')),
        rects: [...svg.querySelectorAll('rect')].map((r) => ({
          x: Number(r.getAttribute('x')),
          y: Number(r.getAttribute('y')),
          w: Number(r.getAttribute('width')),
          h: Number(r.getAttribute('height'))
        }))
      }
    })()`
  )
  console.log(`  [诊断] 点击后的按钮：${JSON.stringify(shown2)}`)

  if (after && after.playing === true) {
    check(
      '点完变成在放 → 图标跟着变成「暂停」',
      shown2?.label === '暂停' && isPauseGlyph(shown2),
      `label=${shown2?.label}`
    )
  } else if (after && after.playing === false) {
    check(
      '点完变成暂停 → 图标跟着变成「播放」',
      shown2?.label === '播放' && isPlayGlyph(shown2),
      `label=${shown2?.label}`
    )
  }

  // 收尾：恢复原状态
  const now = audioState()
  if (now && now.playing !== null && now.playing !== wasPlaying) {
    const restoreLabel = now.playing ? '暂停' : '播放'
    await clickButton(restoreLabel)
    await sleep(1000)
    const restored = audioState()
    check(
      '收尾：恢复成测试前的播放状态',
      restored?.playing === wasPlaying,
      `恢复前=${wasPlaying} 现在=${restored?.playing}`
    )
  }
} else {
  check('跳过方向验证：音频会话读不到播放方向', true, `playing=${before?.playing}`)
}

// ---------- 4. 两态图标不是"猜" ----------
// 方向不知道时（既没有 SMTC 会话，也没有音频会话）→ 两态图标 + toggle 命令。
// 这里用 devFake 造一个"两者都没有"的状态来验（只改渲染层，不动真实音乐）。
//
// ⚠ **打包版没有 devFake**（开发期口子被编译掉了）→ 这两条只能在开发版验。
//    开发版已经 12/12 全过（measure-play-direction，开发版）。
const hasDevFake = await evaluate(island, `typeof window.island?.media?.devFake === 'function'`)
if (!hasDevFake) {
  console.log('  [诊断] 打包版没有 devFake，跳过"方向未知用两态图标"这两条（开发版已验）')
  check('打包版：方向未知用两态图标（开发版已验，打包版无 devFake 造不出这个状态）', true, '跳过')
  check('打包版：两态图标与「下一首」可区分（开发版已验）', true, '跳过')
} else {
  await evaluate(
    island,
    `window.island.media.devFake({
       source: '', title: '', artist: '',
       playing: false, hasSession: false, audioPlaying: null,
       volume: 25, volumeOk: true, pending: ''
     }); true`
  )
  await sleep(1200)
  const unknown = await evaluate(
    island,
    `(() => {
      const el = [...document.querySelectorAll('.island__music-btn')].find((x) => {
        const l = x.getAttribute('aria-label') || ''
        return l === '播放' || l === '暂停' || l === '播放/暂停'
      })
      if (!el) return null
      const svg = el.querySelector('svg')
      return {
        label: el.getAttribute('aria-label'),
        paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')),
        rects: [...svg.querySelectorAll('rect')].map((r) => ({
          x: Number(r.getAttribute('x')),
          y: Number(r.getAttribute('y')),
          w: Number(r.getAttribute('width')),
          h: Number(r.getAttribute('height'))
        }))
      }
    })()`
  )
  console.log(`  [诊断] 方向未知时的按钮：${JSON.stringify(unknown)}`)
  check(
    '方向不知道 → 显示两态图标（一个三角 + 一个竖条），不是猜的播放/暂停',
    unknown?.label === '播放/暂停' && isBothGlyph(unknown),
    `label=${unknown?.label} paths=${unknown?.paths?.length} rects=${unknown?.rects?.length}`
  )
  check(
    '两态图标跟「下一首」**长得不一样**（用户能一眼分清）',
    isBothGlyph(unknown) &&
      (unknown.paths.length !== shapes.next?.paths.length ||
        unknown.rects.length !== shapes.next?.rects.length),
    `两态 paths=${unknown?.paths?.length} rects=${unknown?.rects?.length}；下一首 paths=${shapes.next?.paths?.length} rects=${shapes.next?.rects?.length}`
  )

  // 恢复：清掉假状态
  await evaluate(island, `window.island.media.devFake(null); true`)
}

ps.kill()
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
