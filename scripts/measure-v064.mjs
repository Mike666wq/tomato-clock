// v0.3.4 今日时间线（甘特条）的布局测量脚本。
//
// 规矩：**像素问题不许目测**（肥鱼立的）。
// 甘特条的位置必须量出来对不对，不能看截图说"差不多在那儿"。
//
// 用法：
//   1) 起开发版：$env:POMODORO_USER_DATA='<项目>\.tmp\shot'; pnpm dev
//   2) node scripts\measure-v064.mjs
//
// 量的东西：
//   A. 用**用户真实数据**验位置：今天 02:39 开始的长休，块应该落在 2 点附近
//   B. 块宽度 = 实际时长（不是计划时长）
//   C. 跨零点的段裁到 24h 内，不越界
//   D. 没挂主题的段用中性色，休息段压暗
//   E. 刻度文字跟"今日按小时分布"用同一个 slot 中点算法

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 开跑前自检（肥鱼立的规矩）：数据文件必须与被测实例的 userData 是同一处，
// ELECTRON_RUN_AS_NODE 残留要清，进程筛选不许按命令行片段。
import { preflight } from './preflight.mjs'
const pre = preflight({
  dataFile: process.env.E2E_DATA,
  snapshotFile: process.env.E2E_SNAPSHOT,
  label: '时间线布局测量'
})
console.log(`# 自检通过：userData=${pre.userData}`)

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

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

const pages = (await targets()).filter((t) => t.type === 'page')
// 注意别用 p 当参数名 —— 里面 shadow 了外层的 p，find 的回调返回 undefined
const mainT = pages.find((t) => {
  try {
    const pathname = new URL(t.url).pathname
    return pathname === '/' || pathname.endsWith('index.html')
  } catch {
    return false
  }
})
if (!mainT) {
  console.log('NO_MAIN_TARGET')
  process.exit(1)
}
const main = await connect(mainT.webSocketDebuggerUrl)

// ---------- 造真数据 ----------
// 用**用户真实数据**当基准：
//   今天（11/23）02:39 开始的长休，900 秒 → 块应落在 2 点附近，宽度 15 分钟
//   另加一条 00:34 开始 25 分钟的专注段（肥鱼点名要验的那条）
//   再加一条跨零点的段，验它裁到 24h 内

