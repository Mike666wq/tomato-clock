// 真机验证：灵动岛的主题列表（v0.3.10）。
//
// 验的是用户能直接感知的东西：
//   1 岛上点主题胶囊 → **往下弹出列表**（不是直接去新建）
//   2 列表里的主题全部看得见（没被窗口裁掉）
//   3 选中一个 → 胶囊变成它，data.json 的 activeTopicId 真的变了
//   4 再点一次同一个 → 胶囊回到「＋ 主题」，activeTopicId 变空
//   5 一个主题都没有时 → 直接进新建（不弹空框）
//
// 用法：
//   node scripts\start-instance.mjs --dev --profile .tmp\topic-menu
//   node scripts\verify-topic-menu.mjs
//
// 前置自检：被测实例的 userData 必须在工作区 .tmp 下（不许碰用户自己那份）。

import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}${extra ? ' —— ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`)
  }
  return ok
}

// ---- 前置自检 ----
const manifestFile = path.join(root, '.tmp', 'instance.json')
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'))
} catch {
  console.error('[自检] 没有 .tmp/instance.json —— 先起一个被测实例')
  process.exit(1)
}
const userData = path.resolve(manifest.userData)
if (!userData.startsWith(path.join(root, '.tmp'))) {
  console.error(`[自检] 被测实例的 userData 不在工作区 .tmp 下：${userData}`)
  console.error('        （绝不能拿用户自己那份做对照实验）')
  process.exit(1)
}
const port = manifest.port
const dataFile = manifest.dataFile
console.log(`[自检] 实例 mode=${manifest.mode} port=${port}`)
console.log(`[自检] data.json ${dataFile}`)

// ---- CDP ----
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

// ---- 真鼠标 ----
const ps = spawn(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'real-mouse.ps1')],
  { stdio: ['pipe', 'pipe', 'pipe'] }
)
ps.stdout.setEncoding('utf-8')
let buf = ''
const waiters = []
ps.stdout.on('data', (chunk) => {
  buf += chunk
  let i = buf.indexOf('\n')
  while (i >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    i = buf.indexOf('\n')
    if (!line) continue
    const w = waiters.shift()
    if (w) w(line)
  }
})
const mouse = (cmd) =>
  new Promise((resolve) => {
    waiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })

function data() {
  try {
    return JSON.parse(readFileSync(dataFile, 'utf-8'))
  } catch {
    return null
  }
}

/** 等 data.json 里的 activeTopicId 变成期望值（主进程是异步落盘的） */
async function waitActiveTopicId(want, timeoutMs = 3000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    const d = data()
    last = d?.settings?.activeTopicId ?? null
    if (last === want) return { ok: true, got: last }
    await sleep(120)
  }
  return { ok: false, got: last }
}

/** 岛的窗口位置（开发版有 devBounds；打包版用 screenX/screenY） */
async function islandBounds(island) {
  return evaluate(
    island,
    `(async () => {
      const b = await (window.island?.island?.devBounds?.() ?? Promise.resolve(null))
      if (b) return { x: b.x, y: b.y, width: b.width, height: b.height, src: 'devBounds' }
      return {
        x: window.screenX, y: window.screenY,
        width: window.outerWidth, height: window.outerHeight,
        src: 'screenX'
      }
    })()`
  )
}

/** 点一个元素（真鼠标）：先算屏幕坐标，再 move/down/up */
async function clickElement(island, selector, index = 0) {
  const info = await evaluate(
    island,
    `(async () => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = els[${index}]
      if (!el) return { found: false, count: els.length }
      const b = await (window.island?.island?.devBounds?.() ?? Promise.resolve(null))
      const win = b ?? { x: window.screenX, y: window.screenY }
      const r = el.getBoundingClientRect()
      return {
        found: true,
        text: (el.textContent || '').trim(),
        screenPoint: { x: Math.round(win.x + r.x + r.width / 2), y: Math.round(win.y + r.y + r.height / 2) }
      }
    })()`
  )
  if (!info.found || !info.screenPoint) return { ok: false, info }
  await mouse(`move ${info.screenPoint.x} ${info.screenPoint.y}`)
  await sleep(250)
  await mouse(`down ${info.screenPoint.x} ${info.screenPoint.y}`)
  await sleep(120)
  await mouse('up')
  await sleep(350)
  return { ok: true, info }
}

