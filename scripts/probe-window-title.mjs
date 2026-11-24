// 探针：**QQ 音乐的窗口标题能不能当歌名来源**（2026-11-24 下午）。
//
// 背景：
//   QQ 音乐新版内核（qmbrowser.exe）不再向 Windows 报告 SMTC 会话，
//   于是 `smtc current` 读不到歌名 —— 岛上那一块一直是空的。
//   肥鱼说"托盘里没窗口，读窗口那条路也不通"。
//
//   但实测：QQMusic.exe **有一个窗口，标题就是「歌名 - 歌手」**
//   （如 "下完这场雨 - 后弦"）。所以这条路**可能是通的**，要验。
//
// 验什么（**只读**为主，不动用户的音乐）：
//   1. 窗口标题能不能稳定读到
//   2. 标题的格式是不是「歌名 - 歌手」
//   3. 歌变了，标题跟着变吗（**需要按一次「下一首」** —— 用 --cut 开关显式开）
//
// 用法：
//   node scripts\probe-window-title.mjs          # 只读采样，不动音乐
//   node scripts\probe-window-title.mjs --cut    # 按一次下一首，验标题跟不跟
//
// ⚠ --cut 会切用户的歌（切完回不去原曲，只此一次影响）。

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CUT = process.argv.includes('--cut')

/** 读 QQ音乐 所有窗口的标题（只读，不改任何状态） */
function qqWindows() {
  const ps = `
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class WQ {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public delegate bool EnumProc(IntPtr h, IntPtr p);
}
"@
$out = New-Object System.Collections.ArrayList
$cb = [WQ+EnumProc]{ param($h,$p)
  $len = [WQ]::GetWindowTextLength($h)
  if ($len -gt 0) {
    $sb = New-Object System.Text.StringBuilder ($len+1)
    [void][WQ]::GetWindowText($h,$sb,$sb.Capacity)
    $pid2 = 0
    [void][WQ]::GetWindowThreadProcessId($h,[ref]$pid2)
    $pn = ''
    try { $pn = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch {}
    if ($pn -eq 'QQMusic') {
      [void]$out.Add(("{0}|{1}" -f [WQ]::IsWindowVisible($h), $sb.ToString().Trim()))
    }
  }
  return $true
}
[void][WQ]::EnumWindows($cb,[IntPtr]::Zero)
$out -join "\n"
`
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf-8',
      timeout: 15000
    })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [visible, ...rest] = l.split('|')
        return { visible: visible === 'True', title: rest.join('|') }
      })
  } catch {
    return []
  }
}

/** 从标题里拆出歌名和歌手（格式「歌名 - 歌手」） */
function parseTitle(title) {
  const i = title.lastIndexOf(' - ')
  if (i <= 0) return { title, artist: '' }
  return { title: title.slice(0, i).trim(), artist: title.slice(i + 3).trim() }
}

console.log('=== 只读采样（3 次，间隔 2 秒）===')
const samples = []
for (let i = 0; i < 3; i++) {
  const wins = qqWindows()
  const main = wins.filter((w) => w.visible && w.title.includes(' - '))
  console.log(`[第 ${i + 1} 次] 窗口 ${wins.length} 个`)
  for (const w of wins) {
    if (w.title.length === 0) continue
    const p = parseTitle(w.title)
    console.log(`   visible=${w.visible} 标题="${w.title}" → 歌名="${p.title}" 歌手="${p.artist}"`)
  }
  samples.push(main[0]?.title ?? '')
  await sleep(2000)
}

const stable = samples[0] && samples.every((s) => s === samples[0])
console.log(`\n主窗口标题 3 次采样稳定 = ${stable}`)

if (!CUT) {
  console.log('\n（加 --cut 可以再验"切歌后标题跟着变"——那会切用户的歌）')
  process.exit(0)
}

// ---- 按一次「下一首」，看标题跟不跟 ----
console.log('\n=== 按一次「下一首」（媒体键），看标题跟不跟 ===')
const before = samples[0] ?? ''
try {
  execFileSync(SMTC_EXE, ['next'], { encoding: 'utf-8', timeout: 15000 })
} catch {
  console.log('发媒体键失败')
}
let after = ''
let changed = false
for (let i = 0; i < 20; i++) {
  await sleep(400)
  const wins = qqWindows()
  const main = wins.filter((w) => w.visible && w.title.includes(' - '))[0]
  after = main?.title ?? ''
  if (after && after !== before) {
    changed = true
    break
  }
}
console.log(`切之前="${before}"`)
console.log(`切之后="${after}"`)
console.log(`标题跟着歌变了 = ${changed}`)
if (changed) {
  const p = parseTitle(after)
  console.log(`→ 歌名="${p.title}" 歌手="${p.artist}"`)
}