const USER_TOPICS = [
  {
    id: 'topic-mwrgga9f-3ben',
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

function at(h, m, durSec, over = {}) {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  const started = d.toISOString()
  return {
    id: `tl-${h}-${m}`,
    kind: 'focus',
    startedAt: started,
    endedAt: new Date(d.getTime() + durSec * 1000).toISOString(),
    plannedSec: durSec,
    actualSec: durSec,
    pausedSec: 0,
    completed: true,
    task: '',
    interrupt: 'none',
    topicId: 'topic-mwrgga9f-3ben',
    topicNameSnapshot: '操作系统复习',
    ...over
  }
}

const SESSIONS = [
  // 00:34 开始、25 分钟 —— 肥鱼点名要验的那条
  at(0, 34, 1500, { task: '复习' }),
  // 02:39 开始的长休（用户真实数据里今天那条）
  at(2, 39, 900, { kind: 'long', topicId: undefined, topicNameSnapshot: '' }),
  // 跨零点：23:50 开始、跑 40 分钟 → 必须裁到 24h 内
  at(23, 50, 2400),
  // 没挂主题的专注段
  at(14, 0, 1500, { topicId: undefined, topicNameSnapshot: '' }),
  // 没跑完的段
  at(16, 0, 300, { completed: false, actualSec: 300, plannedSec: 1500 }),
  // 第二个主题（验纸感下两个主题的色块能互相区分）
  at(10, 0, 2700, { topicId: 'topic-deep', topicNameSnapshot: '深度工作' }),
  at(12, 0, 2700, { topicId: 'topic-deep', topicNameSnapshot: '深度工作', task: '改那个 bug' }),
  // **只有 2 分钟**的段 —— 真实宽度 = (2/60)*16.667 = 0.556 单位，
  // 不足最小可见宽 1.2 → 会被兜底画成 1.2。
  // 这条专门用来锁住「1.2 ≠ 真实比例，浮层里的数字才是真相」。
  at(17, 0, 120)
]

async function applySettings(over) {
  await evaluate(main, `window.pomodoro.settings.save(${JSON.stringify(over)})`)
  await sleep(500)
}

async function writeSessions(list) {
  const res = await fetch(`http://127.0.0.1:${port}/json`)
  const t = (await res.json()).find((x) => x.type === 'page')
  const file = process.env.E2E_DATA
  const { writeFileSync, renameSync, readFileSync, existsSync } = await import('node:fs')
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null
  const next = {
    schemaVersion: 3,
    settings: cur?.settings ?? {},
    sessions: list
  }
  const tmp = `${file}.tl.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, file)
  void t
}

async function gotoStats() {
  await evaluate(main, "document.querySelectorAll('.nav__item')[0]?.click()")
  await sleep(250)
  await evaluate(main, "document.querySelectorAll('.nav__item')[1]?.click()")
  await sleep(900)
}

// ---------- 准备 ----------
await applySettings({ topics: USER_TOPICS, activeTopicId: 'topic-mwrgga9f-3ben' })
await writeSessions(SESSIONS)
await gotoStats()
await evaluate(
  main,
  "document.querySelectorAll('.toast').forEach((el) => el.style.setProperty('display', 'none'))"
)

const timeline = await evaluate(
  main,
  `(() => {
    const svg = document.querySelector('.chart--timeline')
    if (!svg) return null
    const vb = svg.viewBox.baseVal
    const W = vb.width
    const slot = W / 24
    const segs = [...svg.querySelectorAll('.timeline__seg')].map((r) => {
      const title = r.parentElement.querySelector('title')
      const cs = getComputedStyle(r)
      return {
        x: Number(r.getAttribute('x')),
        w: Number(r.getAttribute('width')),
        title: title ? title.textContent : '',
        cls: r.getAttribute('class'),
        fill: cs.fill,
        fillOpacity: cs.fillOpacity,
        stroke: cs.stroke,
        strokeDasharray: cs.strokeDasharray,
        text: r.parentElement.querySelector('.timeline__seg-text')?.textContent ?? ''
      }
    })
    // 刻度文字的位置
    const labels = [...svg.querySelectorAll('.chart__label')].map((t) => ({
      text: t.textContent,
      x: Number(t.getAttribute('x')),
      anchor: t.getAttribute('text-anchor')
    }))
    const nowLine = svg.querySelector('.timeline__now')
    const nowLabel = svg.querySelector('.timeline__now-label')
    const lane = svg.querySelector('.timeline__lane')
    return {
      W, slot, segs, labels,
      nowX: nowLine ? Number(nowLine.getAttribute('x1')) : null,
      nowLabel: nowLabel ? nowLabel.textContent : null,
      laneY: lane ? Number(lane.getAttribute('y')) : null,
      laneH: lane ? Number(lane.getAttribute('height')) : null,
      // 池子里有没有空态
      emptyText: document.querySelector('.card__empty')?.textContent ?? ''
    }
  })()`
)

if (!timeline) {
  check('时间线 SVG 存在', false, '找不到 .chart--timeline')
  process.exit(1)
}

console.log(`# 量到：viewBox 宽 ${timeline.W}，slot ${timeline.slot.toFixed(3)}`)
console.log(`# 段数 ${timeline.segs.length}，刻度 ${timeline.labels.map((l) => l.text).join('/')}`)

// ---------- A. 位置：用真数据核 ----------
// 00:34 的段 → x 应该 = (34/60)*slot
const seg0034 = timeline.segs.find((s) => s.title.includes('00:34'))
if (!seg0034) {
  check('A1 00:34 那条段在时间线上', false, `没找到，标题列表：${timeline.segs.map((s) => s.title).join(' | ')}`)
} else {
  const expectX = (34 / 60) * timeline.slot
  const dx = Math.abs(seg0034.x - expectX)
  check(
    'A1 00:34 的段落在 0 点右侧一点点（位置量对了）',
    dx < 0.6,
    `x=${seg0034.x.toFixed(2)} 期望 ${expectX.toFixed(2)}（(34/60)*${timeline.slot.toFixed(3)}）差 ${dx.toFixed(3)}`
  )
  // 宽度 = 实际时长 25 分钟
  const expectW = (25 / 60) * timeline.slot
  const dw = Math.abs(seg0034.w - expectW)
  check(
    'A2 宽度 = 实际时长 25 分钟（不是计划时长）',
    dw < 0.6,
    `w=${seg0034.w.toFixed(2)} 期望 ${expectW.toFixed(2)}（(25/60)*${timeline.slot.toFixed(3)}）差 ${dw.toFixed(3)}`
  )
}

// ---------- B. 用户真实数据：02:39 的长休 ----------
const seg0239 = timeline.segs.find((s) => s.title.includes('02:39'))
if (!seg0239) {
  check('B1 用户真实那条 02:39 的段在时间线上', false, '没找到')
} else {
  const expectX = ((2 * 60 + 39) / 60) * timeline.slot
  check(
    'B1 用户真实那条 02:39 的段位置正确',
    Math.abs(seg0239.x - expectX) < 0.6,
    `x=${seg0239.x.toFixed(2)} 期望 ${expectX.toFixed(2)}`
  )
  check(
    'B2 长休段是休息段（压暗，不挂主题色）',
    seg0239.cls.includes('timeline__seg--break'),
    `class="${seg0239.cls}" fill=${seg0239.fill}`
  )
}

// ---------- C. 跨零点的段裁到 24h 内 ----------
const seg2350 = timeline.segs.find((s) => s.title.includes('23:50'))
if (!seg2350) {
  check('C1 23:50 那条段在时间线上', false, '没找到')
} else {
  const expectX = ((23 * 60 + 50) / 60) * timeline.slot
  const expectW = ((24 * 60 - (23 * 60 + 50)) / 60) * timeline.slot
  check(
    'C1 跨零点的段左边界在 23:50',
    Math.abs(seg2350.x - expectX) < 0.6,
    `x=${seg2350.x.toFixed(2)} 期望 ${expectX.toFixed(2)}`
  )
  check(
    'C2 跨零点的段裁到 24h 内，不越界',
    Math.abs(seg2350.w - expectW) < 0.6 && seg2350.x + seg2350.w <= timeline.W + 0.01,
    `w=${seg2350.w.toFixed(2)} 期望 ${expectW.toFixed(2)}（只剩 10 分钟），右边界 ${(seg2350.x + seg2350.w).toFixed(2)} ≤ ${timeline.W}`
  )
}

// ---------- D. 颜色与状态 ----------
const segNoTopic = timeline.segs.find((s) => s.title.includes('14:00'))
if (segNoTopic) {
  check(
    'D1 没挂主题的段用中性色（不给它编假颜色）',
    segNoTopic.cls.includes('timeline__seg--none'),
    `class="${segNoTopic.cls}" fill=${segNoTopic.fill}`
  )
}
const segOpen = timeline.segs.find((s) => s.title.includes('16:00'))
if (segOpen) {
  check(
    'D2 没跑完的段用虚线描边',
    segOpen.cls.includes('timeline__seg--open') && segOpen.strokeDasharray !== 'none',
    `class="${segOpen.cls}" stroke-dasharray=${segOpen.strokeDasharray}`
  )
}

// ---------- E. 刻度跟分布图共用同一个 slot 中点算法 ----------
const hourChartLabels = await evaluate(
  main,
  `(() => {
    const svgs = [...document.querySelectorAll('.chart')]
    const hour = svgs.find(s => s.getAttribute('aria-label') === '今日按小时分布')
    if (!hour) return null
    return [...hour.querySelectorAll('.chart__label')].map(t => ({
      text: t.textContent,
      x: Number(t.getAttribute('x')),
      anchor: t.getAttribute('text-anchor')
    }))
  })()`
)
if (!hourChartLabels) {
  check('E1 找得到小时分布图', false, '找不到 aria-label="今日按小时分布" 的 svg')
} else {
  const tl0 = timeline.labels.find((l) => l.text === '0')
  const h0 = hourChartLabels.find((l) => l.text === '0')
  const tl24 = timeline.labels.find((l) => l.text === '24')
  const h24 = hourChartLabels.find((l) => l.text === '24')
  check(
    'E1 时间线的刻度跟小时分布图用同一个 slot 中点算法',
    tl0 && h0 && Math.abs(tl0.x - h0.x) < 0.01 && tl24 && h24 && Math.abs(tl24.x - h24.x) < 0.01,
    `时间线 0 点 x=${tl0?.x}，分布图 0 点 x=${h0?.x}；时间线 24 x=${tl24?.x}，分布图 24 x=${h24?.x}`
  )
}

// ---------- E2. 纸感下两个主题的色块必须能互相区分 ----------
// 这条是量出来的教训：30% 混墨色时蓝绿两块的饱和度掉到 23%/27%，
// 色相还在但肉眼分不出来 —— 两个主题的块看起来一样，那这块就白画了。
// 判据用**饱和度**（WCAG 对比度不适合衡量"两个色块能否区分"，那是色相问题）。
await applySettings({ uiTheme: 'paper' })
await gotoStats()
await sleep(400)
const paperColors = await evaluate(
  main,
  `(() => {
    const out = {}
    // 主题名在 React 浮层里（原生 title 只有时间和时长），
    // 所以这里按**位置**配对：第 i 个块 ↔ 第 i 段数据。
    const segs = [...document.querySelectorAll('.timeline__seg')]
    return segs.map((r, i) => ({
      fill: getComputedStyle(r).fill,
      x: Number(r.getAttribute('x'))
    }))
  })()`
)
// 主题色是注入的 CSS 变量，直接读它更准
const topicColors = await evaluate(
  main,
  `(() => {
    const segs = [...document.querySelectorAll('.timeline__seg')]
    return segs.map(r => ({
      raw: r.style.getPropertyValue('--topic-color').trim(),
      fill: getComputedStyle(r).fill,
      cls: r.getAttribute('class') ?? ''
    }))
  })()`
)
const segClasses = topicColors.map((t) => t.cls)
function parseFill(s) {
  const m = String(s).match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?:\s*\/\s*([\d.]+))?\)/)
  if (m) {
    return {
      r: parseFloat(m[1]) * 255,
      g: parseFloat(m[2]) * 255,
      b: parseFloat(m[3]) * 255,
      a: m[4] === undefined ? 1 : parseFloat(m[4])
    }
  }
  const m2 = String(s).match(/rgba?\(([^)]+)\)/)
  if (m2) {
    const p = m2[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }
  }
  return null
}
function saturation(c) {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  if (mx === mn) return 0
  const d = mx - mn
  const l = (mx + mn) / 2
  return (l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)) * 100
}
function hue(c) {
  const r = c.r / 255
  const g = c.g / 255
  const bl = c.b / 255
  const mx = Math.max(r, g, bl)
  const mn = Math.min(r, g, bl)
  if (mx === mn) return 0
  const d = mx - mn
  let h
  if (mx === r) h = ((g - bl) / d + (g < bl ? 6 : 0))
  else if (mx === g) h = (bl - r) / d + 2
  else h = (r - g) / d + 4
  return (h * 60) % 360
}
// 两个主题：'操作系统复习'(蓝 #7aa2f7) 和 '深度工作'(绿 #5ac49b)
// **不能按固定下标取** —— 休息段也占下标，取错了会量到休息段的颜色
// （第一版就取到了休息段：饱和 9%、色相 48°，那不是主题绿）。
// 也**不能取"第一个和最后一个"** —— 过滤后顺序里首尾可能同色。
// 正确做法：按注入的主题色**去重**，每种颜色取一个代表。
const themeSegs = topicColors
  .map((t, i) => ({ ...t, i }))
  .filter((t) => {
    const cls = segClasses[t.i] ?? ''
    return !cls.includes('--none') && !cls.includes('--break')
  })
  .map((t) => ({ ...t, color: parseFill(t.fill) }))
  .filter((t) => t.color)