async function shot(island, file) {
  try {
    const r = await send(island, 'Page.captureScreenshot', { format: 'png' })
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  } catch (e) {
    console.log(`  （截图失败：${e.message}）`)
    return null
  }
}

/**
 * 抓**桌面实况**（岛是透明窗口，CDP 截图只有它自己的像素，看不出桌面环境）。
 *
 * 坐标：desktop-shot.ps1 现在是 DPI 感知的 → 它抓的是**物理像素**，
 * 裁剪坐标也按物理像素填。所以这里要把 DIP 乘上缩放比。
 */
async function desktopShot(file, winRect) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const scale = Number(await evaluate(island, `window.devicePixelRatio`)) || 1
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(root, 'scripts', 'desktop-shot.ps1'),
        '-Out',
        file,
        '-X',
        String(Math.round(winRect.x * scale)),
        '-Y',
        String(Math.round(winRect.y * scale)),
        '-W',
        String(Math.round(winRect.width * scale)),
        '-H',
        String(Math.round(winRect.height * scale)),
        '-Pad',
        '30'
      ],
      { encoding: 'utf-8' }
    )
    return file
  } catch (e) {
    console.log(`  （桌面截图失败：${e.message}）`)
    return null
  }
}

// ---- 找到岛的那个页面 ----
const pages = (await targets()).filter((t) => t.type === 'page')
const islandT = pages.find((t) => {
  try {
    return new URL(t.url).pathname.endsWith('island.html')
  } catch {
    return false
  }
})
if (!islandT) {
  console.error('NO_ISLAND_TARGET')
  process.exit(1)
}
const island = await connect(islandT.webSocketDebuggerUrl)

// 机器上还有用户自己那份（E:\tomato-clock）—— 把它挪开，
// 两个岛重叠时真鼠标分不清点的是哪个（规矩：只动自己起的实例）。
const moved = await evaluate(
  island,
  `(() => {
    if (!window.island?.island?.devOffset) return false
    window.island.island.devOffset(340)
    return true
  })()`
)
if (moved) console.log('  （开发实例的岛已横向挪开 340px，避开用户自己那份）')
await sleep(500)

console.log('\n=== 0. 准备：被测实例里放 3 个主题（只动被测实例自己的数据） ===')
// 这三个是**被测实例**自己的数据，不碰用户那份。
// id 沿用用户真实主题的 id，验收口径跟肥鱼给的一致（操作系统复习 = topic-mwrgga9f-3ben）。
const TEST_TOPICS = [
  {
    id: 'topic-mwrgga9f-3ben',
    name: '操作系统复习',
    color: '#5ac49b',
    archived: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    order: 0
  },
  {
    id: 'topic-mwtc1hdu-a66b',
    name: 'nginx阶段学习',
    color: '#7aa2f7',
    archived: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    order: 1
  },
  {
    id: 'topic-testc-0001',
    name: '测试主题C',
    color: '#f5b942',
    archived: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    order: 2
  }
]
await evaluate(
  island,
  `window.island.settings.save(${JSON.stringify({ topics: TEST_TOPICS, activeTopicId: null })}); true`
)
await sleep(900)
const topics = TEST_TOPICS
console.log(`  （被测实例里有 ${topics.length} 个主题：${topics.map((t) => t.name).join('、')}）`)
check('被测实例至少 3 个主题（要验"列表项 ≥3 全部看得见"）', topics.length >= 3)

console.log('\n=== 1. 展开岛 ===')
let expanded = false
for (let i = 0; i < 6; i++) {
  await mouse('move 5 5')
  await sleep(400)
  const b = await islandBounds(island)
  await mouse(`move ${Math.round(b.x + b.width / 2)} ${Math.round(b.y + 12)}`)
  await sleep(700)
  if (await evaluate(island, `!!document.querySelector('.island--expanded')`)) {
    expanded = true
    break
  }
}
check('岛能展开', expanded)

