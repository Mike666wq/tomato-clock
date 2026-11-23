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

// 按**可执行文件路径通配**筛：本项目的 electron.exe / win-unpacked 里的 exe，
// 都不会匹配到用户自己装的那份（它在 E:\ 或 %LOCALAPPDATA%\Programs 下）。
// 注意 pnpm 的 electron 真实路径在 node_modules\.pnpm\... 里，
// 所以清单里存的是通配（exePattern），不是 symlink 路径。
const pattern = inst.exePattern ?? path.join(path.dirname(inst.exePath), '*')

// pattern 走环境变量传进 PowerShell，避免中文路径在命令行里被编码搞坏
const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$pat = $env:POMO_EXE_PATTERN
$all = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like $pat }
Write-Output '--- 匹配到的进程（先列后杀）---'
$all | ForEach-Object { Write-Output ("  PID=" + $_.ProcessId + "  " + $_.ExecutablePath) }
if ($all.Count -eq 0) { Write-Output '  （一个都没有）' }
`

function runPowerShell(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf-8',
    env: { ...process.env, POMO_EXE_PATTERN: pattern }
  })
}

console.log(`[收尾] 按可执行文件路径筛：${pattern}`)
const listing = runPowerShell(ps)
console.log(listing.trim())

if (dry) {
  console.log('[收尾] --dry：只列不杀')
  process.exit(0)
}

const kill = `
$pat = $env:POMO_EXE_PATTERN
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like $pat } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`
try {
  runPowerShell(kill)
  console.log('[收尾] 已关掉')
} catch (e) {
  console.log(`[收尾] 关的时候出了点问题（不影响）：${e.message}`)
}

rmSync(instanceFile, { force: true })
console.log('[收尾] 清单已清')
