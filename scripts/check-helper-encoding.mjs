// 验证 helper 的 stderr 中文是不是真的按 UTF-8 输出。
//
// 刚才用 PowerShell 的 Start-Job 看到中文乱码 —— 但那是 PowerShell 用
// 控制台默认编码（中文系统上是 GBK）解码的结果，不代表 helper 写错了。
// 产品那边主进程是用 setEncoding('utf-8') 读的，所以要按产品的方式验。
//
// 用法：node scripts/check-helper-encoding.mjs

import { spawn } from 'node:child_process'
import path from 'node:path'

const exe = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')

const p = spawn(exe, ['watch'], { stdio: ['pipe', 'pipe', 'pipe'] })
p.stdout.setEncoding('utf-8')
p.stderr.setEncoding('utf-8')

const errLines = []
p.stderr.on('data', (c) => {
  for (const line of c.split('\n')) {
    if (line.trim()) errLines.push(line.trim())
  }
})

await new Promise((r) => setTimeout(r, 30000))
p.kill()

console.log(`stderr 收到 ${errLines.length} 行：`)
for (const l of errLines) console.log(`  ${l}`)

// 判据：中文要能正常显示，不能是 "杩炵画" 这种（UTF-8 被当 GBK 读）
const garbled = errLines.filter((l) => /[�]/.test(l) || /杩|娆|璇|浼/.test(l))
console.log(`\n乱码行数 = ${garbled.length}`)
console.log(garbled.length === 0 ? 'PASS  stderr 是 UTF-8，中文正常' : 'FAIL  stderr 乱码')
process.exit(garbled.length === 0 ? 0 : 1)
