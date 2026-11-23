// 统一起一个「被测实例」，并写下清单供 preflight 校验。
//
// 肥鱼立的规矩：验证脚本要有前置自检，而自检要能说清
// 「被测实例的 userData 到底在哪」—— 靠人记文档不行，靠脚本记才行。
//
// 用法：
//   开发版：
//     node scripts\start-instance.mjs --dev --profile .tmp\e2e
//     （开发版的 CDP 端口在 src/main/index.ts:432 写死 9222，不能改）
//   打包版：
//     node scripts\start-instance.mjs --exe "release\win-unpacked\番茄钟.exe" --profile .tmp\pkg-035 --port 9224
//
// 干的事：
//   1. 清掉 ELECTRON_RUN_AS_NODE（残留会把 exe 当 node 跑，退出码 9）
//   2. 用独立的 userData 起，绝不碰用户自己的 %APPDATA%\pomodoro
//   3. 等 CDP 端口起来
//   4. 写 .tmp/instance.json：{ mode, port, userData, dataFile, exePath, pid, startedAt }

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const root = process.cwd()
const mode = arg('dev') ? 'dev' : 'packaged'
const exeArg = arg('exe')
const profileArg = arg('profile')
const port = Number(arg('port', mode === 'dev' ? 9222 : 9224))
const tag = String(arg('tag', `inst-${Date.now()}`))

if (mode === 'dev' && port !== 9222) {
  console.error(`[启动] 开发版的 CDP 端口写死在 src/main/index.ts:432（9222），不能改。`)
  process.exit(1)
}
if (mode === 'packaged' && !exeArg) {
  console.error('[启动] 打包版要指 --exe <打包产物路径>')
  process.exit(1)
}
if (!profileArg) {
  console.error('[启动] 要指 --profile <独立的 userData 目录>（不许用用户自己的 %APPDATA%\\pomodoro）')
  process.exit(1)
}

const profile = path.resolve(root, String(profileArg))
mkdirSync(profile, { recursive: true })

// ---- 1. 清 ELECTRON_RUN_AS_NODE ----
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE
  console.log('[启动] 已清掉 ELECTRON_RUN_AS_NODE')
}

// 旧的清单先作废：起新实例之前，不能让旧清单骗过自检
const instanceFile = path.join(root, '.tmp', 'instance.json')
rmSync(instanceFile, { force: true })

// ---- 2. 起实例 ----
// 注意：ELECTRON_RUN_AS_NODE 要**从 env 里删掉**，不能设成空字符串 ——
// Chromium 认的是「这个变量存不存在」，空字符串照样算数（实测 dev 版起不来）。
const childEnv = { ...process.env, POMODORO_USER_DATA: profile }
delete childEnv.ELECTRON_RUN_AS_NODE

let child
let exePath = ''
// 收尾时按**可执行文件路径通配**筛进程。注意 pnpm 的 electron 真实路径在
// node_modules\.pnpm\... 里（不是 node_modules\electron\dist），
// 所以 dev 模式用通配，打包版用 win-unpacked 目录通配。
let exePattern = ''
if (mode === 'dev') {
  // 走 pnpm dev：dev.mjs 里的 electron-vite 依赖 node_modules/.bin 在 PATH 上，
  // 直接 spawn node scripts/dev.mjs 会找不到 electron-vite。
  child = spawn('pnpm', ['dev'], {
    cwd: root,
    env: childEnv,
    detached: true,
    stdio: 'ignore',
    shell: true
  })
  exePath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  exePattern = path.join(root, 'node_modules', '.pnpm', '*electron*', 'node_modules', 'electron', 'dist', 'electron.exe')
} else {
  exePath = path.resolve(root, String(exeArg))
  exePattern = path.join(path.dirname(exePath), '*')
  child = spawn(
    exePath,
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, tag],
    { cwd: root, env: childEnv, detached: true, stdio: 'ignore' }
  )
}
child.unref()

// ---- 3. 等 CDP ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ready = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`)
    const list = await res.json()
    if (Array.isArray(list) && list.some((t) => t.type === 'page')) {
      ready = true
      break
    }
  } catch {
    /* 还没起来 */
  }
}
if (!ready) {
  console.error(`[启动] CDP ${port} 没起来 —— 启动失败`)
  console.error('  常见原因：ELECTRON_RUN_AS_NODE 残留（退出码 9）、或端口被占')
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*win-unpacked*' } | Select-Object ProcessId,ExecutablePath | Format-Table -AutoSize | Out-String"
    ], { encoding: 'utf-8' })
  } catch {
    /* 查不到就算了 */
  }
  process.exit(1)
}

// ---- 4. 写清单 ----
// 记下**这次启动的进程 PID**：收尾时只杀这几个，
// 不许按名字/路径批量停（那会误伤用户自己装的那份）。
function listPids(pattern) {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$pat = $env:POMO_EXE_PATTERN
         (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
           Where-Object { $_.ExecutablePath -like $pat } |
           ForEach-Object { $_.ProcessId }) -join ','`
      ],
      { encoding: 'utf-8', env: { ...process.env, POMO_EXE_PATTERN: pattern } }
    ).trim()
    return out ? out.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : []
  } catch {
    return []
  }
}

const startedPids = listPids(exePattern)

const manifest = {
  mode,
  port,
  tag,
  userData: profile,
  dataFile: path.join(profile, 'data.json'),
  snapshotFile: path.join(profile, 'running.json'),
  exePath,
  exePattern,
  pids: startedPids,
  pid: child.pid,
  startedAt: new Date().toISOString()
}
mkdirSync(path.join(root, '.tmp'), { recursive: true })
writeFileSync(instanceFile, JSON.stringify(manifest, null, 2), 'utf-8')

console.log(`[启动] ${mode} 实例起来了`)
console.log(`  CDP      http://127.0.0.1:${port}`)
console.log(`  userData ${profile}`)
console.log(`  data.json ${manifest.dataFile}`)
console.log(`  清单      ${instanceFile}`)
console.log(`  跑测试：E2E_DATA="${manifest.dataFile}" E2E_SNAPSHOT="${manifest.snapshotFile}" ` +
  `E2E_RESIZE_EXE="${mode === 'dev' ? '*node_modules*electron*dist*electron.exe' : `*${path.basename(exePath)}`}" ` +
  `CDP_PORT=${port} node scripts\\e2e-journey.mjs`)
