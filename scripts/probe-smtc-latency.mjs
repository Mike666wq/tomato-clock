// 探针：RequestAsync 到底要多久才返回？第一次慢、之后快？
//
// 假设：OS 侧的会话管理器第一次要很久（甚至超时），但**一旦拿到就缓住了**，
//       后续调用很快。watch 模式因此看起来"正常"（第一行慢，后面快）。
// 办法：一直调 RequestAsync，每次记耗时，看是不是"第一次长、后面短"。
//
// 用法：node scripts/probe-smtc-latency.mjs

import { spawn } from 'node:child_process'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 直接用 helper 的 watch 模式：它每秒推一行 state。
// 量的是「两行 state 之间的间隔」和「第一行到第二行的间隔」。
const ps = spawn(
  path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe'),
  ['watch'],
  { stdio: ['pipe', 'pipe', 'pipe'] }
)
ps.stdout.setEncoding('utf-8')
let buf = ''
const t0 = Date.now()
const lines = []
ps.stdout.on('data', (chunk) => {
  buf += chunk
  let i = buf.indexOf('\n')
  while (i >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    i = buf.indexOf('\n')
    if (line) {
      lines.push({ at: Date.now() - t0, line })
      console.log(`  [${String(Date.now() - t0).padStart(6)}ms] ${line.slice(0, 120)}`)
    }
  }
})

await sleep(40000)
ps.kill()

console.log('\n=== 间隔分析 ===')
for (let i = 1; i < lines.length; i++) {
  const gap = lines[i].at - lines[i - 1].at
  const kind = lines[i].line.includes('"kind":"state"') ? 'state' : '其它'
  console.log(`  第${i + 1}行 ${kind}：距上一行 ${gap}ms`)
}
const states = lines.filter((l) => l.line.includes('"kind":"state"'))
if (states.length) {
  console.log(`\n共 ${states.length} 条 state；最后一条 = ${states[states.length - 1].line.slice(0, 200)}`)
  const withTitle = states.filter((l) => l.line.includes('"title":"') && !l.line.includes('"title":""'))
  console.log(`带歌名的 state：${withTitle.length} 条`)
}
process.exit(0)