console.log('\n=== 2. 点主题胶囊 → 往下出列表 ===')
const before = await islandBounds(island)
const cap = await clickElement(island, '.island__vals .island__val', 1)
check('主题胶囊点得到', cap.ok, cap.ok ? cap.info.text : JSON.stringify(cap.info))
await sleep(600)

const menuState = await evaluate(
  island,
  `(() => {
    const m = document.querySelector('.island__menu')
    if (!m) return { open: false }
    const items = [...m.querySelectorAll('.island__menu-item')]
    const mr = m.getBoundingClientRect()
    return {
      open: true,
      itemCount: items.length,
      names: items.map((i) => (i.textContent || '').trim()),
      menu: { top: mr.top, bottom: mr.bottom, height: mr.height, left: mr.left, right: mr.right },
      itemRects: items.map((i) => {
        const r = i.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: r.height }
      })
    }
  })()`
)
const after = await islandBounds(island)
check('列表弹出来了', menuState.open === true)
check(
  '窗口变高了（列表往下展开，不是塞在胶囊里）',
  after.height > before.height,
  `${before.height} → ${after.height}`
)
check(
  '列表项 = 主题数 + 末尾新建入口',
  menuState.itemCount === topics.length + 1,
  `实际 ${menuState.itemCount}，期望 ${topics.length + 1}：${(menuState.names ?? []).join(' / ')}`
)
check(
  '列表没被窗口裁掉',
  typeof menuState.menu?.bottom === 'number' && menuState.menu.bottom <= after.height - 2,
  `列表底 ${menuState.menu?.bottom} / 窗口高 ${after.height}`
)
const allVisible =
  Array.isArray(menuState.itemRects) &&
  menuState.itemRects.every((r) => r.height > 0 && r.bottom <= after.height - 2) &&
  menuState.itemRects.length >= 3
check('列表每一项都完整可见（≥3 项）', allVisible, JSON.stringify(menuState.itemRects))

const shotFile = path.join(root, '.tmp', 'topic-menu.png')
await shot(island, shotFile)
console.log(`  截图：${shotFile}`)
// 桌面实况（能看到岛贴顶、列表往下展开的样子）
const desktopFile = await desktopShot(path.join(root, '.tmp', 'topic-menu-desktop.png'), after)
console.log(`  桌面截图：${desktopFile}`)

console.log('\n=== 3. 选中一个主题 ===')
const target = topics[0]
if (!target) {
  console.error('没有可用的主题，中止')
  ps.kill()
  process.exit(1)
}
const timerBefore = await evaluate(island, `(async () => await window.island?.timer?.getState?.())()`)
const click1 = await clickElement(island, '.island__menu-item', 0)
check('列表项点得到', click1.ok, click1.ok ? click1.info.text : JSON.stringify(click1.info))
await sleep(700)

// 选中后列表收起来了，鼠标留在列表那一行 → 已经在胶囊外面，
// 岛会在 400ms 后自己收起（这是对的）。要看胶囊文字，
// 先把鼠标挪回胶囊上再读。
await mouse(`move ${Math.round(after.x + after.width / 2)} ${Math.round(after.y + 12)}`)
await sleep(700)
const capText = await evaluate(
  island,
  `(() => {
    const vals = [...document.querySelectorAll('.island__vals .island__val')]
    return { text: (vals[1]?.textContent || '').trim(), expanded: !!document.querySelector('.island--expanded') }
  })()`
)
check('胶囊变成选中的那个', capText.text.includes(target.name), `胶囊文字「${capText.text}」`)
const sel = await waitActiveTopicId(target.id)
check(
  `data.json 的 activeTopicId = ${target.id}`,
  sel.ok,
  `实际 ${JSON.stringify(sel.got)}`
)
const timerAfter = await evaluate(island, `(async () => await window.island?.timer?.getState?.())()`)
check(
  '点列表没有误切计时器',
  timerAfter?.running === timerBefore?.running,
  `running ${timerBefore?.running} → ${timerAfter?.running}`
)

