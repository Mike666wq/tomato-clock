// v0.6.3 的布局测量脚本：**用 DOM 边界量，不看截图**。
//
// 肥鱼立的规矩（v0.6.3）：像素级的事只能量不能看。
// 缩略图缩放后一根柱子差两三个像素完全看不出来，
// 但据此断言"歪了"就是拿猜测冒充结论。
//
// 用法：
//   1) 起开发版：$env:POMODORO_USER_DATA='<项目>\.tmp\shot'; pnpm dev
//   2) node scripts\measure-v063.mjs
//
// 量的东西：
//   A. 统计页：最后一张卡的下边缘离导航栏多远（要 ≥ 80px，不能被切）
//   B. 「＋ 主题」虚线框在纸感下的实际不透明度（要看得见）
//   C. 音乐行：歌名左对齐、歌手右对齐，两块不重叠
//   D. 音乐行分隔线有没有真的画出来

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

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

/** 解析 css 颜色字符串，返回 r,g,b,a */
function parseColor(str) {
  const s = String(str || '').trim()
  // color(srgb r g b / a) —— 现代浏览器算出来的形式
  let m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/)
  if (m) {
    return {
      r: Math.round(parseFloat(m[1]) * 255),
      g: Math.round(parseFloat(m[2]) * 255),
      b: Math.round(parseFloat(m[3]) * 255),
      a: m[4] === undefined ? 1 : parseFloat(m[4])
    }
  }
  m = s.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] }
  }
  m = s.match(/^#([0-9a-f]{6})$/i)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  m = s.match(/^#([0-9a-f]{3})$/i)
  if (m) {
    const n = parseInt(m[1], 16)
    return {
      r: ((n >> 8) & 15) * 17,
      g: ((n >> 4) & 15) * 17,
      b: (n & 15) * 17,
      a: 1
    }
  }
  return null
}

