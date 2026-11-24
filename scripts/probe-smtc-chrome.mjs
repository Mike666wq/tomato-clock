// 对照实验：Chrome 在播本地 WAV 时，SMTC 能读到会话吗？
//
// 目的：**一次定性** ——
//   Chrome 会话出现 → 是 QQ 音乐 v12 不注册 provider（换数据源的问题）
//   Chrome 也没有   → 系统级 SMTC 通道坏了（必须自愈）
//
// 关键前提（2026-11-24 中午踩过的坑）：
//   **必须先确认 Chrome 真在放** —— 页面上的 currentTime 在走才算数。
//   "Chrome 窗口开着"不等于"Chrome 在放"。
//
// 用法：node scripts/probe-smtc-chrome.mjs

import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')

function smtcList() {
  const t0 = Date.now()
  try {
    const out = execFileSync(SMTC_EXE, ['list'], { encoding: 'utf-8', timeout: 20000 })
    const line = out.trim().split('\n').filter(Boolean).pop()
    return { ms: Date.now() - t0, parsed: JSON.parse(line) }
  } catch (e) {
    return { ms: Date.now() - t0, parsed: null, err: String(e.message ?? e) }
  }
}

// ---- 找 Chrome 的调试端口 ----
// 用 CDP 连不上普通 Chrome 窗口，所以直接问它 currentTime ——
// 办法：让页面把状态写到 document.title，再用窗口标题看。
// 更稳的办法：用 Chrome 的 --remote-debugging-port 另起一个实例。
const CDP_PORT = Number(process.env.SMTC_TEST_CDP_PORT ?? 9334)
// Chrome 不在 PATH 里，用完整路径
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(process.cwd(), '.tmp', 'chrome-smtc-p2')
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    'file:///' + path.join(process.cwd(), '.tmp', 'smtc-test.html').replace(/\\/g, '/')
  ],
  { stdio: 'ignore', detached: false }
)
chrome.on('error', (e) => {
  console.log(`CHROME_SPAWN_ERROR: ${e.message}`)
  process.exit(1)
})
await sleep(6000)

async function targets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
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
const page = pages.find((t) => t.url.includes('smtc-test'))
if (!page) {
  console.log('NO_CHROME_PAGE')
  chrome.kill()
  process.exit(1)
}
const ws = await connect(page.webSocketDebuggerUrl)

// ---- 前提：确认 Chrome 真在放 ----
const play = await evaluate(
  ws,
  `(() => {
    const a = document.getElementById('a')
    return { currentTime: a.currentTime, paused: a.paused, readyState: a.readyState, duration: a.duration }
  })()`
)
console.log(`[诊断] Chrome 音频状态：${JSON.stringify(play)}`)
await sleep(1500)
const play2 = await evaluate(
  ws,
  `(() => {
    const a = document.getElementById('a')
    return { currentTime: a.currentTime, paused: a.paused }
  })()`
)
console.log(`[诊断] 1.5 秒后：${JSON.stringify(play2)}`)
const reallyPlaying = play2.currentTime > play.currentTime && play2.paused === false
console.log(`[诊断] 真在播放 = ${reallyPlaying}`)

if (!reallyPlaying) {
  console.log('\nCHROME_NOT_PLAYING —— 前置不成立，这次对照无效。')
  chrome.kill()
  process.exit(2)
}

// ---- 对照：SMTC 能读到 Chrome 的会话吗 ----
const r = smtcList()
console.log(`\n=== smtc list（耗时 ${r.ms}ms）===`)
console.log(JSON.stringify(r.parsed))
const sessions = Array.isArray(r.parsed) ? r.parsed : []
console.log(`会话数 = ${sessions.length}`)
for (const s of sessions) {
  console.log(`  来源=${s.SourceAppId} 状态=${s.PlaybackState} 标题=${s.Title}`)
}
const chromeSession = sessions.find((s) =>
  String(s.SourceAppId ?? '').toLowerCase().includes('chrome')
)
console.log(`\n结论：Chrome 的 SMTC 会话 ${chromeSession ? '**出现了**' : '**没有出现**'}`)
console.log(
  chromeSession
    ? '→ 是 QQ 音乐 v12 不注册 provider（换数据源的问题）'
    : '→ 系统级 SMTC 通道坏了（必须自愈）'
)

chrome.kill()
process.exit(chromeSession ? 0 : 3)
