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

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'

const port = process.env.CDP_PORT ?? '9222'
const stage = process.env.E2E_STAGE ?? 'journey'
const projectRoot = process.cwd()
const dataFile = process.env.E2E_DATA ?? path.join(projectRoot, '.tmp', 'e2e', 'data.json')
const snapshotFile = process.env.E2E_SNAPSHOT ?? path.join(projectRoot, '.tmp', 'e2e', 'running.json')

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
    : pages.filter((p) => pathOf(p).endsWith('index.html') && !pathOf(p).includes('island'))
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
    status !== null && status.count === countByEndedAt(data.sessions),
    `界面=${status?.count} 磁盘(按结束时间)=${countByEndedAt(data.sessions)} ` +
    `磁盘(按开始时间)=${countByStartedAt(data.sessions)}`)
  console.log(JSON.stringify({ results }, null, 2))
  process.exit(results.some((r) => !r.ok) ? 1 : 0)
}

// ================= journey =================

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
  st4 !== null && st4.count === countByEndedAt(d4.sessions),
  `界面=${st4?.count} 磁盘=${countByEndedAt(d4.sessions)}`)

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
check('S7 主界面状态行与 data.json 一致（按结束时间）',
  st5 !== null && st5.count === countByEndedAt(d6.sessions),
  `状态行=${st5?.count} 磁盘=${countByEndedAt(d6.sessions)}`)
check('S7 主进程汇总与 data.json 一致（按结束时间）',
  sum5?.todayCount === countByEndedAt(d6.sessions),
  `汇总=${sum5?.todayCount} 磁盘=${countByEndedAt(d6.sessions)}`)
check('S7 统计页与主界面今日数一致（按开始时间）',
  stat5?.todayCount === countByStartedAt(d6.sessions),
  `统计页=${stat5?.todayCount} 磁盘(按开始时间)=${countByStartedAt(d6.sessions)}`)

// ---- S8 并发写设置（H1 复现）----
// 两个**不相干**的字段同时保存：主题 和 深浅。
// 主进程的写法是"读整个 settings → 合并一个字段 → 写回整个 settings"，
// 两个请求都读到同一份旧快照，谁后写谁就把对方的改动覆盖掉。
const themes = ['neon', 'paper', 'neon', 'ios']
const modes = ['light', 'dark', 'light', 'dark']
let lostRounds = 0
let lastDetail = ''
for (let r = 0; r < 4; r++) {
  const th = themes[r]
  const md = modes[r]
  // 同一个 tick 里发出两个请求：它们会读到同一份旧快照
  evaluate(main, `window.pomodoro.settings.save({uiTheme:${JSON.stringify(th)}})`).catch(() => {})
  evaluate(main, `window.pomodoro.settings.save({uiMode:${JSON.stringify(md)}})`).catch(() => {})
  await sleep(900)
  const d = readData()
  const gotTheme = d.settings?.uiTheme
  const gotMode = d.settings?.uiMode
  if (gotTheme !== th || gotMode !== md) {
    lostRounds++
    lastDetail = `第${r + 1}轮：要 theme=${th} mode=${md}，磁盘上 theme=${gotTheme} mode=${gotMode}`
  }
}
check('S8 并发保存两个不相干的设置：两次改动都在',
  lostRounds === 0,
  lostRounds ? `${lostRounds}/4 轮丢改动 —— ${lastDetail}` : '4 轮都没丢')

// ---- S8b 高并发写之后，data.json 还是不是合法 JSON ----
// 程序的写盘是"写 .tmp 再 rename"，所有并发写共用同一个 .tmp 文件名。
// 两个写同时进行时，内容会搅在一起 → 文件变成非法 JSON。
const hammerCount = 40
const recId0 = readData().sessions[0]?.id
for (let i = 0; i < hammerCount; i++) {
  evaluate(main, `window.pomodoro.settings.save({activeTopicId:${JSON.stringify(i % 2 ? null : 'x')}})`)
    .catch(() => {})
  if (recId0) {
    evaluate(main, `window.pomodoro.records.submit(${JSON.stringify(recId0)}, '压测${i}', 'none')`)
      .catch(() => {})
  }
}
await sleep(3000)
let jsonOk = true
let jsonErr = ''
try {
  JSON.parse(readFileSync(dataFile, 'utf-8'))
} catch (err) {
  jsonOk = false
  jsonErr = err.message
}
check('S8b 高并发写之后 data.json 仍是合法 JSON', jsonOk,
  jsonOk ? `${hammerCount * 2} 次并发写，文件正常` : jsonErr)

