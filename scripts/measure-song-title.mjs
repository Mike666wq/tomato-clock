// 真机验证：**歌名能不能显示出来**（2026-11-24 下午，v0.3.7 追加）。
//
// 背景：用户说「这里音乐还是不显示啊」。
//   QQ 音乐这一版（内核 qmbrowser.exe）不再向 Windows 报告 SMTC 会话，
//   所以官方接口读不到歌名。
//   但 QQMusic.exe **有个主窗口，标题就是「歌名 - 歌手」**
//   （class='QQMusic_Daemon_Wnd'），切歌立刻跟着变。
//   这一版加了这个兜底。
//
// 验的：
//   1. 界面上真的显示出歌名了（不是空的）
//   2. 歌手也在
//   3. 歌名来自窗口标题（titleSource='window'）
//   4. **切歌后歌名跟着变**（这条最关键 —— 不跟就是假的）
//   5. 方向图标跟真实声音一致
//
// 用法：node scripts\measure-song-title.mjs
//
// ⚠ 会按一次「下一首」（切用户的歌），测完不再切回去。

import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

/** 独立进程读 helper 的 watch 状态（真相源） */
function helperState() {
  return new Promise((resolve) => {
    const p = spawn(SMTC_EXE, ['watch'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    const done = (state) => {
      try {
        p.kill()
      } catch {
        /* 已经退了 */
      }
      resolve(state)
    }
    const timer = setTimeout(() => done(null), 8000)
    p.stdout.setEncoding('utf-8')
    p.stdout.on('data', (chunk) => {
      buf += chunk
      let i = buf.indexOf('\n')
      while (i >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        i = buf.indexOf('\n')
        if (!line) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.kind === 'state') {
            clearTimeout(timer)
            done(parsed)
            return
          }
        } catch {
          /* 不是 JSON，跳过 */
        }
      }
    })
  })
}

// ---------- CDP ----------
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
const mouse = (cmd) =>
  new Promise((resolve) => {
    psWaiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })

async function currentBounds() {
  return await evaluate(island, `(async () => await window.island?.island?.devBounds?.())()`)
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
await sleep(1200)

// ⚠ **必须把开发实例挪开**：用户自己装的那份 0.3.6 也在跑，
//   两个岛都在屏幕正上方中央（x 都在 783 附近）——
//   真机鼠标点屏幕坐标时，命中的是**谁的窗口**不确定。
//   命中用户那份的话，读到的是**旧的 helper**（它发的是 "window-title"），
//   界面上测出来的东西跟开发版没关系。
//
//   （2026-11-24 踩过：界面上的 titleSource 一直是空的，
//    因为点的是用户那份 0.3.6 的岛。）
await evaluate(island, `window.island?.island?.devOffset?.(-500); true`)
await sleep(500)

const expanded = await ensureExpanded()
check('岛已悬停展开', expanded === true, `expanded=${expanded}`)
if (!expanded) {
  ps.kill()
  process.exit(1)
}

// 等真状态（歌名是每轮询从 helper 来的，最多等 5 秒）
let ui = null
for (let i = 0; i < 20; i++) {
  await sleep(500)
  ui = await evaluate(
    island,
    `(() => {
      const t = document.querySelector('.island__music-title')
      const a = document.querySelector('.island__music-artist')
      const btns = [...document.querySelectorAll('.island__music-btn')]
      const pp = btns.find((x) => {
        const l = x.getAttribute('aria-label') || ''
        return l === '播放' || l === '暂停' || l === '播放/暂停'
      })
      return {
        title: t ? t.textContent : null,
        artist: a ? a.textContent : null,
        playPauseLabel: pp ? pp.getAttribute('aria-label') : null,
        state: null
      }
    })()`
  )
  if (ui && ui.title) break
}
const appState = await evaluate(island, `(async () => await window.island?.media?.getState?.())()`)
console.log(`  [诊断] 界面：${JSON.stringify(ui)}`)
console.log(`  [诊断] 主进程状态：${JSON.stringify(appState)}`)

const helper = await helperState()
console.log(`  [诊断] 独立进程读的 helper 状态：${JSON.stringify(helper)}`)

check('界面上显示出歌名了', !!ui?.title, `title=${JSON.stringify(ui?.title)}`)
check('界面上显示出歌手了', !!ui?.artist, `artist=${JSON.stringify(ui?.artist)}`)
check(
  '歌名来自窗口标题兜底（titleSource=window）',
  appState?.titleSource === 'window',
  `titleSource=${appState?.titleSource}`
)
check(
  'helper 独立进程读到同样的歌名（不是界面自说自话）',
  !!helper?.title && helper.title === ui?.title,
  `helper=${JSON.stringify(helper?.title)} 界面=${JSON.stringify(ui?.title)}`
)

// ---------- 切歌 → 歌名跟着变（最关键的一条）----------
const beforeTitle = ui?.title ?? ''
try {
  execFileSync(SMTC_EXE, ['next'], { encoding: 'utf-8', timeout: 15000 })
} catch {
  console.log('  [诊断] 发「下一首」失败')
}
let afterTitle = ''
let changed = false
for (let i = 0; i < 25; i++) {
  await sleep(400)
  const t = await evaluate(island, `(() => {
    const t = document.querySelector('.island__music-title')
    return t ? t.textContent : null
  })()`)
  afterTitle = t ?? ''
  if (afterTitle && afterTitle !== beforeTitle) {
    changed = true
    break
  }
}
check(
  '切歌后岛上的歌名跟着变（这条最关键）',
  changed === true,
  `切之前="${beforeTitle}" 切之后="${afterTitle}"`
)

// 方向图标也要跟真实声音一致
const audioNow = await helperState()
console.log(`  [诊断] 切歌后的 helper 状态：${JSON.stringify(audioNow)}`)
if (audioNow && audioNow.audioPlaying !== null && audioNow.audioPlaying !== undefined) {
  const expect = audioNow.audioPlaying ? '暂停' : '播放'
  check(
    `方向图标跟真实声音一致（真实在放=${audioNow.audioPlaying} → 「${expect}」）`,
    ui?.playPauseLabel === expect || (await evaluate(island, `(() => {
      const pp = [...document.querySelectorAll('.island__music-btn')].find((x) => {
        const l = x.getAttribute('aria-label') || ''
        return l === '播放' || l === '暂停' || l === '播放/暂停'
      })
      return pp ? pp.getAttribute('aria-label') : null
    })()`)) === expect,
    `期望=${expect}`
  )
}

ps.kill()
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
