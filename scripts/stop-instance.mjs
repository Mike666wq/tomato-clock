// 收尾：关掉自己起的被测实例。
//
// 肥鱼立的规矩：进程筛选一律按**可执行文件路径**，先列后杀；
// 禁止按命令行片段筛（片段会出现在「自己这条命令」里 → 自杀过）。
//
// 用法：
//   node scripts\stop-instance.mjs            （用 .tmp/instance.json 里的清单）
//   node scripts\stop-instance.mjs --dry      （只列不杀）

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const instanceFile = path.join(root, '.tmp', 'instance.json')
const dry = process.argv.includes('--dry')

if (!existsSync(instanceFile)) {
  console.log('[收尾] 没有 .tmp/instance.json —— 没有自己起的实例要关')
  process.exit(0)
}
const inst = JSON.parse((await import('node:fs')).readFileSync(instanceFile, 'utf-8'))

if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE
}

// 只杀**清单里记下的那批 PID**（就是这次启动的）。
// 不按名字/路径批量停 —— 那样会误伤用户自己装的那份（肥鱼立的规矩）。
const pids = Array.isArray(inst.pids) ? inst.pids.filter((n) => Number.isFinite(n)) : []

// 路径通配只用来**列**（给人核对），不作为杀的依据
const pattern = inst.exePattern ?? path.join(path.dirname(inst.exePath), '*')

// pattern 走环境变量传进 PowerShell，避免中文路径在命令行里被编码搞坏
const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$pat = $env:POMO_EXE_PATTERN
$all = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like $pat }
Write-Output '--- 路径匹配的进程（只作展示，不作为杀的依据）---'
$all | ForEach-Object { Write-Output ("  PID=" + $_.ProcessId + "  " + $_.ExecutablePath) }
if ($all.Count -eq 0) { Write-Output '  （一个都没有）' }
`

function runPowerShell(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf-8',
    env: { ...process.env, POMO_EXE_PATTERN: pattern }
  })
}

console.log(`[收尾] 路径通配：${pattern}`)
console.log(`[收尾] 只杀本次启动的 PID：${pids.join(',') || '（清单里没有 PID）'}`)
const listing = runPowerShell(ps)
console.log(listing.trim())

if (dry) {
  console.log('[收尾] --dry：只列不杀')
  process.exit(0)
}

if (pids.length === 0) {
  console.log('[收尾] 清单里没有 PID —— 不按名字批量杀，请自己核对上面那批')
  process.exit(0)
}

for (const pid of pids) {
  try {
    process.kill(pid)
  } catch {
    /* 已经退了 */
  }
}
console.log(`[收尾] 已关掉 ${pids.length} 个（都是这次启动的）`)

rmSync(instanceFile, { force: true })
console.log('[收尾] 清单已清')
