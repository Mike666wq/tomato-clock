// 打包版验包：查音乐行 + 音量滑条 + 开发期口子是否已被剔除。
//
// 用法：CDP_PORT=9224 node scripts\verify-packaged-media.mjs

const port = process.env.CDP_PORT ?? '9224'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('island.html'))
if (!t) {
  console.log('NO_ISLAND_TARGET')
  process.exit(1)
}
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id
    const h = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id === mid) {
        ws.removeEventListener('message', h)
        resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
const evaluate = (expr) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

// 打开音乐控制
await evaluate(`window.island.settings.save({ showMusicControl: true }); true`)
await new Promise((r) => setTimeout(r, 2000))

// ⚠ **展开要靠真机鼠标悬停**：`window.island.island.setMode` 只改主进程那边的
//   窗口大小，渲染层的 expanded 状态是 hover 驱动的。
//   还要"先离开再回来"：鼠标已经在岛上时浏览器不会再发 mouseenter。
const { spawn } = await import('node:child_process')
const path = await import('node:path')
const ps = spawn(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'scripts', 'real-mouse.ps1')],
  { stdio: ['pipe', 'pipe', 'pipe'] }
)
ps.stdout.setEncoding('utf-8')
let mbuf = ''
const mwaiters = []
ps.stdout.on('data', (chunk) => {
  mbuf += chunk
  let i = mbuf.indexOf('\n')
  while (i >= 0) {
    const line = mbuf.slice(0, i).trim()
    mbuf = mbuf.slice(i + 1)
    i = mbuf.indexOf('\n')
    if (!line) continue
    const w = mwaiters.shift()
    if (w) w(line)
  }
})
const mouse = (cmd) =>
  new Promise((resolve) => {
    mwaiters.push(resolve)
    ps.stdin.write(`${cmd}\n`)
  })

// 打包版的岛**没有 devBounds**（开发期口子已剔除）→ 从窗口列表里取它的位置
const islandRect = await evaluate(`(async () => {
  const el = document.querySelector('.island')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})()`)
console.log(`  [诊断] 岛元素 rect（视口坐标）=${JSON.stringify(islandRect)}`)

