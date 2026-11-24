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

function runPowerShell(script, extraEnv = {}) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf-8',
    env: { ...process.env, POMO_EXE_PATTERN: pattern, ...extraEnv }
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

// ---- 收集**进程树**（不只清单里那几个 PID） ----
//
// ⚠ **为什么还要按进程树收**：免安装单文件版（portable-single）运行时
//   会把自己解包到临时目录再跑真正的 exe ——
//   **真正的窗口/子进程是解包后的那些，它们的 PID 不在清单里**
//   （清单只记了 launcher 一个）。
//   结果：收尾只关掉 1 个，留下一堆孤儿进程（实测留了 11 个）。
//
//   按**父进程链**收是安全的：链上的每个进程都是我们启动的那个的后代，
//   不是"按名字猜"（用户自己装的那份不在链上，不会被误伤）。
const treePs = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @($env:POMO_ROOTS -split ',' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
$all = Get-CimInstance Win32_Process
$tree = New-Object System.Collections.ArrayList
$stack = New-Object System.Collections.ArrayList
foreach ($r in $roots) { [void]$stack.Add($r) }
while ($stack.Count -gt 0) {
  $cur = $stack[0]
  $stack.RemoveAt(0)
  if ($tree -contains $cur) { continue }
  [void]$tree.Add($cur)
  foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $cur })) { [void]$stack.Add([int]$c.ProcessId) }
}
foreach ($pid2 in $tree) {
  $p = $all | Where-Object { $_.ProcessId -eq $pid2 }
  if ($p) { Write-Output ("  PID=$pid2  " + $p.ExecutablePath) }
}
`

const treeOut = runPowerShell(treePs, { POMO_ROOTS: pids.join(',') })
const treePids = [...treeOut.matchAll(/PID=(\d+)/g)].map((m) => Number(m[1]))
console.log(`[收尾] 进程树（含解包出来的子进程）：${treePids.join(',')}`)

for (const pid of treePids) {
  try {
    process.kill(pid)
  } catch {
    /* 已经退了 */
  }
}
console.log(`[收尾] 已关掉 ${treePids.length} 个（都是这次启动的，含子进程）`)

// 等一下，确认真的退了（免安装版解包出来的进程有时要多等一拍）
await new Promise((r) => setTimeout(r, 1500))
const left = runPowerShell(treePs, { POMO_ROOTS: pids.join(',') })
const leftPids = [...left.matchAll(/PID=(\d+)/g)].map((m) => Number(m[1]))
if (leftPids.length > 0) {
  console.log(`[收尾] 还有 ${leftPids.length} 个没退，再强杀一次`)
  for (const pid of leftPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已经退了 */
    }
  }
} else {
  console.log('[收尾] 确认全退了')
}

rmSync(instanceFile, { force: true })
console.log('[收尾] 清单已清')