/** 相对亮度（WCAG） */
function luminance(c) {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

/** 对比度（WCAG），1 = 一样，21 = 黑底白字 */
function contrast(a, b) {
  if (!a || !b) return 0
  const l1 = luminance(a)
  const l2 = luminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

/** 把半透明色合成到底色上 */
function flatten(fg, bg) {
  if (!fg) return null
  if (!bg) return fg
  const a = fg.a === undefined ? 1 : fg.a
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1
  }
}

// ---------- A. 统计页底部留白 ----------

console.log('# A. 统计页：最后一张卡离导航栏多远')
await evaluate(main, "document.querySelectorAll('.nav__item')[1]?.click()")
await sleep(900)

const stats = await evaluate(
  main,
  `(() => {
    const container = document.querySelector('.main--page')
    const nav = document.querySelector('.nav')
    if (!container || !nav) return null
    // 滚到底，看最后一张卡的下边缘离容器底多远
    container.scrollTop = container.scrollHeight
    const cards = [...container.querySelectorAll('.card')]
    const last = cards[cards.length - 1]
    const cr = last.getBoundingClientRect()
    const nr = nav.getBoundingClientRect()
    const sr = container.getBoundingClientRect()
    const cs = getComputedStyle(container)
    return {
      navH: nr.height,
      navTop: nr.top,
      containerBottom: sr.bottom,
      lastCardBottom: cr.bottom,
      gapToNav: nr.top - cr.bottom,
      paddingBottom: cs.paddingBottom,
      navVar: getComputedStyle(document.documentElement).getPropertyValue('--nav-h').trim(),
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      cardCount: cards.length,
      // 最后一张卡有没有被容器裁掉（内容超出可视区）
      lastCardFullyVisible: cr.bottom <= sr.bottom + 0.5
    }
  })()`
)

if (!stats) {
  check('A 统计页容器存在', false, '找不到 .main--page 或 .nav')
} else {
  console.log(`      量到：nav 高 ${stats.navH}px，--nav-h=${stats.navVar}，padding-bottom=${stats.paddingBottom}`)
  console.log(`      最后一张卡下边缘 ${Math.round(stats.lastCardBottom)}，导航栏上边缘 ${Math.round(stats.navTop)}`)
  check(
    'A1 最后一张卡完整可见（滚到底时不被裁）',
    stats.lastCardFullyVisible,
    `lastCardBottom=${Math.round(stats.lastCardBottom)} containerBottom=${Math.round(stats.containerBottom)}`
  )
  check(
    'A2 最后一张卡离导航栏 ≥ 80px',
    stats.gapToNav >= 80,
    `gap=${Math.round(stats.gapToNav)}px（要求 ≥80）`
  )
  check(
    'A3 底部留白随导航高度走（不是写死的 12px）',
    parseFloat(stats.paddingBottom) >= 80,
    `padding-bottom=${stats.paddingBottom}（--nav-h=${stats.navVar}）`
  )
}

// ---------- B. 纸感下「＋ 主题」虚线可见度 ----------

console.log('# B. 纸感下「＋ 主题」的虚线框')
// 「＋ 主题」在**计时页**的主题行里（.topics__chip--add），
// 统计页没有这个元素 —— 上一版量不到就是这个原因。
await evaluate(main, "document.querySelectorAll('.nav__item')[0]?.click()")
await sleep(600)
for (const theme of ['paper', 'neon', 'ios']) {
  await evaluate(main, `window.pomodoro.settings.save({ uiTheme: '${theme}' })`)
  await sleep(500)
  const add = await evaluate(
    main,
    `(() => {
      const el = document.querySelector('.topics__chip--add')
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      // 底色：往上找第一个不透明的背景（body 一定有底）
      let bgEl = el
      let bg = 'rgba(0, 0, 0, 0)'
      while (bgEl) {
        const c = getComputedStyle(bgEl).backgroundColor
        const m = c.match(/rgba?\(([^)]+)\)/)
        const a = m ? (m[1].split(/[\s,/]+/).filter(Boolean)[3] ?? '1') : '1'
        if (Number(a) > 0.95) { bg = c; break }
        bgEl = bgEl.parentElement
      }
      return {
        borderColor: cs.borderTopColor,
        borderStyle: cs.borderTopStyle,
        borderWidth: cs.borderTopWidth,
        color: cs.color,
        bg,
        visible: r.width > 0 && r.height > 0,
        dpr: window.devicePixelRatio
      }
    })()`
  )
  if (!add) {
    check(`B ${theme} 「＋ 主题」存在`, false, '找不到 .topics__chip--add')
    continue
  }
  const borderC = parseColor(add.borderColor)
  const bgC = parseColor(add.bg)
  const solid = flatten(borderC, bgC)
  const ratio = contrast(solid, bgC)
  const borderPx = parseFloat(add.borderWidth) * add.dpr
  check(
    `B ${theme} 虚线描边看得见（对比度 ≥ 3:1，且是虚线）`,
    ratio >= 3 && add.borderStyle === 'dashed' && Math.abs(borderPx - 1) < 0.35,
    `border=${add.borderColor} style=${add.borderStyle} w=${borderPx.toFixed(2)}px ` +
      `对比度=${ratio.toFixed(2)}:1（底色 ${add.bg}，要求 ≥3:1）`
  )
}
await evaluate(main, `window.pomodoro.settings.save({ uiTheme: 'paper' })`)
await sleep(400)

// ---------- C. 音乐行：歌名左、歌手右 ----------

console.log('# C. 灵动岛音乐行')
if (!island) {
  check('C 灵动岛窗口存在', false, '没有找到 island 页面')
} else {
  await evaluate(island, `window.island.settings.save({ showMusicControl: true })`)
  await evaluate(
    island,
    `window.island.media.devFake({ source: 'QQMusic', title: '夏日约定（Live版·超长歌名测试截断效果）', artist: 'JINBAO', playing: true })`
  )
  await sleep(500)
  // 展开：鼠标移上去
  await send(island, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 20 })
  await sleep(700)

  const music = await evaluate(
    island,
    `(() => {
      const row = document.querySelector('.island__music')
      const title = document.querySelector('.island__music-title')
      const artist = document.querySelector('.island__music-artist')
      if (!row || !title || !artist) return null
      const rr = row.getBoundingClientRect()
      const tr = title.getBoundingClientRect()
      const ar = artist.getBoundingClientRect()
      const cs = getComputedStyle(row)
      return {
        rowLeft: rr.left, rowRight: rr.right,
        titleLeft: tr.left, titleRight: tr.right, titleW: tr.width,
        titleText: title.textContent,
        titleTruncated: title.scrollWidth > title.clientWidth + 1,
        artistLeft: ar.left, artistRight: ar.right, artistW: ar.width,
        artistText: artist.textContent,
        artistTruncated: artist.scrollWidth > artist.clientWidth + 1,
        overlap: tr.right > ar.left + 0.5,
        borderTopWidth: cs.borderTopWidth,
        borderTopStyle: cs.borderTopStyle,
        borderTopColor: cs.borderTopColor,
        dpr: window.devicePixelRatio,
        rowH: rr.height,
        sepGap: title ? tr.top - rr.top : 0
      }
    })()`
  )

  if (!music) {
    check('C 音乐行结构存在', false, '找不到 .island__music / title / artist')
  } else {
    check(
      'C1 歌名在左、歌手在右（两块不重叠）',
      !music.overlap && music.artistLeft >= music.titleRight - 1,
      `title=[${Math.round(music.titleLeft)},${Math.round(music.titleRight)}] artist=[${Math.round(music.artistLeft)},${Math.round(music.artistRight)}] overlap=${music.overlap}`
    )
    check(
      'C2 长歌名被截断，但歌手完整保留',
      music.titleTruncated && music.artistText === 'JINBAO' && !music.artistTruncated,
      `titleTruncated=${music.titleTruncated} artist="${music.artistText}" artistTruncated=${music.artistTruncated} artistW=${Math.round(music.artistW)}`
    )
    // 1px 的边框在 1.5 倍缩放下 getComputedStyle 返回的是 0.667px（设备像素比换算），
    // 所以这里比的是"约等于 1 个 CSS 像素"，不是精确等于 1。
    const borderPx = parseFloat(music.borderTopWidth) * music.dpr
    check(
      'C3 音乐行上边有 1px 分隔线',
      music.borderTopStyle === 'solid' && Math.abs(borderPx - 1) < 0.35,
      `border-top: ${music.borderTopWidth} × dpr ${music.dpr} = ${borderPx.toFixed(2)}px ${music.borderTopStyle}`
    )
  }
}

// ---------- D. 岛的高度常量跟主进程一致 ----------

console.log('# D. 岛窗口高度')
if (island) {
  const h = await evaluate(island, 'window.innerHeight')
  console.log(`      灵动岛窗口高 ${h}px（含底部余量 14px）`)
  check(
    'D1 音乐行展开后没有被截（窗口高度 ≥ 展开态 + 余量）',
    h >= 134 + 14,
    `窗口高 ${h}，要求 ≥ 148（展开态带音乐 134 + 底部余量 14）`
  )
}

// ---------- 汇总 ----------

const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length) {
  failed.forEach((f) => console.log(`  FAIL ${f.name} — ${f.detail}`))
}
process.exit(failed.length ? 1 : 0)