// ---- S8c 写坏之后程序会怎样（读不出来就当默认数据，下次写就把历史抹掉）----
if (!jsonOk) {
  const sum = await evaluate(main, 'window.pomodoro.records.summary()').catch(() => null)
  let onDisk = '读不出来'
  try {
    onDisk = `${JSON.parse(readFileSync(dataFile, 'utf-8')).sessions.length} 条`
  } catch {
    /* 文件已经坏了 */
  }
  check('S8c 写坏后程序没崩，但会把坏文件当默认数据（历史被无视）',
    sum !== null && sum?.totalFocusSec === 0,
    `汇总 totalFocusSec=${sum?.totalFocusSec}（磁盘里明明有 ${onDisk}）`)
}

// ---- S8d 缩放窗口会不会把刚改的设置冲掉 ----
const pList = Array.isArray(d6.settings?.presets) ? d6.settings.presets : []
const presetB = pList[1]?.id ?? pList[0]?.id
// 窗口每次 resize / move 都会 saveBounds：读整个 settings → 写回整个 settings。
// 和设置保存是同一条路，所以拖一下窗口就可能把刚改的主题顶回去。
try {
  const pages = await targets()
  const mainT = pages.find((p) => p.type === 'page' && !p.url.includes('island'))
  const winId = await send(main, 'Browser.getWindowForTarget', { targetId: mainT.id })
  const b0 = await send(main, 'Browser.getWindowBounds', { windowId: winId.windowId })
  const w0 = b0.bounds.width
  const h0 = b0.bounds.height
  const th = 'neon'
  evaluate(main, `window.pomodoro.settings.save({uiTheme:${JSON.stringify(th)}})`).catch(() => {})
  for (let i = 0; i < 20; i++) {
    send(main, 'Browser.setWindowBounds', {
      windowId: winId.windowId,
      bounds: { width: w0 + (i % 2 ? 9 : -9), height: h0 }
    }).catch(() => {})
  }
  await sleep(2500)
  const d = readData()
  check('S8d 缩放窗口没有把刚改的主题冲掉',
    d.settings?.uiTheme === th,
    `期望=${th} 磁盘=${d.settings?.uiTheme}`)
  await send(main, 'Browser.setWindowBounds', {
    windowId: winId.windowId,
    bounds: { width: w0, height: h0 }
  }).catch(() => {})
} catch (err) {
  check('S8d 缩放窗口没有把刚改的主题冲掉', false, `测不了：${err.message}`)
}

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

// ---- S10 跨零点口径 ----
// 造一条"今天 23:50 开始、明天 00:10 结束"的番茄：
// 主界面的汇总按结束时间算今天，统计页按开始时间算今天 —— 两边必须一致。
const now = new Date()
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 50, 0)
const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 10, 0)
const d10 = readData()
d10.sessions.push({
  id: 'e2e-cross-midnight',
  kind: 'focus',
  startedAt: start.toISOString(),
  endedAt: end.toISOString(),
  plannedSec: 1200,
  actualSec: 1200,
  completed: true,
  task: 'E2E跨零点',
  interrupt: 'none'
})
writeData(d10)
await sleep(400)
const sum10 = await evaluate(main, 'window.pomodoro.records.summary()')
const stat10 = await evaluate(main, 'window.pomodoro.stats.get()')
check('S10 跨零点的番茄：主界面与统计页口径一致',
  sum10?.todayCount === stat10?.todayCount,
  `主界面(按结束时间)=${sum10?.todayCount} 统计页(按开始时间)=${stat10?.todayCount}`)
const st10 = parseStatus(await statusText(main))
check('S10 界面状态行与统计页今日数一致',
  st10 !== null && st10.count === stat10?.todayCount,
  `状态行=${st10?.count} 统计页=${stat10?.todayCount}`)

console.log('\n===== 汇总 =====')
const failed = results.filter((r) => !r.ok)
console.log(`共 ${results.length} 项，失败 ${failed.length} 项`)
for (const f of failed) console.log(`  FAIL ${f.name} :: ${f.detail}`)
process.exit(failed.length ? 1 : 0)
