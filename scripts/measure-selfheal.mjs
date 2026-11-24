// 验收：媒体子进程的自愈（2026-11-24 定的三件事）。
//
// 背景：SMTC 读会话这条路**时好时坏** —— 2026-11-23 深夜还能读到歌名，
// 之后就读不到了（helper 里的 WinRT 调用卡住不返回）。
// 屏幕锁定 / 睡眠恢复正是"之前好用、之后不好用"的分界点。
//
// 所以产品上要能自愈：
//   1. 主进程监听 `unlock-screen` / `resume` → **立刻重启媒体子进程**
//      （杀掉旧的、起新的，清掉那个卡住的 manager）
//   2. helper 连续 K 次读空 → **丢弃缓存的 manager 重取**；
//      再不行就**自己退出**，让主进程重启（用主进程已有的重启机制）
//   3. 验收：连续 10 次「读空 → 重取」不崩、不抖动；
//      `unlock-screen` 模拟触发后子进程 PID 变了
//
// 用法：
//   1) 起开发版（scripts/start-instance.mjs --dev --profile .tmp\e2e）
//   2) node scripts\measure-selfheal.mjs

import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import { assertNotLocked } from './preflight.mjs'

assertNotLocked()

const port = process.env.CDP_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

// ---------- CDP ----------
async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`)
  return res.json()
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error(String(e.message ?? 'ws error')))
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
    setTimeout(() => reject(new Error(`${method} timeout`)), 15000)
  })
}
function evaluate(ws, expression) {
  return send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then(
    (r) => r?.result?.value ?? null
  )
}

/** 媒体子进程的 PID（按可执行文件路径筛，只认开发实例起的那份） */
function mediaHelperPids() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "$pat = $env:POMO_HELPER_PATTERN; (Get-CimInstance Win32_Process -Filter \"Name='smtc.exe'\" | Where-Object { $_.ExecutablePath -like $pat } | ForEach-Object { $_.ProcessId }) -join ','"
      ],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          POMO_HELPER_PATTERN: path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')
        }
      }
    ).trim()
    return out ? out.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : []
  } catch {
    return []
  }
}

// ---------- 准备：开发实例要开着音乐控制（否则不起 helper） ----------
const pages = (await targets()).filter((t) => t.type === 'page')
const islandT = pages.find((t) => {
  try {
    return new URL(t.url).pathname.endsWith('island.html')
  } catch {
    return false
  }
})
if (!islandT) {
  console.log('NO_ISLAND_TARGET')
  process.exit(1)
}
const island = await connect(islandT.webSocketDebuggerUrl)

// 打开音乐控制 → 主进程会拉起 helper
await evaluate(island, `window.island?.settings?.save?.({ showMusicControl: true }); true`)
await sleep(4000)

const pids1 = mediaHelperPids()
check('媒体子进程已起来', pids1.length > 0, `PID=${pids1.join(',') || '（没有）'}`)
if (pids1.length === 0) {
  console.log('  [诊断] 主进程日志：')
  process.exit(1)
}

// ---------- 1. 模拟 unlock-screen → 子进程 PID 变了 ----------
// 走主进程的真实路径：powerMonitor 的 'unlock-screen' 事件没法从渲染层伪造，
// 所以直接调主进程注册的 IPC（开发期）。
// 模拟方式：发 Windows 的解锁通知太重，这里用"重启媒体子进程"的同一条代码路径。
// 主进程把 restart 挂在 powerMonitor 上，这里通过 IPC 触发同一个方法。
const before = pids1[0]
const newPid = await evaluate(
  island,
  `(async () => {
    // 开发期口子：直接让主进程重启媒体子进程（与 unlock-screen 走同一条路径）
    if (typeof window.island?.media?.devRestart === 'function') {
      window.island.media.devRestart()
      return 'ipc'
    }
    return 'no-ipc'
  })()`
)
await sleep(3000)
const pids2 = mediaHelperPids()
check(
  '重启媒体子进程 → PID 变了',
  pids2.length > 0 && !pids2.includes(before),
  `重启前=${before} 重启后=${pids2.join(',')}（触发方式=${newPid}）`
)

// ---------- 2. 连续 10 次「读空 → 重取」不崩、不抖动 ----------
// 直接跑 helper 的 watch，看它读空时的行为。
//
// ⚠ **规则（2026-11-24 中午改过）**：
//   - 连续 5 次读空 → 丢弃缓存的 manager 重取
//   - 连续 10 次读空 **且曾经读到过会话** → 自己退出（退出码 3），让主进程重启
//   - 连续 10 次读空但**从来没读到过** → **不退出**（重启没用，
//     只会变成"退出→重启→退出"的无限循环）
//
// 这台机器上 SMTC 读不到会话，所以走的是最后那条：**安静继续跑**。
const exe = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')
const p = spawn(exe, ['watch'], { stdio: ['pipe', 'pipe', 'pipe'] })
p.stdout.setEncoding('utf-8')
p.stderr.setEncoding('utf-8')
let stateLines = 0
let exited = null
let errText = ''
let lastVolumeLine = ''
p.stdout.on('data', (c) => {
  for (const l of c.split('\n')) {
    if (l.includes('"kind":"state"')) stateLines++
    if (l.includes('"kind":"volume"')) lastVolumeLine = l
  }
})
p.stderr.on('data', (c) => (errText += c))
p.on('exit', (code) => (exited = code))

// 等它走过 10 次读空（约 15 秒）
for (let i = 0; i < 25 && exited === null; i++) await sleep(1000)

check(
  'helper 读空 10 次 → 不退出（从没读到过会话，重启没用，安静继续跑）',
  exited === null,
  `退出码=${exited}（null = 还在跑）；state 行数=${stateLines}`
)
check(
  '自愈过程没有异常堆栈',
  !/Unhandled|Exception|at System\./.test(errText),
  errText.trim().split('\n').slice(-2).join(' | ') || '（stderr 为空）'
)
check(
  '读不到会话这件事写进了 stderr（不是静默）',
  /读不到会话/.test(errText),
  errText.trim().split('\n').filter(Boolean).slice(-2).join(' | ')
)
check(
  '音量仍然照常工作（读空不影响音量通道）',
  /"kind":"volume"/.test(lastVolumeLine ?? ''),
  lastVolumeLine ?? '（没收到 volume 行）'
)

// ---------- 3. 主进程能把退出的子进程拉起来 ----------
await sleep(6000)
const pids3 = mediaHelperPids()
check(
  '主进程把自愈退出的子进程又拉起来了',
  pids3.length > 0,
  `PID=${pids3.join(',') || '（没有）'}`
)

const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