// 按注入的原始色值去重（--topic-color 才是"这是哪个主题"的真相，
// computed fill 是混过墨色的结果，同一主题的多个块值一样）
const byRaw = new Map()
for (const t of themeSegs) {
  if (!byRaw.has(t.raw)) byRaw.set(t.raw, t)
}
const distinct = [...byRaw.values()]
if (distinct.length < 2) {
  check(
    'E2 纸感下能取到两个主题的色块',
    false,
    `只取到 ${distinct.length} 种主题色（${[...byRaw.keys()].join('/')}）`
  )
} else {
  const cA = distinct[0].color
  const cB = distinct[distinct.length - 1].color
  const dh = Math.abs(hue(cA) - hue(cB))
  const dhMin = Math.min(dh, 360 - dh)
  const minSat = Math.min(saturation(cA), saturation(cB))
  check(
    'E2 纸感下两个主题的色块能互相区分（色相 ≥ 40° 且饱和度 ≥ 25%）',
    dhMin >= 40 && minSat >= 25,
    `${distinct[0].raw} 饱和 ${saturation(cA).toFixed(0)}% 色相 ${hue(cA).toFixed(0)}°；` +
      `${distinct[distinct.length - 1].raw} 饱和 ${saturation(cB).toFixed(0)}% 色相 ${hue(cB).toFixed(0)}°；` +
      `色相差 ${dhMin.toFixed(0)}°（要求 ≥40°，饱和度 ≥25%）`
  )
}
await applySettings({ uiTheme: 'paper' })
await gotoStats()
await sleep(300)