// 岛是独立窗口，屏幕位置要靠外部查。用 PowerShell 查「灵动岛」窗口的 rect
const { execFileSync } = await import('node:child_process')
const raw = execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class WQ{ [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr l); public delegate bool EnumProc(IntPtr h,IntPtr l); [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;} }' -ErrorAction SilentlyContinue;
     $found = $null;
     $cb = [WQ+EnumProc]{ param($hw,$l) $sb2 = New-Object System.Text.StringBuilder 256; [void][WQ]::GetWindowText($hw,$sb2,256); if ($sb2.ToString() -eq '灵动岛') { $script:found = $hw; return $false }; return $true };
     [void][WQ]::EnumWindows($cb,[IntPtr]::Zero);
     if ($found) { $r = New-Object WQ+RECT; [void][WQ]::GetWindowRect($found,[ref]$r); Write-Output ($r.L.ToString()+','+$r.T.ToString()+','+$r.R.ToString()+','+$r.B.ToString()) } else { Write-Output 'NOT_FOUND' }`
  ],
  { encoding: 'utf-8' }
).trim()
// 输出里可能夹带 PowerShell 的杂音 → 用正则抓 "左,上,右,下"
const rectMatch = /(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(raw)
const islandWin = rectMatch
  ? rectMatch.slice(1, 5).map((n) => Number(n))
  : null
console.log(`  [诊断] 打包版岛的屏幕 rect（DIP）= ${JSON.stringify(islandWin)}（原始输出：${raw.slice(0, 80)}）`)

let expanded = false
if (islandWin) {
  const cx = Math.round((islandWin[0] + islandWin[2]) / 2)
  const cy = Math.round((islandWin[1] + islandWin[3]) / 2)
  for (let i = 0; i < 6; i++) {
    await mouse('move 5 5')
    await sleep(400)
    await mouse('move 5 5')
    await sleep(200)
    await mouse(`move ${cx} ${cy}`)
    await sleep(800)
    expanded = await evaluate(`!!document.querySelector('.island--expanded')`)
    if (expanded) break
  }
}
check('打包版：岛已悬停展开', expanded === true, `expanded=${expanded}`)
if (!expanded) {
  ps.kill()
  process.exit(1)
}

const v = await evaluate(`(async () => {
  const media = await window.island.media.getState();
  const vol = await window.island.media.getVolume();
  return {
    media: media,
    volume: vol,
    devFns: {
      devFake: typeof window.island?.media?.devFake,
      devBounds: typeof window.island?.island?.devBounds,
      devOffset: typeof window.island?.island?.devOffset,
      devRestart: typeof window.island?.media?.devRestart
    },
    musicRow: !!document.querySelector('.island__music'),
    btnLabels: [...document.querySelectorAll('.island__music-btn')].map((b) => b.getAttribute('aria-label'))
  };
})()`)
console.log(`  [诊断] ${JSON.stringify(v, null, 2)}`)

check(
  '打包版：开发期口子全部不存在',
  Object.values(v.devFns).every((t) => t === 'undefined'),
  JSON.stringify(v.devFns)
)
check('打包版：音乐行存在（按钮永远在）', v.musicRow === true, `.island__music=${v.musicRow}`)
check(
  '打包版：播放/暂停/上一首/下一首按钮都在',
  ['上一首', '下一首'].every((l) => v.btnLabels.includes(l)) &&
    v.btnLabels.some((l) => l && l.includes('播放')),
  `按钮=${JSON.stringify(v.btnLabels)}`
)
check(
  '打包版：音量读得到（系统级，与会话无关）',
  typeof v.volume === 'number',
  `volume=${v.volume}`
)
check(
  '打包版：没有会话时歌名区是空的（不显示假的）',
  v.media === null || v.media.title === '' || v.media.hasSession === false,
  `media=${JSON.stringify(v.media)}`
)

// ---------- 0.3.7 新增：图标形状 + 方向 ----------
//
// 这两条是这版的核心，**打包版也要验**（构建过程可能改坏东西）。
const iconShapes = await evaluate(`(() => {
  const svgOf = (label) => {
    const el = [...document.querySelectorAll('.island__music-btn')].find((x) => x.getAttribute('aria-label') === label)
    if (!el) return null
    const svg = el.querySelector('svg')
    if (!svg) return null
    return {
      paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')),
      rects: [...svg.querySelectorAll('rect')].map((r) => ({
        x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')),
        w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height'))
      }))
    }
  }
  const pp = [...document.querySelectorAll('.island__music-btn')].find((x) => {
    const l = x.getAttribute('aria-label') || ''
    return l === '播放' || l === '暂停' || l === '播放/暂停'
  })
  const ppSvg = pp ? pp.querySelector('svg') : null
  return {
    prev: svgOf('上一首'),
    next: svgOf('下一首'),
    playPause: pp ? {
      label: pp.getAttribute('aria-label'),
      paths: [...ppSvg.querySelectorAll('path')].map((p) => p.getAttribute('d')),
      rects: [...ppSvg.querySelectorAll('rect')].map((r) => ({
        x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')),
        w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height'))
      }))
    } : null
  }
})()`)
console.log(`  [诊断] 图标几何：${JSON.stringify(iconShapes)}`)

check(
  '打包版：「上一首」竖条在左 + 两个朝左的三角（|◀◀）',
  iconShapes.prev !== null &&
    iconShapes.prev.rects.length === 1 &&
    iconShapes.prev.rects[0].x === Math.min(...iconShapes.prev.rects.map((r) => r.x)) &&
    iconShapes.prev.paths.length === 2 &&
    iconShapes.prev.paths.every((d) => {
      const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number)
      return nums[0] > nums[2]
    }),
  `rects=${JSON.stringify(iconShapes.prev?.rects)} paths=${JSON.stringify(iconShapes.prev?.paths)}`
)
check(
  '打包版：「下一首」两个朝右的三角 + 竖条在右（▶▶|）',
  iconShapes.next !== null &&
    iconShapes.next.rects.length === 1 &&
    iconShapes.next.rects[0].x === Math.max(...iconShapes.next.rects.map((r) => r.x)) &&
    iconShapes.next.paths.length === 2 &&
    iconShapes.next.paths.every((d) => {
      const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number)
      return nums[0] < nums[2]
    }),
  `rects=${JSON.stringify(iconShapes.next?.rects)} paths=${JSON.stringify(iconShapes.next?.paths)}`
)
check(
  '打包版：播放/暂停图标是**合并的一个 svg**（状态一变不会塌岛）',
  iconShapes.playPause !== null,
  `label=${iconShapes.playPause?.label}`
)

// 方向：独立进程读音频会话的峰值当真相源
const { execFileSync } = await import('node:child_process')
const path = await import('node:path')
let realPlaying = null
let realPeak = null
try {
  const out = execFileSync(
    path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe'),
    ['audio'],
    { encoding: 'utf-8', timeout: 15000 }
  )
  for (const line of out.trim().split('\n').filter(Boolean).reverse()) {
    const parsed = JSON.parse(line)
    if (parsed.kind === 'audioSession' && parsed.peak !== null && parsed.peak !== undefined) {
      realPeak = Number(parsed.peak)
    }
    if (parsed.kind === 'audioPlayer') realPlaying = parsed.playing === null ? null : Boolean(parsed.playing)
  }
} catch {
  /* 读不到就跳过方向断言 */
}
console.log(`  [诊断] 独立进程读到的真实方向：playing=${realPlaying} peak=${realPeak}`)
if (realPlaying !== null) {
  const expectLabel = realPlaying ? '暂停' : '播放'
  check(
    `打包版：方向跟真实声音一致（真实在放=${realPlaying} → 显示「${expectLabel}」）`,
    iconShapes.playPause?.label === expectLabel,
    `label=${iconShapes.playPause?.label} 期望=${expectLabel} peak=${realPeak}`
  )
} else {
  check('打包版：读不到真实方向 → 显示两态图标（不猜）', iconShapes.playPause?.label === '播放/暂停',
    `label=${iconShapes.playPause?.label}`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n# 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
ps.kill()
process.exit(failed.length ? 1 : 0)
