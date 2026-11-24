// 探针：QQ 音乐有哪些窗口、哪个是主窗口（2026-11-24 下午）。
//
// 背景：SMTC 读不到会话（QQ 音乐新版内核不注册），
// 但 QQMusic.exe **有一个窗口，标题就是「歌名 - 歌手」**。
// 要用它当歌名来源，先得搞清楚：
//   - 哪个窗口是主窗口（不能靠"第一个带 ' - ' 的"这种猜法）
//   - 标题格式稳不稳定
//
// 只读，不动任何状态。

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ps = `
$ErrorActionPreference = 'Stop'
$code = @"
using System;using System.Text;using System.Runtime.InteropServices;
public class QQW {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public delegate bool EnumProc(IntPtr h, IntPtr p);
}
"@
Add-Type -TypeDefinition $code
$out = New-Object System.Collections.ArrayList
$cb = [QQW+EnumProc]{ param($h,$p)
  $procId = 0
  [void][QQW]::GetWindowThreadProcessId($h,[ref]$procId)
  $pn = ''
  try { $pn = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  if ($pn -eq 'QQMusic' -or $pn -eq 'qmbrowser') {
    $len = [QQW]::GetWindowTextLength($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len+1)
      [void][QQW]::GetWindowText($h,$sb,$sb.Capacity)
      $cn = New-Object System.Text.StringBuilder 256
      [void][QQW]::GetClassName($h,$cn,256)
      $vis = [QQW]::IsWindowVisible($h)
      [void]$out.Add(("{0}|{1}|{2}|{3}" -f $procId,$pn,$vis,($cn.ToString() + "::" + $sb.ToString().Trim())))
    }
  }
  return $true
}
[void][QQW]::EnumWindows($cb,[IntPtr]::Zero)
$out | ForEach-Object { $_ }
`

const dir = mkdtempSync(path.join(tmpdir(), 'qqw-'))
const file = path.join(dir, 'enum.ps1')
writeFileSync(file, ps, 'utf-8')

const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
  encoding: 'utf-8',
  timeout: 20000
})

console.log('pid | 进程 | 可见 | 类名 | 标题')
console.log('---'.repeat(4))
for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
  const [pid, proc, vis, rest] = line.split('|')
  const [cls, title] = (rest || '').split('::')
  console.log(`${pid} | ${proc} | ${vis} | ${cls} | ${title}`)
}