// ---------- F. 「现在」竖线 ----------
const now = new Date()
const nowMin = now.getHours() * 60 + now.getMinutes()
const expectNowX = (nowMin / 60) * timeline.slot
check(
  'F1 「现在」竖线位置正确',
  timeline.nowX !== null && Math.abs(timeline.nowX - expectNowX) < 1.5,
  `nowX=${timeline.nowX?.toFixed(2)} 期望 ${expectNowX.toFixed(2)}（${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}）`
)
check('F2 「现在」有标签', timeline.nowLabel === '现在', `标签="${timeline.nowLabel}"`)

// ---------- G. 块内文字门槛 45 分钟 + hover 浮层 ----------
// 肥鱼定的：块内只在 ≥45 分钟时写时长；其余信息全走 hover 浮层。
// 判据是**分钟数**不是像素 —— 像素宽度会随画布缩放漂移。
const textInfo = await evaluate(
  main,
  `(() => {
    const segs = [...document.querySelectorAll('.timeline__seg')].map(r => {
      const g = r.parentElement
      const title = g.querySelector('title')?.textContent ?? ''
      const m = title.match(/– ([^　]+)　(\\d+) 分钟/)
      const durMin = m ? parseInt(m[2]) : -1
      const t = g.querySelector('.timeline__seg-text')
      return { durMin, text: t ? t.textContent : null }
    })
    return segs
  })()`
)
if (!textInfo || textInfo.length === 0) {
  check('G1 取得到块的信息', false, '没取到段')
} else {
  const below = textInfo.filter((s) => s.durMin >= 0 && s.durMin < 45)
  const atOrAbove = textInfo.filter((s) => s.durMin >= 45)
  const belowWrong = below.filter((s) => s.text !== null)
  const aboveWrong = atOrAbove.filter((s) => s.text === null)
  check(
    'G1 不到 45 分钟的块不写时长（宁可不写，别塞成噪声）',
    belowWrong.length === 0,
    `有 ${below.length} 段不到 45 分钟，其中 ${belowWrong.length} 段却写了字` +
      (below.length ? `（${below.map((s) => s.durMin + '分').join('/')}）` : '')
  )
  check(
    'G2 到 45 分钟的块写时长',
    aboveWrong.length === 0,
    `有 ${atOrAbove.length} 段 ≥45 分钟，其中 ${aboveWrong.length} 段没写字`
  )
}

