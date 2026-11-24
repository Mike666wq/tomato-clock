// 端到端旅程验证：跑完整的用户旅程，每一步把界面上的数字和 data.json 对一遍。
//
// 用法：
//   1) 先起一个独立的实例（别用用户的正式版，它正开着会撞单实例锁）：
//        node_modules\electron\dist\electron.exe . --user-data-dir=<项目>\.tmp\e2e
//   2) node scripts/e2e-journey.mjs
//
// 阶段：
//   E2E_STAGE=journey（默认）  完整旅程 + 竞态复现 + 跨零点口径
//   E2E_STAGE=restore          重启之后验证恢复（另一次进程跑）
//
// 环境变量：
//   CDP_PORT     默认 9222
//   E2E_DATA     默认 <项目>\.tmp\e2e\data.json
//   E2E_SNAPSHOT 默认 <项目>\.tmp\e2e\running.json
//
// 数据文件是唯一真相源：界面说的必须和它一致，对不上就是 bug。

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { preflight } from './preflight.mjs'

const port = process.env.CDP_PORT ?? '9222'
const stage = process.env.E2E_STAGE ?? 'journey'
const projectRoot = process.cwd()
const dataFile = process.env.E2E_DATA ?? path.join(projectRoot, '.tmp', 'e2e', 'data.json')
const snapshotFile = process.env.E2E_SNAPSHOT ?? path.join(projectRoot, '.tmp', 'e2e', 'running.json')

// ================= 开跑前自检 =================
//
// 肥鱼立的规矩：脚本没有前置自检，全靠人记文档 —— 记忆会失手，脚本不会。
// 自检不过直接停，不许带病往下跑（带病跑出来的 FAIL 是"测试环境坏了"，
// 不是"程序坏了" —— 这个误判已经吃过一次，15 项一起红）。
const pre = preflight({
  dataFile,
  snapshotFile,
  label: '端到端旅程',
  needResize: true
})
console.log(`# 自检通过：userData=${pre.userData}`)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- CDP 小工具 ----------

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

function evaluate(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else if (msg.result?.exceptionDetails) {
          reject(new Error(
            msg.result.exceptionDetails.text + ' ' +
            (msg.result.exceptionDetails.exception?.description ?? '')
          ))
        } else resolve(msg.result?.result?.value ?? null)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    }))
    setTimeout(() => reject(new Error('evaluate timeout')), 20000)
  })
}

/** 通用 CDP 命令（Browser.* 这些不是 Runtime.evaluate） */
function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result ?? null)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => reject(new Error(`${method} timeout`)), 15000)
  })
}

const pathOf = (t) => {
  try {
    return new URL(t.url).pathname
  } catch {
    return t.url
  }
}

async function pickTarget(which) {
  const pages = (await targets()).filter((t) => t.type === 'page')
  const hit = which === 'island'
    ? pages.filter((p) => pathOf(p).includes('island'))
    : pages.filter((p) => pathOf(p) === '/' || (pathOf(p).endsWith('index.html') && !pathOf(p).includes('island')))
  return hit[0] ?? null
}

async function waitTarget(which, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const t = await pickTarget(which)
      if (t) return t
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error(`等不到 ${which} 窗口（CDP ${port}）`)
}

// ---------- 数据文件 ----------

let dataCorrupt = false
function readData() {
  if (!existsSync(dataFile)) return { schemaVersion: 3, settings: {}, sessions: [] }
  try {
    return JSON.parse(readFileSync(dataFile, 'utf-8'))
  } catch (err) {
    dataCorrupt = true
    return { schemaVersion: 3, settings: {}, sessions: [] }
  }
}

