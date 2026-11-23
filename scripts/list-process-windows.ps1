# List the top-level windows of an Electron app (diagnostic).
# Usage: powershell -File scripts\list-process-windows.ps1 [-Pid N] [-ExePathLike <glob>] [-Name <name>]
#
# Shows, per window: handle, visible?, title, class, rect.
# Used to answer "is the island window actually there?" without needing any
# real mouse input (which is impossible while the screen is locked).
#
# IMPORTANT (see docs/verification.md section 25): one Electron app is ~6
# processes with the same name. Only the main process holds windows, the
# single-instance lock and the userData dir. This script finds the main
# process for you (the one whose command line has no "--type="), so you
# cannot accidentally pick a GPU/utility child and see zero windows.

param(
  [int]$TargetPid = 0,
  [string]$ExePathLike = '',
  [string]$Name = ''
)

$src = @(
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class WinList {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  public static string Dump(uint target) {',
  '    var sb = new StringBuilder();',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      uint pid;',
  '      GetWindowThreadProcessId(h, out pid);',
  '      if (target != 0 && pid != target) return true;',
  '      var t = new StringBuilder(512);',
  '      GetWindowTextW(h, t, 512);',
  '      var c = new StringBuilder(512);',
  '      GetClassNameW(h, c, 512);',
  '      RECT r;',
  '      GetWindowRect(h, out r);',
  '      sb.AppendLine("  HWND=" + h + " PID=" + pid + " VISIBLE=" + IsWindowVisible(h) +',
  '        " CLASS=" + c.ToString() + " TITLE=" + t.ToString() +',
  '        " RECT=" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom);',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return sb.ToString();',
  '  }',
  '}'
) -join "`n"

if (-not ('WinList' -as [type])) { Add-Type -TypeDefinition $src }

function Get-ProcRows {
  # One row per process, with the info needed to tell main vs child.
  $rows = @()
  foreach ($p in (Get-CimInstance Win32_Process)) {
    $cmd = ''
    if ($p.CommandLine) { $cmd = $p.CommandLine }
    $isChild = ($cmd -match '--type=')
    $rows += [pscustomobject]@{
      Pid       = $p.ProcessId
      ParentPid = $p.ParentProcessId
      Name      = $p.Name
      Path      = $p.ExecutablePath
      Cmd       = $cmd
      IsChild   = $isChild
    }
  }
  return $rows
}

# 1) find candidate processes
$cands = @()
if ($Name -ne '') {
  $cands = Get-ProcRows | Where-Object { $_.Name -eq $Name }
} elseif ($ExePathLike -ne '') {
  $cands = Get-ProcRows | Where-Object { $_.Path -and ($_.Path -like $ExePathLike) }
} elseif ($TargetPid -ne 0) {
  $cands = Get-ProcRows | Where-Object { $_.Pid -eq $TargetPid -or $_.ParentPid -eq $TargetPid }
}

if ($cands.Count -gt 0) {
  # The main process is the ROOT of the app's process tree: its parent is
  # NOT one of the app's own pids. Everything else is a child
  # (gpu-process / renderer / utility / crashpad).
  # NOTE: CommandLine can be unreadable for some children (their --type=
  # flag is then invisible), so "no --type= in cmdline" alone is NOT a
  # reliable main-process test. Use the tree root.
  $candPids = @{}
  foreach ($c in $cands) { $candPids[[int]$c.Pid] = $true }
  $roots = $cands | Where-Object { -not $candPids.ContainsKey([int]$_.ParentPid) }
  Write-Output "=== process tree (root = main process) ==="
  foreach ($c in ($cands | Sort-Object Pid)) {
    $kind = 'child'
    if ($roots | Where-Object { $_.Pid -eq $c.Pid }) { $kind = 'MAIN' }
    $short = $c.Cmd
    if ($short -eq '') { $short = '(command line unreadable)' }
    if ($short.Length -gt 160) { $short = $short.Substring(0, 160) + '...' }
    Write-Output ("  PID=" + $c.Pid + " PPID=" + $c.ParentPid + " [" + $kind + "] NAME=" + $c.Name + " PATH=" + $c.Path)
    if ($c.IsChild) { Write-Output ("      --type= " + $short) }
  }
}

# 2) pick the main process (root of the app's process tree) unless the
#    caller pinned one with -Pid
$main = $null
if ($TargetPid -ne 0) {
  $main = $TargetPid
} elseif ($cands.Count -gt 0) {
  $candPids2 = @{}
  foreach ($c in $cands) { $candPids2[[int]$c.Pid] = $true }
  $root = $cands | Where-Object { -not $candPids2.ContainsKey([int]$_.ParentPid) } | Select-Object -First 1
  if ($root) { $main = $root.Pid }
}

if ($main) {
  Write-Output ""
  Write-Output ("=== windows of pid " + $main + " (main process) ===")
  Write-Output ([WinList]::Dump([uint32]$main))
} else {
  Write-Output ""
  Write-Output "=== no main process identified ==="
}

Write-Output ""
Write-Output "=== all visible top-level windows ==="
$all = [WinList]::Dump(0)
$lines = $all -split "`r?`n" | Where-Object { $_ -match 'VISIBLE=True' }
if ($lines) { $lines | ForEach-Object { Write-Output $_ } } else { Write-Output '  (none)' }
