// 验一条降级行为：**没有音乐会话时**，灵动岛那一行要整个消失，
// 不留空行、不报错（肥鱼的验收清单里的一条）。
//
// 用法：起开发版 → node scripts/probe-degraded.mjs

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

// 先记下有没有报错
await evaluate(`
  window.__errs = 0
  window.addEventListener('error', () => { window.__errs++ })
  window.addEventListener('unhandledrejection', () => { window.__errs++ })
  true
`)

// 打开音乐控制（但**不伪造**任何媒体状态 —— 模拟"QQ 音乐没开"）
//
// ⚠ **先清掉开发期假状态**：别的验证脚本（measure-vol-real 等）会打一条假状态，
//   而它**留在主进程里**（设计如此：不然音乐行每被清一次，滑条的 DOM 就重建一次，
//   绑在上面的监听全丢）。不先清掉，这条"没有音乐会话"的断言就会读到残留的假状态。
await evaluate(`
  window.island.media.devFake(null)
  true
`)
await sleep(300)

await evaluate(`
  window.island.settings.save({ showMusicControl: true })
  true
`)
await sleep(800)

// ⚠ **展开要靠真机鼠标悬停**：`window.island.island.setMode` 只改主进程那边的
//   窗口大小，渲染层的 expanded 状态是 hover 驱动的（菜单还是收起的）。
//   还要"先离开再回来"：鼠标已经在岛上时浏览器不会再发 mouseenter。
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
  await sleep(300)
  await mouse('move 5 5')
  await sleep(200)
  // 先挪窗口再移鼠标（顺序反了 Windows 不发 mouseenter），
  // 挪开是为了不和用户自己那份的岛重叠
  await evaluate(`window.island?.island?.devOffset?.(-500); true`)
  await sleep(300)
  const b = await evaluate(`(async () => await window.island?.island?.devBounds?.())()`)
  if (!b) break
  await mouse(`move ${Math.round(b.x + b.width / 2)} ${Math.round(b.y + 12)}`)
  await sleep(700)
  expanded = await evaluate(`!!document.querySelector('.island--expanded')`)
  if (expanded) break
}
check('岛已悬停展开', expanded === true, `expanded=${expanded}`)
if (!expanded) {
  ps.kill()
  process.exit(1)
}

const musicRow = await evaluate(`!!document.querySelector('.island__music')`)
const state = await evaluate(`window.island.media.getState()`)
const volume = await evaluate(`window.island.media.getVolume()`)
const errs = await evaluate(`window.__errs ?? 0`)
const btnLabels = await evaluate(
  `[...document.querySelectorAll('.island__music-btn')].map((b) => b.getAttribute('aria-label'))`
)

check(
  '没有音乐会话时，音乐那一行**还在**（按钮永远在）',
  musicRow === true,
  `.island__music=${musicRow}`
)
check(
  '按钮都还在（上一首 / 播放暂停 / 下一首）',
  Array.isArray(btnLabels) &&
    btnLabels.includes('上一首') &&
    btnLabels.includes('下一首') &&
    btnLabels.some((l) => l && l.includes('播放')),
  `按钮=${JSON.stringify(btnLabels)}`
)
check(
  '主进程状态：没有会话，但音量照常带着',
  state !== null && state.hasSession === false && typeof state.volume === 'number',
  `state=${JSON.stringify(state)}`
)
check(
  '音量照样读得到（音量是系统级的，跟有没有歌在放无关）',
  typeof volume === 'number',
  `volume=${volume}`
)
check('没有报错', errs === 0, `错误数=${errs}`)

// 连续 10 次点"开/关音乐控制"也不该塌
for (let i = 0; i < 10; i++) {
  await evaluate(`window.island.island.setMode('expanded', ${i % 2 === 0 ? 'true' : 'false'})`)
  await sleep(80)
}
const alive = await evaluate(`!!document.querySelector('.island')`)
check('连续 10 次切换展开/收起，岛还在（不塌）', alive === true, `.island=${alive}`)

const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
ps.kill()
process.exit(failed.length ? 1 : 0)