function writeData(data) {
  // 临时文件名必须和程序自己的 .tmp 错开：
  // 程序写盘也是"写 .tmp 再 rename"，用同一个临时文件会把两份内容搅在一起。
  const tmp = `${dataFile}.e2e.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, dataFile)
}

const todayKey = () => new Date().toLocaleDateString('sv-SE')

/** 按"结束时间算今天"的口径数一遍（主界面 buildSummary 的口径） */
function countByEndedAt(sessions) {
  return sessions.filter(
    (s) => s.kind === 'focus' && s.completed &&
      new Date(s.endedAt).toLocaleDateString('sv-SE') === todayKey()
  ).length
}

/** 按"开始时间算今天"的口径数一遍（统计页 buildStats 的口径） */
function countByStartedAt(sessions) {
  return sessions.filter(
    (s) => s.kind === 'focus' && s.completed &&
      new Date(s.startedAt).toLocaleDateString('sv-SE') === todayKey()
  ).length
}

/** 界面上的"今天 N 个 · X 分钟" */
async function statusText(main) {
  return evaluate(main, "document.querySelector('.status')?.textContent?.trim() ?? ''")
}

function parseStatus(text) {
  const m = /今天\s*(\d+)\s*个\s*·\s*(\d+)\s*分钟/.exec(text ?? '')
  return m ? { count: Number(m[1]), minutes: Number(m[2]) } : null
}

// ---------- 主流程 ----------

const mainTarget = await waitTarget('main')
const islandTarget = await pickTarget('island')
const main = await connect(mainTarget.webSocketDebuggerUrl)
const island = islandTarget ? await connect(islandTarget.webSocketDebuggerUrl) : null
console.log(`# main  = ${mainTarget.url}`)
console.log(`# island= ${islandTarget ? islandTarget.url : '(没有灵动岛窗口)'}`)

/**
 * 收尾。
 *
 * 必须先把 WebSocket 关掉再退出：Node 的 undici WebSocket 在 Windows 上
 * 直接 process.exit 会崩（退出码 0xC0000409），那次崩会把"断言全过"的
 * 结果变成"进程异常结束"。
 */
function finish(code) {
  try {
    main.close()
  } catch {
    /* 忽略 */
  }
  try {
    island?.close()
  } catch {
    /* 忽略 */
  }
  setTimeout(() => process.exit(code), 300)
}

if (stage === 'corrupt') {
  // ---- D6：数据文件写坏了会怎样 ----
  // 前提：外面已经把 data.json 写坏、杀掉了程序、又重新起来了。
  // 验收：不崩、原件被备份、用户看得见提示。
  const st = await evaluate(main, 'window.pomodoro.timer.getState()')
  check('D6 数据文件坏了：程序没崩，照样能取到状态', st !== null && typeof st.phase === 'string',
    `phase=${st?.phase}`)

  const dir = path.dirname(dataFile)
  const backups = readdirSync(dir).filter((f) => f.startsWith('data.json.corrupt-'))
  check('D6 数据文件坏了：原件被改名备份了', backups.length > 0,
    `备份文件：${backups.join(', ') || '没有'}`)

  if (backups.length > 0) {
    const backupText = readFileSync(path.join(dir, backups[0]), 'utf-8')
    check('D6 备份里就是那份坏文件（没被覆盖）',
      backupText.includes('E2E-CORRUPT-MARKER'),
      `备份内容前 60 字：${JSON.stringify(backupText.slice(0, 60))}`)
  }

  const logText = existsSync(path.join(dir, 'app.log'))
    ? readFileSync(path.join(dir, 'app.log'), 'utf-8')
    : ''
  check('D6 数据文件坏了：日志里记了 ERROR',
    logText.includes('数据文件损坏'),
    logText.split('\n').filter((l) => l.includes('损坏')).slice(-1)[0] ?? '日志里没有')

  // 启动时那条提示可能被后来的提示顶掉（快捷键注册失败也会弹提示），
  // 所以这里再验一次**运行中**遇到坏文件时的路径：这一次提示是实时推给界面的。
  await evaluate(
    main,
    'window.__e2eNotices = []; window.pomodoro.notice.onShow((n) => window.__e2eNotices.push(n.text))'
  )
  await writeFileSync(dataFile, '{"sessions": [ {"broken": true, "note": "E2E-CORRUPT-MARKER"', 'utf-8')
  await evaluate(main, 'window.pomodoro.records.summary()').catch(() => {})
  await sleep(1500)
  const notices6 = await evaluate(main, 'window.__e2eNotices ?? []')
  check('D6 运行中读到坏文件：界面上立刻有提示',
    Array.isArray(notices6) && notices6.some((t) => String(t).includes('损坏')),
    `收到的提示：${JSON.stringify(notices6)}`)
  const backups2 = readdirSync(dir).filter((f) => f.startsWith('data.json.corrupt-'))
  check('D6 运行中读到坏文件：也留了备份', backups2.length >= 2,
    `备份文件：${backups2.join(', ') || '没有'}`)

  console.log(JSON.stringify({ results }, null, 2))
  finish(results.some((r) => !r.ok) ? 1 : 0)
}

if (stage === 'restore') {
  // ---- 重启恢复：快照 vs 界面 ----
  const snap = JSON.parse(readFileSync(snapshotFile, 'utf-8'))
  const st = await evaluate(main, 'window.pomodoro.timer.getState()')
  check('R1 恢复后阶段与快照一致', st.phase === snap.phase, `快照=${snap.phase} 界面=${st.phase}`)
  check('R2 恢复后剩余时间与快照一致（流逝的时间不补）',
    Math.abs(st.remainingSec - snap.remainingSec) <= 1,
    `快照=${snap.remainingSec} 界面=${st.remainingSec}`)
  check('R3 恢复后是暂停态', st.running === false, `running=${st.running}`)
  check('R4 恢复后 focusRounds 没归零',
    st.focusRounds === snap.focusRounds, `快照=${snap.focusRounds} 界面=${st.focusRounds}`)
  const status = parseStatus(await statusText(main))
  const data = readData()
  check('R5 界面"今天 N 个"与 data.json 一致',
    status !== null && status.count === countByStartedAt(data.sessions),
    `界面=${status?.count} 磁盘(按开始时间)=${countByStartedAt(data.sessions)} ` +
    `磁盘(按开始时间)=${countByStartedAt(data.sessions)}`)
  console.log(JSON.stringify({ results }, null, 2))
  finish(results.some((r) => !r.ok) ? 1 : 0)
}

// ================= journey =================

/**
 * 归位到"计时"页。
 *
 * ⚠ 主窗口可能被别人停在别的页（灵动岛的「＋ 新建主题」会把它送到设置页），
 *   那时 `.status`（今天 N 个）根本不存在 → 好几条断言会莫名其妙地 FAIL。
 *   这里直接点导航栏的「计时」，跟用户点的一样。
 */
await evaluate(main, `(() => {
  const btn = [...document.querySelectorAll('.nav__item')].find((b) => (b.textContent || '').trim() === '计时')
  if (btn) btn.click()
  return !!btn
})()`)
await sleep(600)

// ---- 归位：把计时器拨回"未开始的专注段"，保证下面的断言从已知状态出发 ----
for (let i = 0; i < 6; i++) {
  const st = await evaluate(main, 'window.pomodoro.timer.getState()')
  if (st.phase === 'focus') break
  await evaluate(main, "window.pomodoro.timer.action('skip')").catch(() => {})
  await sleep(700)
}
await evaluate(main, "window.pomodoro.timer.action('reset')").catch(() => {})
await sleep(600)

const data0 = readData()
const n0 = data0.sessions.length
console.log(`# 起始 sessions = ${n0}`)
if (dataCorrupt) {
  check('S0 起始 data.json 是合法 JSON', false, '文件已经是坏的（上一轮跑坏了）')
}

// ---- S0b 装一个 1 分钟的模板（用来在一分钟里跑完一段，而不是等 25 分钟）----
const presets = Array.isArray(data0.settings?.presets) ? data0.settings.presets : []
const fastPreset = {
  id: 'e2e-fast',
  name: 'E2E快测',
  focusMin: 1,
  shortMin: 1,
  longMin: 1,
  roundsBeforeLong: 4,
  builtin: false,
  order: 99
}
await evaluate(
  main,
  `window.pomodoro.settings.save({presets: ${JSON.stringify([...presets, fastPreset])}, activePresetId: 'e2e-fast'})`
)
await sleep(900)
const s0 = await evaluate(main, 'window.pomodoro.timer.getState()')
check('S0b 切到 1 分钟模板后这一段就是 60 秒', s0.totalSec === 60, `totalSec=${s0.totalSec}`)

// ---- S1 开始：主窗口发起，灵动岛必须跟着 ----
await evaluate(main, "window.pomodoro.timer.action('start')")
await sleep(1400)
const s1 = await evaluate(main, 'window.pomodoro.timer.getState()')
const s1i = island ? await evaluate(island, 'window.island.timer.getState()') : null
check('S1 开始后主窗口 running=true', s1.running === true, `running=${s1.running}`)
check('S1 灵动岛跟着变 running=true', s1i ? s1i.running === true : false, `island=${s1i?.running}`)
check('S1 两窗口读数一致（差 ≤1 秒）',
  s1i ? Math.abs(s1.remainingSec - s1i.remainingSec) <= 1 : false,
  `main=${s1.remainingSec} island=${s1i?.remainingSec}`)

// ---- S2 暂停：剩余必须冻结 ----
await evaluate(main, "window.pomodoro.timer.action('pause')")
await sleep(400)
const p1 = await evaluate(main, 'window.pomodoro.timer.getState()')
await sleep(1600)
const p2 = await evaluate(main, 'window.pomodoro.timer.getState()')
check('S2 暂停后剩余时间冻结', p1.remainingSec === p2.remainingSec,
  `暂停时=${p1.remainingSec} 一秒半后=${p2.remainingSec}`)
check('S2 暂停后 running=false', p2.running === false, `running=${p2.running}`)

// ---- S3 继续 ----
await evaluate(main, "window.pomodoro.timer.action('toggle')")
await sleep(1300)
const s3 = await evaluate(main, 'window.pomodoro.timer.getState()')
check('S3 继续后 running=true 且剩余在减',
  s3.running === true && s3.remainingSec < p2.remainingSec,
  `running=${s3.running} 剩余=${s3.remainingSec}(暂停时 ${p2.remainingSec})`)

// ---- S4 跳过专注段：写一条未完成记录、不自动开始、进短休 ----
await evaluate(main, "window.pomodoro.timer.action('skip')")
await sleep(1200)
const s4 = await evaluate(main, 'window.pomodoro.timer.getState()')
const d4 = readData()
const skipped = d4.sessions[d4.sessions.length - 1]
check('S4 跳过后进短休（不是长休）', s4.phase === 'short', `phase=${s4.phase}`)
check('S4 跳过后不自动开始', s4.running === false, `running=${s4.running}`)
check('S4 跳过写了一条 completed=false 的专注记录',
  d4.sessions.length === n0 + 1 && skipped?.kind === 'focus' && skipped?.completed === false,
  `新增=${d4.sessions.length - n0} 最后一条 completed=${skipped?.completed}`)
const st4 = parseStatus(await statusText(main))
check('S4 跳过不计入"今天 N 个"',
  st4 !== null && st4.count === countByStartedAt(d4.sessions),
  `界面=${st4?.count} 磁盘=${countByStartedAt(d4.sessions)}`)

// ---- S4b 跳过休息段：不写记录，回到专注段 ----
await evaluate(main, "window.pomodoro.timer.action('skip')")
await sleep(1200)
const s4b = await evaluate(main, 'window.pomodoro.timer.getState()')
const d4b = readData()
check('S4b 跳过休息段不写记录', d4b.sessions.length === n0 + 1,
  `sessions=${d4b.sessions.length}（期望 ${n0 + 1}）`)
check('S4b 跳过休息段后回到专注段', s4b.phase === 'focus', `phase=${s4b.phase}`)

// ---- S5 跑完一整段专注（1 分钟模板）----
await evaluate(main, "window.pomodoro.timer.action('start')")
await sleep(1500)
const running5 = await evaluate(main, 'window.pomodoro.timer.getState()')
check('S5 专注段在跑', running5.running === true && running5.phase === 'focus',
  `running=${running5.running} phase=${running5.phase} 剩余=${running5.remainingSec}`)

// 等待自然走完（最多 90 秒）。等待期间不断并发提交记录，
// 用来复现"addSession 和 updateSession 撞在一起"（见 S8）。
const hammer = setInterval(() => {
  const id = d4.sessions[0]?.id
  if (id) evaluate(main, `window.pomodoro.records.submit(${JSON.stringify(id)}, '并发', 'none')`).catch(() => {})
}, 150)
let s5 = null
for (let i = 0; i < 100; i++) {
  await sleep(1000)
  s5 = await evaluate(main, 'window.pomodoro.timer.getState()')
  if (s5.phase !== 'focus') break
}
clearInterval(hammer)
await sleep(1200)
const d5 = readData()
const done = d5.sessions[d5.sessions.length - 1]
check('S5 跑完后进短休', s5?.phase === 'short', `phase=${s5?.phase}`)
check('S5 落了一条 completed=true 的专注记录',
  d5.sessions.length === n0 + 2 && done?.kind === 'focus' && done?.completed === true,
  `新增=${d5.sessions.length - n0} completed=${done?.completed} plannedSec=${done?.plannedSec}`)
check('S5 记录的 plannedSec 是这一段冻结的时长（60）', done?.plannedSec === 60,
  `plannedSec=${done?.plannedSec}`)
check('S5 记录的 actualSec 与计划一致', done?.actualSec === 60, `actualSec=${done?.actualSec}`)

// ---- S6 记录卡片提交：任务名 + 打断原因要写回磁盘 ----
const doneId = done?.id
await evaluate(main, `window.pomodoro.records.submit(${JSON.stringify(doneId)}, '写代码', 'internal')`)
await sleep(900)
const d6 = readData()
const rec6 = d6.sessions.find((s) => s.id === doneId)
check('S6 提交后任务名与打断原因写回磁盘',
  rec6?.task === '写代码' && rec6?.interrupt === 'internal',
  `task=${rec6?.task} interrupt=${rec6?.interrupt}`)

// ---- S7 界面"今天 N 个"与 data.json 对账 ----
const st5 = parseStatus(await statusText(main))
const sum5 = await evaluate(main, 'window.pomodoro.records.summary()')
const stat5 = await evaluate(main, 'window.pomodoro.stats.get()')
check('S7 主界面状态行与 data.json 一致（按开始时间）',
  st5 !== null && st5.count === countByStartedAt(d6.sessions),
  `状态行=${st5?.count} 磁盘=${countByStartedAt(d6.sessions)}`)
check('S7 主进程汇总与 data.json 一致（按开始时间）',
  sum5?.todayCount === countByStartedAt(d6.sessions),
  `汇总=${sum5?.todayCount} 磁盘=${countByStartedAt(d6.sessions)}`)
check('S7 统计页与主界面今日数一致（按开始时间）',
  stat5?.todayCount === countByStartedAt(d6.sessions),
  `统计页=${stat5?.todayCount} 磁盘(按开始时间)=${countByStartedAt(d6.sessions)}`)

// ================= D1：并发保存两个不相干的设置 =================
//
// 修之前的写法是"读整份 → 并一个字段 → 写回整份"，
// 两个请求读到同一份旧快照，谁后写谁就把对方的改动覆盖掉。
// 修法：设置单例 + 串行队列 + 合并内存里的当前值。
//
// 验收（肥鱼定的）：**连续 20 轮零丢失**。
const themes = ['neon', 'paper', 'neon', 'ios']
let lostRounds = 0
let lastDetail = ''
for (let r = 0; r < 20; r++) {
  const th = themes[r % themes.length]
  const vol = Math.round((0.1 + (r % 5) * 0.1) * 100) / 100
  // 同一个 tick 里发出两个请求
  evaluate(main, `window.pomodoro.settings.save({uiTheme:${JSON.stringify(th)}})`).catch(() => {})
  evaluate(main, `window.pomodoro.settings.save({volume:${vol}})`).catch(() => {})
  await sleep(450)
  const d = readData()
  const gotTheme = d.settings?.uiTheme
  const gotVol = d.settings?.volume
  if (gotTheme !== th || Math.abs((gotVol ?? -1) - vol) > 1e-9) {
    lostRounds++
    lastDetail = `第${r + 1}轮：要 theme=${th} volume=${vol}，磁盘上 theme=${gotTheme} volume=${gotVol}`
  }
}
check('D1 并发保存两个不相干的设置：20 轮零丢失',
  lostRounds === 0,
  lostRounds ? `${lostRounds}/20 轮丢改动 —— ${lastDetail}` : '20 轮都没丢')

// ================= D5：坏值不许落盘 =================
//
// 传一个 uiTheme: 123 —— 磁盘文件必须**一个字节都不变**，界面上要有提示。
const bytesBefore = readFileSync(dataFile)
// 先挂一个通知监听，把主进程推来的提示收下来
await evaluate(
  main,
  'window.__e2eNotices = []; window.pomodoro.notice.onShow((n) => window.__e2eNotices.push(n.text))'
)
await evaluate(main, 'window.pomodoro.settings.save({uiTheme: 123})').catch(() => {})
await sleep(1200)
const bytesAfter = readFileSync(dataFile)
check('D5 传一个坏值：磁盘文件一个字节都没变',
  Buffer.compare(bytesBefore, bytesAfter) === 0,
  `前 ${bytesBefore.length} 字节 / 后 ${bytesAfter.length} 字节`)
const notices5 = await evaluate(main, 'window.__e2eNotices ?? []')
check('D5 传一个坏值：界面上有提示',
  Array.isArray(notices5) && notices5.length > 0 && String(notices5[0]).includes('设置'),
  `收到的提示：${JSON.stringify(notices5)}`)
const toast5 = await evaluate(main, "document.querySelector('.toast')?.textContent ?? ''")
check('D5 传一个坏值：提示条真的显示出来了', String(toast5).includes('设置'),
  `提示条内容="${toast5}"`)

// ---- D5b：删掉"正在用的那个模板"，删除不能被校验挡下来 ----
// 界面删除模板时会连发两个保存：先"模板列表变了"，再"换个模板"。
// 中间那一刻 activePresetId 指向已经不存在的模板 —— 那是正常状态，
// 存储层要把它修正掉，而不是把整次保存拒了。
const d5b = readData()
const presetList = Array.isArray(d5b.settings?.presets) ? d5b.settings.presets : []
const activeOne = presetList.find((p) => p.id === d5b.settings?.activePresetId)
if (activeOne) {
  const rest = presetList.filter((p) => p.id !== activeOne.id)
  await evaluate(main, `window.pomodoro.settings.save({presets: ${JSON.stringify(rest)}})`)
    .catch(() => {})
  await sleep(800)
  await evaluate(main, "window.pomodoro.settings.save({activePresetId:'builtin-classic'})")
    .catch(() => {})
  await sleep(1000)
  const d5b2 = readData()
  const names5b = (d5b2.settings?.presets ?? []).map((p) => p.id)
  check('D5b 删掉正在用的模板：删除生效了，且没有报错',
    !names5b.includes(activeOne.id) &&
      d5b2.settings?.activePresetId === 'builtin-classic' &&
      names5b.length === presetList.length - 1,
    `模板数=${names5b.length}(期望 ${presetList.length - 1}) 当前模板=${d5b2.settings?.activePresetId}`)
} else {
  check('D5b 删掉正在用的模板', false, '找不到当前模板')
}

// ================= D2：拖窗口不能把设置顶回去 =================
//
// 窗口每次 resize / move 都会 saveBounds。以前它"读整份设置 → 写回整份"，
// 用的那份快照可能比主题改动更旧，于是拖一下窗口主题就变回去了。
//
// 这里用真的 Win32 调用拖 20 次（scripts/resize-window.ps1），
// 不是 CDP 改尺寸 —— 走的是用户真的拖窗口那条路径。
const pList = Array.isArray(d6.settings?.presets) ? d6.settings.presets : []
const presetB = pList[1]?.id ?? pList[0]?.id
// 基准值现取：前面的用例（比如删模板）可能已经换过当前模板了，
// 这里要验的是"拖窗口不会把它顶回去"，不是"它等于某个写死的值"
const presetBefore = readData().settings?.activePresetId
await evaluate(main, `window.pomodoro.settings.save({uiTheme:'ios'})`).catch(() => {})
await evaluate(main, 'window.pomodoro.settings.save({volume:0.77})').catch(() => {})
await sleep(800)
let resizeOut = ''
try {
  const resizeArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(projectRoot, 'scripts', 'resize-window.ps1'), '-Times', '20']
  // 机器上可能同时开着正式版和被测的打包版，必须只拖被测的那一个。
  // **按可执行文件路径筛**，不按命令行片段筛（片段会匹配到"自己这条命令"）。
  const resizeExe = process.env.E2E_RESIZE_EXE
  if (resizeExe) resizeArgs.push('-ExePathLike', resizeExe)
  resizeOut = execFileSync('powershell', resizeArgs, { encoding: 'utf-8' })
} catch (err) {
  resizeOut = `拖窗口失败：${err.message}`
}
await sleep(2000)
const d2 = readData()
check('D2 拖窗口 20 次后，主题/音量/模板都还在',
  String(resizeOut).includes('RESIZED') &&
    d2.settings?.uiTheme === 'ios' &&
    Math.abs((d2.settings?.volume ?? -1) - 0.77) < 1e-9 &&
    d2.settings?.activePresetId === presetBefore,
  `主题=${d2.settings?.uiTheme}(期望 ios) 音量=${d2.settings?.volume}(期望 0.77) ` +
  `模板=${d2.settings?.activePresetId}(期望 ${presetBefore})；${String(resizeOut).trim()}`)

