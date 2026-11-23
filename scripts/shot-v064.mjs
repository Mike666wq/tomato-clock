// v0.3.4 今日时间线的截图脚本。
//
// 用法：
//   1) 起开发版（独立 userData）：
//        $env:POMODORO_USER_DATA='<项目>\.tmp\shot'; pnpm dev
//   2) node scripts\shot-v064.mjs
//
// 拍三套主题各一张，外加"没数据"的空态一张。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const projectRoot = process.cwd()
const userData = process.env.E2E_DATA ?? path.join(projectRoot, '.tmp', 'shot', 'data.json')
const outDir = path.join(projectRoot, 'docs', 'shots')
const PREFIX = process.env.SHOT_PREFIX ?? 'v064'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function shot(ws, file, fullPage = false) {
  if (fullPage) {
    // 统计页内容滚在**内层容器**里，captureBeyondViewport 拍不到下面几块
    await send(ws, 'Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 1240,
      deviceScaleFactor: 1.5,
      mobile: false
    })
    await sleep(500)
  }
  const r = await send(ws, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`# saved ${path.relative(projectRoot, file)}`)
  if (fullPage) {
    await send(ws, 'Emulation.clearDeviceMetricsOverride')
    await sleep(300)
  }
}

const pathOf = (t) => {
  try {
    return new URL(t.url).pathname
  } catch {
    return t.url
  }
}

const pages = (await targets()).filter((t) => t.type === 'page')
const mainT = pages.find((t) => {
  const pathname = pathOf(t)
  return pathname === '/' || pathname.endsWith('index.html')
})
if (!mainT) {
  console.log('NO_MAIN_TARGET')
  process.exit(1)
}
const main = await connect(mainT.webSocketDebuggerUrl)

// ---------- 数据 ----------

const TOPICS = [
  {
    id: 'topic-os',
    name: '操作系统复习',
    color: '#7aa2f7',
    archived: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    order: 0
  },
  {
    id: 'topic-deep',
    name: '深度工作',
    color: '#5ac49b',
    archived: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    order: 1
  }
]

/** 造今天的一段 */
function at(h, m, durSec, over = {}) {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return {
    id: `s${h}-${m}`,
    kind: 'focus',
    startedAt: d.toISOString(),
    endedAt: new Date(d.getTime() + durSec * 1000).toISOString(),
    plannedSec: durSec,
    actualSec: durSec,
    pausedSec: 0,
    completed: true,
    task: '',
    interrupt: 'none',
    topicId: 'topic-os',
    topicNameSnapshot: '操作系统复习',
    ...over
  }
}

/** 一天的完整节奏：专注—休息—专注，看得出"节奏"才是这张图的价值 */
function daySessions() {
  return [
    at(0, 34, 1500, { task: '看教材' }),
    at(1, 0, 300, { kind: 'short', topicId: undefined, topicNameSnapshot: '' }),
    at(1, 6, 3000, { topicId: 'topic-deep', topicNameSnapshot: '深度工作' }),
    at(1, 56, 600, { kind: 'long', topicId: undefined, topicNameSnapshot: '' }),
    at(2, 6, 1500, { task: '写代码' }),
    at(2, 32, 300, { kind: 'short', topicId: undefined, topicNameSnapshot: '' }),
    at(9, 15, 2700, { topicId: 'topic-deep', topicNameSnapshot: '深度工作', task: '改那个 bug' }),
    at(9, 60, 300, { kind: 'short', topicId: undefined, topicNameSnapshot: '' }),
    at(10, 5, 1500, { task: '复习' }),
    at(14, 0, 600, { completed: false, actualSec: 600, plannedSec: 1500, interrupt: 'external' }),
    at(16, 30, 1500, { topicId: 'topic-deep', topicNameSnapshot: '深度工作' }),
    at(23, 50, 2400)
  ]
}

function writeSessions(list) {
  const cur = existsSync(userData) ? JSON.parse(readFileSync(userData, 'utf-8')) : null
  const next = {
    schemaVersion: 3,
    settings: cur?.settings ?? {},
    sessions: list
  }
  const tmp = `${userData}.shot.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, userData)
}

async function applySettings(over) {
  await evaluate(main, `window.pomodoro.settings.save(${JSON.stringify(over)})`)
  await sleep(500)
}

async function gotoStats() {
  await evaluate(main, "document.querySelectorAll('.nav__item')[0]?.click()")
  await sleep(250)
  await evaluate(main, "document.querySelectorAll('.nav__item')[1]?.click()")
  await sleep(900)
}

/** 提示条要藏不能删（删了 React 会抛 removeChild，整棵树崩） */
async function clearToast() {
  await evaluate(
    main,
    "document.querySelectorAll('.toast').forEach((el) => el.style.setProperty('display', 'none'))"
  )
}

// ---------- 拍图 ----------

console.log('# 今日时间线')
await applySettings({ topics: TOPICS, activeTopicId: 'topic-os' })

writeSessions(daySessions())
await gotoStats()
await clearToast()
await shot(main, path.join(outDir, `${PREFIX}-统计页-今日时间线-纸感.png`), true)

console.log('# 三套主题')
for (const theme of ['neon', 'ios']) {
  await applySettings({ uiTheme: theme })
  await gotoStats()
  await clearToast()
  const name = { paper: '纸感', neon: '霓虹', ios: '系统感' }[theme]
  await shot(main, path.join(outDir, `${PREFIX}-统计页-今日时间线-${name}.png`), true)
}
await applySettings({ uiTheme: 'paper' })

console.log('# 空态')
writeSessions([])
await gotoStats()
await clearToast()
await shot(main, path.join(outDir, `${PREFIX}-统计页-今日时间线-空态.png`), true)

console.log('# done')
process.exit(0)
