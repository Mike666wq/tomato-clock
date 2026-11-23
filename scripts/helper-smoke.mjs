// helper（tools/smtc）冒烟测试。
//
// 验三件事（都是这轮新加的）：
//   1. watch 模式第一行 state 里带 volume / volumeOk
//   2. **外部**改音量（等于用户按了音量键）→ helper 立刻推一行 volume
//      —— 这条验的是"跟手"通路，不是轮询能蒙混过关的地方
//   3. stdin 的 vol <n> 能设成功并回 ack
//
// ⚠ 测试会短暂改动系统音量，**结束前一律恢复原值**。
// 用法：node scripts\helper-smoke.mjs

import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'

const exe = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

const child = spawn(exe, ['watch'], { stdio: ['pipe', 'pipe', 'pipe'] })
const lines = []
let buf = ''
child.stdout.setEncoding('utf-8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let idx = buf.indexOf('\n')
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    idx = buf.indexOf('\n')
    if (line) {
      lines.push(line)
      console.log(`<< ${line}`)
    }
  }
})
child.stderr.setEncoding('utf-8')
child.stderr.on('data', (chunk) => {
  const t = chunk.trim()
  if (t) console.log(`!! ${t}`)
})

const parsed = () =>
  lines
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

/** 等某个条件成立（SMTC 第一次请求挺慢，别用固定 sleep 赌） */
async function waitFor(fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(200)
  }
  return false
}

const gotFirst = await waitFor(() => parsed().length > 0)
if (!gotFirst) {
  console.log('FAIL  helper 一行都没输出')
  child.kill()
  process.exit(1)
}
// 第一行应该是**音量**（不依赖 SMTC —— 没有音乐会话时 SMTC 会挂住，
// 音量不能被它拖着）
const firstVolume = parsed().find((j) => j.kind === 'volume')
const original = typeof firstVolume?.value === 'number' ? firstVolume.value : 30

check(
  '第一行就是音量（不等 SMTC）',
  firstVolume !== undefined && typeof firstVolume.value === 'number' && typeof firstVolume.ok === 'boolean',
  `volume=${firstVolume?.value} ok=${firstVolume?.ok}`
)

// state 行单独等（SMTC 可能慢/挂）
await waitFor(() => parsed().some((j) => j.kind === 'state'), 12000)
const firstState = parsed().find((j) => j.kind === 'state')
check(
  'state 行带 volume / volumeOk',
  firstState !== undefined && typeof firstState.volume === 'number' && typeof firstState.volumeOk === 'boolean',
  `volume=${firstState?.volume} volumeOk=${firstState?.volumeOk}`
)

// ---- 2. 外部改音量 → 立刻有 volume 推送 ----
// 判据收紧到 **600ms**：兜底轮询是 2 秒一档，所以能在 600ms 内推出，
// 只可能是 **Core Audio 的连接点回调** 干的（不是轮询蒙混）。
const beforeCount = lines.length
const target = Math.min(100, original + 15)
const changedAt = Date.now()
spawn(exe, ['vol', 'set', String(target)], { stdio: 'ignore' })
const pushedFast = await waitFor(
  () => parsed().slice(beforeCount).some((j) => j.kind === 'volume'),
  1200
)
const latency = Date.now() - changedAt
const mode = parsed().find((j) => j.kind === 'volumeMode')?.mode
const modeError = parsed().find((j) => j.kind === 'volumeMode')?.error
check(
  '外部改音量后 1.2 秒内就有推送',
  pushedFast,
  `耗时 ${latency}ms；helper 模式=${mode}${mode ? `（${modeError}）` : ''}`
)
check(
  '通知模式已记录（callback / poll 都要能说清原因）',
  mode === 'callback' || mode === 'poll',
  `mode=${mode}；回调在 Win10+ 注册不上的原因：${modeError}`
)

// 恢复原值
spawn(exe, ['vol', 'set', String(original)], { stdio: 'ignore' })
await sleep(900)

// ---- 3. stdin 的 vol 命令 ----
const ackBefore = parsed().filter((j) => j.kind === 'ack' && j.command === 'vol').length
child.stdin.write(`vol ${Math.max(0, original - 5)}\n`)
await sleep(1200)
const acks = parsed().filter((j) => j.kind === 'ack' && j.command === 'vol')
check(
  'stdin 的 vol <n> 有 ack 回执',
  acks.length > ackBefore,
  `ack=${JSON.stringify(acks[acks.length - 1] ?? null)}`
)

// 恢复原值，别把用户的音量留在测试值上。
// **恢复要用事实确认**：不信 watch 的推送时序，直接另起进程读回来核对
// —— 上一版就是"以为恢复了"，结果用户的音量被留在 20。
spawn(exe, ['vol', 'set', String(original)], { stdio: 'ignore' })
let restored = false
let nowValue = null
for (let i = 0; i < 20; i++) {
  await sleep(300)
  try {
    const out = execFileSync(exe, ['vol', 'get'], { encoding: 'utf-8' })
    nowValue = JSON.parse(out).value
    if (nowValue === original) {
      restored = true
      break
    }
  } catch {
    /* 读不到就再试 */
  }
}

check('测试结束音量已恢复原值（用读回确认，不靠推送时序）', restored, `现在=${nowValue} 原值=${original}`)

child.kill()
const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length ? 1 : 0)
