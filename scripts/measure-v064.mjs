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
  at(10, 0, 2700, { topicId: 'topic-deep', topicNameSnapshot: '深度工作' })
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
    for (const r of document.querySelectorAll('.timeline__seg')) {
      const title = r.parentElement.querySelector('title')?.textContent ?? ''
      out[title] = getComputedStyle(r).fill
    }
    return out
  })()`
)
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
const topicFills = Object.entries(paperColors)
  .filter(([k]) => k.includes('操作系统复习') || k.includes('深度工作'))
  .map(([k, v]) => ({
    key: k,
    topic: k.includes('操作系统复习') ? '操作系统复习' : '深度工作',
    color: parseFill(v)
  }))
  .filter((x) => x.color)
const topicNames = [...new Set(topicFills.map((t) => t.topic))]
if (topicNames.length < 2) {
  check(
    'E2 纸感下能取到两个不同主题的色块',
    false,
    `只取到 ${topicNames.length} 个主题（${topicNames.join('/')}）—— 数据里只有一个主题，验不了区分度`
  )
} else {
  // 每个主题取一个色块，算它跟"另一个主题的色块"的距离
  const perTopic = topicNames.map((n) => {
    const t = topicFills.find((x) => x.topic === n)
    return { name: n, color: t.color, sat: saturation(t.color) }
  })
  const a = perTopic[0]
  const b = perTopic[1]
  // 色相距离：两个色块能不能被区分，看的是色相不是亮度
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
  const dh = Math.abs(hue(a.color) - hue(b.color))
  const dhMin = Math.min(dh, 360 - dh)
  const minSat = Math.min(a.sat, b.sat)
  check(
    'E2 纸感下两个主题的色块能互相区分（色相 ≥ 40° 且饱和度 ≥ 25%）',
    dhMin >= 40 && minSat >= 25,
    `${a.name} 饱和 ${a.sat.toFixed(0)}% 色相 ${hue(a.color).toFixed(0)}°；` +
      `${b.name} 饱和 ${b.sat.toFixed(0)}% 色相 ${hue(b.color).toFixed(0)}°；` +
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

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length) {
  failed.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`))
}
process.exit(failed.length ? 1 : 0)