console.log('\n=== 4. 再点一次 = 取消 ===')
// 选中之后列表是收起来的 → 先把列表再打开（这才是用户会做的两步）
const reopen = await clickElement(island, '.island__vals .island__val', 1)
check('列表能再打开', reopen.ok, reopen.ok ? reopen.info.text : JSON.stringify(reopen.info))
await sleep(500)
const stillOn = await evaluate(
  island,
  `(() => {
    const items = [...document.querySelectorAll('.island__menu-item')]
    const on = items.find((i) => i.classList.contains('island__menu-item--on'))
    return { open: !!document.querySelector('.island__menu'), checked: on ? (on.textContent || '').trim() : null }
  })()`
)
check('当前选中的那个打了勾', !!stillOn.checked, `打勾的是「${stillOn.checked}」`)
const click2 = await clickElement(island, '.island__menu-item--on', 0)
check('再点一次点得到（列表还开着）', click2.ok, click2.ok ? click2.info.text : JSON.stringify(click2.info))
await sleep(700)
await mouse(`move ${Math.round(after.x + after.width / 2)} ${Math.round(after.y + 12)}`)
await sleep(700)
const capText2 = await evaluate(
  island,
  `(() => {
    const vals = [...document.querySelectorAll('.island__vals .island__val')]
    return { text: (vals[1]?.textContent || '').trim(), expanded: !!document.querySelector('.island--expanded') }
  })()`
)
check('胶囊回到「＋ 主题」', capText2.text.includes('＋ 主题'), `胶囊文字「${capText2.text}」`)
const unsel = await waitActiveTopicId(null)
check('data.json 的 activeTopicId 变空', unsel.ok, `实际 ${JSON.stringify(unsel.got)}`)

console.log('\n=== 5. 一个主题都没有 → 直接进新建（不弹空框） ===')
await evaluate(island, `window.island.settings.save({ topics: [] }); true`)
await sleep(700)
const emptyCapsule = await evaluate(
  island,
  `(() => {
    const vals = [...document.querySelectorAll('.island__vals .island__val')]
    return { text: (vals[1]?.textContent || '').trim() }
  })()`
)
const click3 = await clickElement(island, '.island__vals .island__val', 1)
await sleep(600)
const menuAfterEmpty = await evaluate(island, `!!document.querySelector('.island__menu')`)
check('没弹空列表', menuAfterEmpty === false, `胶囊文字「${emptyCapsule.text}」`)
// 新建流程 = 主窗口被唤起（开发实例自己的主窗口，不是用户那份）
const mainOpened = (await targets()).some(
  (t) => t.type === 'page' && !t.url.endsWith('island.html')
)
check('直接进了新建（主窗口被唤起）', mainOpened)

// 收尾：把主题放回去（只动被测实例）
await evaluate(
  island,
  `window.island.settings.save(${JSON.stringify({ topics: TEST_TOPICS, activeTopicId: null })}); true`
)
await sleep(600)
const restored = data()?.settings?.topics?.length ?? 0
check('收尾：主题放回去了', restored === TEST_TOPICS.length, `实际 ${restored} 个`)

// 收尾：主窗口被"新建主题"送到设置页去了 → 送回计时页
// （不然后面跑端到端的人会看到一堆莫名其妙的 FAIL）
try {
  const pages2 = (await targets()).filter((t) => t.type === 'page')
  const mainT = pages2.find((t) => {
    try {
      const u = new URL(t.url)
      return u.pathname.endsWith('/') && !u.pathname.endsWith('island.html')
    } catch {
      return false
    }
  })
  if (mainT) {
    const mainWs = await connect(mainT.webSocketDebuggerUrl)
    await evaluate(
      mainWs,
      `(() => {
        const btn = [...document.querySelectorAll('.nav__item')].find((b) => (b.textContent || '').trim() === '计时')
        if (btn) btn.click()
        return !!btn
      })()`
    )
    console.log('  （主窗口已送回「计时」页）')
  }
} catch {
  /* 主窗口没开着就算了 */
}