// ---- S9 两窗口读数是否打架（H4）----
if (island) {
  // 在灵动岛里切模板，主界面的高亮要跟着变
  const target = pList.find((p) => p.id === presetB)
  await evaluate(island, `window.island.settings.save({activePresetId:${JSON.stringify(presetB)}})`)
  await sleep(900)
  const chip = await evaluate(main, "document.querySelector('.presets__chip--on')?.textContent?.trim() ?? ''")
  check('S9 灵动岛切模板后主界面高亮跟着变',
    (target?.name ?? '') && chip.includes(target.name),
    `主界面高亮="${chip}" 期望包含="${target?.name}"`)
  const islState = await evaluate(island, 'window.island.timer.getState()')
  const mainState = await evaluate(main, 'window.pomodoro.timer.getState()')
  check('S9 两窗口计时读数一致',
    islState?.phase === mainState?.phase &&
      Math.abs(islState?.remainingSec - mainState?.remainingSec) <= 1,
    `island=${islState?.phase}/${islState?.remainingSec} main=${mainState?.phase}/${mainState?.remainingSec}`)
} else {
  check('S9 灵动岛', false, '没有灵动岛窗口，跳过')
}

// ================= D3：跨零点只有一个口径 =================
//
// 造一条"昨天 23:50 开始、今天 00:10 结束"的番茄：
// 按开始时间归属，它算**昨天**的 —— 主界面和统计页都必须不把它算进今天，
// 而且两边的"今天"必须是同一个数。
const now = new Date()
const yStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 50, 0)
const yEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 10, 0)
const d10 = readData()
const before10 = countByStartedAt(d10.sessions)
d10.sessions.push({
  id: 'e2e-cross-midnight',
  kind: 'focus',
  startedAt: yStart.toISOString(),
  endedAt: yEnd.toISOString(),
  plannedSec: 1200,
  actualSec: 1200,
  completed: true,
  task: 'E2E跨零点',
  interrupt: 'none'
})
writeData(d10)
await sleep(500)
const sum10 = await evaluate(main, 'window.pomodoro.records.summary()')
const stat10 = await evaluate(main, 'window.pomodoro.stats.get()')
check('D3 跨零点的番茄：主界面与统计页给出同一个数',
  sum10?.todayCount === stat10?.todayCount,
  `主界面=${sum10?.todayCount} 统计页=${stat10?.todayCount}（旧口径按结束时间算是 ${countByEndedAt(d10.sessions)}）`)
