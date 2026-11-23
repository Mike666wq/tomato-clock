// v0.6 这一轮的截图脚本：统计页四张 + 三套主题 + 灵动岛（主题/音乐行）。
//
// 用法：
//   1) 起开发版（独立 userData）：
//        $env:POMODORO_USER_DATA='<项目>\.tmp\shot'; pnpm dev
//   2) node scripts\shot-v062.mjs
//
// 图都落在 docs/shots/ 下。
//
// 两个要注意的地方：
//   - **记录**可以直接写磁盘（统计页每次都重新读文件）；
//     **设置**不行 —— 主进程把设置缓存在内存里，直接改文件它不知道，
//     所以设置一律走应用自己的 settings.save（它会广播给所有窗口）。
//   - 截图前把提示条摘掉：快捷键注册失败那条提示（用户的正式版正占着快捷键）
//     会盖住数字卡，拍出来没法看。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const projectRoot = process.cwd()
const userData = process.env.E2E_DATA ?? path.join(projectRoot, '.tmp', 'shot', 'data.json')
const outDir = path.join(projectRoot, 'docs', 'shots')
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
    // 统计页的内容滚在**内层容器**里（不是文档），
    // 所以 captureBeyondViewport 拍不到下面几块 ——
    // 改用视口模拟把页面拉高，一屏装下全部内容。
    await send(ws, 'Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 1120,
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
const mainT = pages.find((p) => pathOf(p) === '/' || pathOf(p).endsWith('index.html'))
const islandT = pages.find((p) => pathOf(p).includes('island'))
if (!mainT) {
  console.log('NO_MAIN_TARGET')
  process.exit(1)
}
const main = await connect(mainT.webSocketDebuggerUrl)
const island = islandT ? await connect(islandT.webSocketDebuggerUrl) : null

// ---------- 数据 ----------

const TOPICS = [
  {
    id: 'topic-deep',
    name: '深度工作',
    color: '#5ac49b',
    archived: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    order: 0
  },
  {
    id: 'topic-os',
    name: '操作系统复习',
    color: '#7aa2f7',
    archived: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    order: 1
  }
]

/** 一条专注记录 */
function focus(daysAgo, hour, minutes, topicId, completed = true, task = '') {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 5, 0, 0)
  return {
    id: `shot-${daysAgo}-${hour}-${minutes}-${topicId ?? 'none'}`,
    kind: 'focus',
    startedAt: d.toISOString(),
    endedAt: new Date(d.getTime() + minutes * 60 * 1000).toISOString(),
    plannedSec: minutes * 60,
    actualSec: minutes * 60,
    pausedSec: 0,
    completed,
    task,
    interrupt: completed && minutes > 30 ? 'internal' : 'none',
    topicId: topicId ?? undefined,
    topicNameSnapshot: topicId ? TOPICS.find((t) => t.id === topicId)?.name ?? '' : ''
  }
}

/** 一条休息记录 */
function brk(daysAgo, hour, minutes) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 5, 0, 0)
  return {
    id: `shot-brk-${daysAgo}-${hour}`,
    kind: 'short',
    startedAt: d.toISOString(),
    endedAt: new Date(d.getTime() + minutes * 60 * 1000).toISOString(),
    plannedSec: minutes * 60,
    actualSec: minutes * 60,
    pausedSec: 0,
    completed: true,
    task: '',
    interrupt: 'none'
  }
}

const SCENARIOS = {
  /** 有数据：7 天里都有番茄，两个主题，一段被跳过 */
  full: () => [
    focus(0, 9, 25, 'topic-deep', true, '写代码'),
    focus(0, 14, 45, 'topic-os', true, '看教材'),
    focus(1, 10, 50, 'topic-deep', true),
    focus(1, 16, 25, 'topic-os', true),
    focus(2, 9, 25, 'topic-deep', true),
    focus(2, 15, 30, 'topic-os', false, '被打断了'),
    focus(3, 11, 60, 'topic-deep', true),
    focus(4, 20, 20, 'topic-os', true),
    focus(5, 9, 35, 'topic-deep', true),
    focus(6, 13, 25, 'topic-os', true),
    brk(0, 10, 5),
    brk(1, 11, 5)
  ],
  /** 全部空数据 */
  empty: () => [],
  /** 只有今天有数据 */
  today: () => [focus(0, 18, 21, 'topic-deep', true)],
  /** 主题缺失：今天的番茄都没挂主题 */
  notopic: () => [focus(0, 9, 25, null, true, '没挂主题'), focus(0, 20, 15, null, true)]
}