// hover 浮层
// 注意：**不能用 dispatchEvent 合成事件** —— React 的 onMouseEnter
// 挂在 mouseover 上，合成事件不走 React 的事件委托，测了等于没测。
// 用 CDP 的 Input.dispatchMouseEvent 发真实鼠标事件。
// 坐标要在**移动鼠标之前**取 —— 前面 E2 切过主题，块的位置已经变了。
const segBox = await evaluate(
  main,
  `(() => {
    const seg = [...document.querySelectorAll('.timeline__seg')].find(r => {
      const t = r.parentElement.querySelector('title')?.textContent ?? ''
      return t.includes('00:34')
    })
    if (!seg) return null
    const r = seg.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`
)
if (!segBox) {
  check('G3 悬停有详情浮层', false, '没找到 00:34 的段')
} else {
  // 先把鼠标挪到别处，确保是"移上去"触发的，不是上一轮残留
  await send(main, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await sleep(200)
  await send(main, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(segBox.x),
    y: Math.round(segBox.y)
  })
  await sleep(400)
  const tip = await evaluate(
    main,
    `(() => {
      const tip = document.querySelector('.timeline__tip')
      if (!tip) return { exists: false }
      return {
        exists: true,
        time: tip.querySelector('.timeline__tip-time')?.textContent ?? '',
        dur: tip.querySelector('.timeline__tip-dur')?.textContent ?? '',
        topic: tip.querySelector('.timeline__tip-topic')?.textContent ?? '',
        hasTask: !!tip.querySelector('.timeline__tip-task'),
        left: tip.style.left
      }
    })()`
  )
  check(
    'G3 悬停有详情浮层（起止 + 时长 + 主题 + 任务名）',
    tip.exists && tip.time.includes('00:34') && tip.dur.includes('25') && tip.topic.length > 0 && tip.hasTask,
    tip.exists
      ? `时间="${tip.time}" 时长="${tip.dur}" 主题="${tip.topic}" 有任务名=${tip.hasTask} 定位=${tip.left}`
      : '没出现浮层'
  )
  // 移开就该消失 —— 浮层不能赖着不走
  await send(main, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await sleep(300)
  const gone = await evaluate(main, `!document.querySelector('.timeline__tip')`)
  check('G4 鼠标移开浮层消失', gone === true, `移开后浮层还在 = ${gone === true ? '否' : '是'}`)
}

// ---------- G5. 最小可见宽 1.2 ≠ 真实比例 ----------
// 肥鱼定的口径（不许改回去）：
//   1.2 单位只是**视觉兜底**，短段的绘制宽度不等于真实比例；
//   **浮层里的数字是唯一真相**，不许拿块宽反推时长。
//
// 验两件事：
//   ① 2 分钟那段确实被兜底画成 1.2 单位（真实宽只有 0.556）
//   ② 但它浮层里报的是 **2 分钟**（真实 actualSec），
//      而不是按 1.2 单位折算出来的 4 分钟
const shortInfo = await evaluate(
  main,
  `(() => {
    const seg = [...document.querySelectorAll('.timeline__seg')].find(r => {
      const t = r.parentElement.querySelector('title')?.textContent ?? ''
      return t.includes('17:00')
    })
    if (!seg) return null
    const r = seg.getBoundingClientRect()
    return {
      w: Number(seg.getAttribute('width')),
      x: r.x + r.width / 2,
      y: r.y + r.height / 2
    }
  })()`
)
if (!shortInfo) {
  check('G5 取得到短段', false, '没找到 17:00 那条 2 分钟的段')
} else {
  check(
    'G5 短段被兜底画成最小可见宽 1.2 单位（真实宽只有 0.556）',
    Math.abs(shortInfo.w - 1.2) < 0.001,
    `绘制宽度 w=${shortInfo.w}，真实宽期望 1.2（2 分钟的真实宽是 0.556）`
  )
  // 悬停它，看浮层报的是不是真实时长
  await send(main, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await sleep(200)
  await send(main, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(shortInfo.x),
    y: Math.round(shortInfo.y)
  })
  await sleep(400)
  const shortTip = await evaluate(
    main,
    `(() => {
      const tip = document.querySelector('.timeline__tip')
      if (!tip) return null
      return tip.querySelector('.timeline__tip-dur')?.textContent ?? ''
    })()`
  )
  const byWidthWouldBe = Math.round((1.2 / (timeline.W / 24)) * 60) // 按兜底宽折算
  check(
    'G5 短段浮层报的是真实时长（2 分钟），不是按兜底宽折算的分钟数',
    shortTip !== null && shortTip.includes('2 分钟') && !shortTip.includes(`${byWidthWouldBe} 分钟`),
    `浮层时长="${shortTip}"（真实 2 分钟；按 1.2 单位折算会是 ${byWidthWouldBe} 分钟）`
  )
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length) {
  failed.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`))
}
process.exit(failed.length ? 1 : 0)