check('D3 跨零点的番茄：不计入今天（按开始时间属于昨天）',
  sum10?.todayCount === before10,
  `今天=${sum10?.todayCount} 期望=${before10}（这条属于昨天）`)

// ================= D4：跨零点后主界面要自己对上 =================
//
// 用注入的时钟把"现在"推到第二天 23:59:55，等它真的跨过零点：
// 主进程到了零点会重算并推一次，主界面的"今天"必须归零，
// 而且和统计页一致（不能一个 0 一个 1）。
const hasClock = await evaluate(main, 'typeof window.pomodoro.dev?.clockSet === "function"')
const skipDev = process.env.E2E_SKIP_DEV === '1'
if (!hasClock && skipDev) {
  // 打包版没有开发期的时钟口子（这是对的：产物里不该有开发期入口）。
  // 这一条只能在开发版上验，打包版跳过。
  console.log('SKIP D4（打包版没有开发期时钟口子）')
} else if (!hasClock) {
  check('D4 跨零点后主界面归零且与统计页一致', false,
    '这个构建没有开发期的时钟口子（要用开发版跑这一条）')
} else {
  const now4 = new Date()
  const target4 = new Date(
    now4.getFullYear(), now4.getMonth(), now4.getDate() + 1, 23, 59, 55, 0
  )
  const offset4 = target4.getTime() - now4.getTime()
  const beforeCount = sum10?.todayCount ?? 0
  await evaluate(main, `window.pomodoro.dev.clockSet(${offset4})`)
  await sleep(14000) // 跨过零点，等主进程那一推到达界面
  const sum4 = await evaluate(main, 'window.pomodoro.records.summary()')
  const stat4 = await evaluate(main, 'window.pomodoro.stats.get()')
  const st4 = parseStatus(await statusText(main))
  check('D4 跨零点后主界面归零，且与统计页一致',
    sum4?.todayCount === 0 && stat4?.todayCount === 0 && st4?.count === 0,
    `跨零点前=${beforeCount} 跨零点后 主界面=${sum4?.todayCount} 统计页=${stat4?.todayCount} 状态行=${st4?.count}`)
  // 把时钟推回去，别影响后面的步骤
  await evaluate(main, 'window.pomodoro.dev.clockSet(0)')
  await sleep(800)
}

console.log('\n===== 汇总 =====')
const failed = results.filter((r) => !r.ok)
console.log(`共 ${results.length} 项，失败 ${failed.length} 项`)
for (const f of failed) console.log(`  FAIL ${f.name} :: ${f.detail}`)
finish(failed.length ? 1 : 0)