/** 只换记录（统计页每次都重新读文件） */
function writeSessions(name) {
  const data = existsSync(userData) ? JSON.parse(readFileSync(userData, 'utf-8')) : null
  const next = {
    schemaVersion: 3,
    settings: data?.settings ?? {},
    sessions: SCENARIOS[name]()
  }
  const tmp = `${userData}.shot.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, userData)
}

/** 设置一律走应用自己的接口（它内存里缓存着设置） */
async function applySettings(over) {
  await evaluate(main, `window.pomodoro.settings.save(${JSON.stringify(over)})`)
  await sleep(500)
}

/** 切到统计页并重新拉一次数据 */
async function gotoStats() {
  await evaluate(main, "document.querySelectorAll('.nav__item')[0]?.click()")
  await sleep(250)
  await evaluate(main, "document.querySelectorAll('.nav__item')[1]?.click()")
  await sleep(900)
}

/**
 * 把提示条藏起来：快捷键那条提示（用户的正式版正占着快捷键）会盖住数字卡。
 *
 * **只能藏，不能删** —— 提示条是 React 管的节点，
 * 直接 removeChild 会让 React 后面再动它时抛
 * "Failed to execute 'removeChild' on 'Node'"，整棵界面树当场崩掉（拍出来一片空白）。
 */
async function clearToast() {
  await evaluate(
    main,
    "document.querySelectorAll('.toast').forEach((el) => el.style.setProperty('display', 'none'))"
  )
}

// ---------- 拍图 ----------

console.log('# 统计页')
// 主题列表要走应用自己的接口：主进程把设置缓存在内存里，
// 直接改文件它不知道，统计页就会把有主题的记录也算成"未分类"。
await applySettings({ topics: TOPICS, activeTopicId: 'topic-deep' })
for (const [name, label] of [
  ['full', '有数据'],
  ['empty', '全空'],
  ['today', '只有今天'],
  ['notopic', '主题缺失']
]) {
  writeSessions(name)
  await gotoStats()
  await clearToast()
  await shot(main, path.join(outDir, `v062-统计页-${label}.png`), true)
}

console.log('# 三套主题下的统计页')
writeSessions('full')
for (const theme of ['paper', 'neon', 'ios']) {
  await applySettings({ uiTheme: theme })
  await gotoStats()
  await clearToast()
  const name = { paper: '纸感', neon: '霓虹', ios: '系统感' }[theme]
  await shot(main, path.join(outDir, `v062-统计页-${name}.png`), true)
}
await applySettings({ uiTheme: 'paper' })

if (island) {
  console.log('# 灵动岛')
  // 先把音乐状态清掉：上一次的假数据还留在内存里，
  // 不清的话"没有主题/有主题"这两张会带着音乐行，看不清主题那部分
  await evaluate(island, 'window.island.media.devFake(null)')
  await sleep(300)
  // 展开态：鼠标移上去（这是它真实的展开方式）
  const hover = async () => {
    await send(island, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 20 })
    await sleep(600)
  }

  // ① 没选主题 → 显示「＋ 主题」
  await applySettings({ activeTopicId: null })
  await hover()
  await shot(island, path.join(outDir, 'v062-灵动岛-没有主题.png'))

  // ② 选了主题
  await applySettings({ activeTopicId: 'topic-deep' })
  await sleep(400)
  await hover()
  await shot(island, path.join(outDir, 'v062-灵动岛-有主题.png'))

  // ③ 音乐行：播放中 / 暂停 / 长歌名截断
  await applySettings({ showMusicControl: true })
  const fake = async (state) => {
    await evaluate(island, `window.island.media.devFake(${JSON.stringify(state)})`)
    await sleep(400)
    await hover()
  }
  await fake({ source: 'QQMusic', title: '夏日约定', artist: 'JINBAO', playing: true })
  await shot(island, path.join(outDir, 'v062-灵动岛-音乐-播放中.png'))

  await fake({ source: 'QQMusic', title: '夏日约定', artist: 'JINBAO', playing: false })
  await shot(island, path.join(outDir, 'v062-灵动岛-音乐-暂停.png'))

  await fake({
    source: 'QQMusic',
    title: '夏日约定（Live版·超长歌名测试截断效果）',
    artist: 'JINBAO',
    playing: true
  })
  await shot(island, path.join(outDir, 'v062-灵动岛-音乐-长歌名截断.png'))
}

console.log('# done')
process.exit(0)
