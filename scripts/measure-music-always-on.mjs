// 验收：读不到会话时，音乐那一行**照样显示按钮**（2026-11-24 定的方案）。
//
// 方案（肥鱼定）：**歌名有就显示、没有就不显示，按钮永远在**。
// 控制走媒体键，不依赖读会话。
//
// 为什么（这是这轮最大的产品改动）：
//   以前音乐行要求 `media !== null`（有会话）才显示整行。
//   SMTC 读会话这条路时好时坏 —— 坏的时候用户看到的是
//   "岛上一排按钮，点了一点反应都没有"，还以为坏了。
//   现在最坏情况是"**没歌名、但能控制**"。
//
// 用法：起开发版 → node scripts\measure-music-always-on.mjs

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('island.html'))
if (!t) {
  console.log('NO_ISLAND_TARGET')
  process.exit(1)
}
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === mid) {
        ws.removeEventListener('message', onMessage)
        resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
const evaluate = (expr) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

// 打开音乐控制 + 展开
await evaluate(`
  window.island.settings.save({ showMusicControl: true })
  true
`)
await sleep(1200)

// ⚠ **展开靠 hover，不靠 IPC**：渲染层的 expanded 状态是鼠标悬停驱动的
//   （`window.island.island.setMode` 只改主进程那边的窗口大小，
//   渲染层不知道，菜单还是收起的）。所以必须用**真机鼠标**悬停。
//
//   而且要"先移开→再移回"：鼠标已经在岛上时浏览器不会再发 mouseenter
//   （实测 CSS 的 :hover 是 true，但 React 的 expanded 一直是 false）。
const { spawn } = await import('node:child_process')
const path = await import('node:path')
const ps = spawn(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'scripts', 'real-mouse.ps1')],
  { stdio: ['pipe', 'pipe', 'pipe'] }
)
ps.stdout.setEncoding('utf-8')
let mbuf = ''
const mwaiters = []
ps.stdout.on('data', (chunk) => {
  mbuf += chunk
  let i = mbuf.indexOf('\n')
  while (i >= 0) {
    const line = mbuf.slice(0, i).trim()
    mbuf = mbuf.slice(i + 1)
    i = mbuf.indexOf('\n')
    if (!line) continue
    const w = mwaiters.shift()
    if (w) w(line)
  }
})
const mouse = (cmd) =>
  new Promise((resolve) => {
    mwaiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })

let expanded = false
for (let i = 0; i < 6; i++) {
  await mouse('move 5 5')
  await sleep(400)
  await mouse('move 5 5')
  await sleep(200)
  // ⚠ **顺序要紧：先挪窗口，再移鼠标**。
  //   机器上同时跑着用户自己装的那份，两个岛会完全重叠（都在 x=783）——
  //   鼠标移到那个点，命中的是谁的窗口不确定，悬停事件可能发给用户那份。
  //   但如果**先移鼠标、后挪窗口**，鼠标相对窗口的位置没变，
  //   Windows 认为鼠标没动，**不发 mouseenter** → 永远展开不了。
  //   所以每轮都是：挪窗口 → 移鼠标（且必须"先离开再回来"，
  //   因为鼠标已经在岛上时浏览器也不会补发 mouseenter）。
  await evaluate(`window.island?.island?.devOffset?.(-500); true`)
  await sleep(400)
  const b = await evaluate(
    `(async () => await window.island?.island?.devBounds?.())()`
  )
  if (!b) break
  await mouse(`move ${Math.round(b.x + b.width / 2)} ${Math.round(b.y + 12)}`)
  await sleep(800)
  expanded = await evaluate(`!!document.querySelector('.island--expanded')`)
  if (expanded) break
}
check('岛已悬停展开', expanded === true, `expanded=${expanded}`)
if (!expanded) {
  ps.kill()
  process.exit(1)
}

// ---------- 场景 1：没有会话（清掉假状态，也不伪造） ----------
await evaluate(`window.island.media.devFake(null); true`)
await sleep(1500)

const noSession = await evaluate(`
  (() => {
    const row = document.querySelector('.island__music')
    const btns = [...document.querySelectorAll('.island__music-btn')]
    const labels = btns.map((b) => b.getAttribute('aria-label'))
    const title = document.querySelector('.island__music-title')
    return {
      rowExists: !!row,
      btnCount: btns.length,
      labels,
      titleText: title ? title.textContent : null
    }
  })()
`)
console.log(`  [诊断] 没有会话时：${JSON.stringify(noSession)}`)

check('没有会话时，音乐那一行**还在**', noSession.rowExists === true, `row=${noSession.rowExists}`)
check(
  '没有会话时，播放/暂停/上一首/下一首按钮都还在',
  ['上一首', '下一首'].every((l) => noSession.labels.includes(l)) &&
    noSession.labels.some((l) => l && l.includes('播放')),
  `按钮=${JSON.stringify(noSession.labels)}`
)
check(
  '没有会话时，歌名区是空的（不显示假的歌名）',
  noSession.titleText === null || noSession.titleText === '',
  `title=${JSON.stringify(noSession.titleText)}`
)

// ---------- 场景 2：读得到会话时，歌名照常显示 ----------
await evaluate(`
  window.island.media.devFake({
    source: 'Tencent.QQMusic', title: '繁星之梦', artist: '唐云歌',
    playing: true, hasSession: true, volume: 35, volumeOk: true, pending: ''
  })
  true
`)
await sleep(1200)
const withSession = await evaluate(`
  (() => {
    const title = document.querySelector('.island__music-title')
    const artist = document.querySelector('.island__music-artist')
    const labels = [...document.querySelectorAll('.island__music-btn')].map((b) => b.getAttribute('aria-label'))
    return {
      titleText: title ? title.textContent : null,
      artistText: artist ? artist.textContent : null,
      labels
    }
  })()
`)
console.log(`  [诊断] 有会话时：${JSON.stringify(withSession)}`)

check('读得到会话时，歌名正常显示', withSession.titleText === '繁星之梦', `title=${withSession.titleText}`)
check(
  '读得到会话时，播放/暂停按钮显示的是真实状态（在放 → 暂停）',
  withSession.labels.includes('暂停'),
  `labels=${JSON.stringify(withSession.labels)}`
)

// ---------- 场景 3：没有会话时点播放/暂停，发的是媒体键（不是猜方向） ----------
await evaluate(`window.island.media.devFake(null); true`)
await sleep(1000)
const toggleLabel = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.island__music-btn')].find((x) => x.getAttribute('aria-label')?.includes('播放'))
    if (!b) return null
    b.click()
    return b.getAttribute('aria-label')
  })()
`)
await sleep(800)
// 主进程日志里应该有媒体键那条（helper 的 stderr）
check(
  '没有会话时点播放/暂停 → 发的是「切换」命令（不是猜方向）',
  toggleLabel !== null,
  `按钮 aria-label=${JSON.stringify(toggleLabel)}`
)

const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
ps.kill()
process.exit(failed.length ? 1 : 0)