console.log('\n=== 6. 主窗口主题行：跟岛上同一套行为 ===')
// 主窗口是普通窗口，用 DOM 里的 .click() 触发（走的是同一个 React 处理器，
// 这里要验的是**行为一致**，不是鼠标坐标）。
const mainT = (await targets()).filter((t) => t.type === 'page').find((t) => {
  try {
    const u = new URL(t.url)
    return u.pathname.endsWith('/') && !u.pathname.endsWith('island.html')
  } catch {
    return false
  }
})
if (!mainT) {
  check('主窗口在（要验主窗口那侧）', false)
} else {
  const mainWs = await connect(mainT.webSocketDebuggerUrl)
  // 回到计时页
  await evaluate(
    mainWs,
    `(() => {
      const btn = [...document.querySelectorAll('.nav__item')].find((b) => (b.textContent || '').trim() === '计时')
      if (btn) btn.click()
      return !!btn
    })()`
  )
  await sleep(700)

  const chips = await evaluate(
    mainWs,
    `(() => [...document.querySelectorAll('.topics__chip')].map((c) => (c.textContent || '').trim()))()`
  )
  check('计时页的主题行列出了全部主题', chips.length >= 3, `胶囊：${chips.join(' / ')}`)

  // 点一下「操作系统复习」→ 选中
  await evaluate(
    mainWs,
    `(() => {
      const c = [...document.querySelectorAll('.topics__chip')].find((x) => (x.textContent || '').includes('操作系统复习'))
      if (c) c.click()
      return !!c
    })()`
  )
  await sleep(700)
  const selMain = await waitActiveTopicId('topic-mwrgga9f-3ben')
  check('主窗口点主题胶囊 = 选中', selMain.ok, `activeTopicId=${JSON.stringify(selMain.got)}`)
  const onMain = await evaluate(
    mainWs,
    `(() => {
      const c = [...document.querySelectorAll('.topics__chip--on')].map((x) => (x.textContent || '').trim())
      return c
    })()`
  )
  check('选中的那个在主窗口也是亮的', onMain.some((t) => t.includes('操作系统复习')), `亮着：${onMain.join(' / ')}`)

  // 再点一次 → 取消（跟岛上同一条规则）
  await evaluate(
    mainWs,
    `(() => {
      const c = [...document.querySelectorAll('.topics__chip--on')].find((x) => (x.textContent || '').includes('操作系统复习'))
      if (c) c.click()
      return !!c
    })()`
  )
  await sleep(700)
  const unselMain = await waitActiveTopicId(null)
  check('主窗口再点一次 = 取消', unselMain.ok, `activeTopicId=${JSON.stringify(unselMain.got)}`)

  // 设置页的主题管理：没有「未分类」这个伪选项
  await evaluate(
    mainWs,
    `(() => {
      const btn = [...document.querySelectorAll('.nav__item')].find((b) => (b.textContent || '').trim() === '设置')
      if (btn) btn.click()
      return !!btn
    })()`
  )
  await sleep(800)
  const mgrRows = await evaluate(
    mainWs,
    `(() => {
      const rows = [...document.querySelectorAll('.topic-row')].map((r) => (r.textContent || '').trim())
      return rows
    })()`
  )
  check(
    '设置页的主题列表里没有「未分类」这个伪选项',
    !mgrRows.some((r) => r.includes('未分类')),
    `行：${mgrRows.join(' / ')}`
  )
  // 送回计时页
  await evaluate(
    mainWs,
    `(() => {
      const btn = [...document.querySelectorAll('.nav__item')].find((b) => (b.textContent || '').trim() === '计时')
      if (btn) btn.click()
      return !!btn
    })()`
  )
  await sleep(500)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
ps.kill()
process.exit(fail === 0 ? 0 : 1)
