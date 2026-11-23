# Drag / resize the main window for real, using Win32 calls.
#
# The end-to-end script uses this to verify v0.6 defect D2:
# does dragging the window push back a setting you just changed
# (theme / preset / volume)?
#
# Why not CDP: Electron does not expose Browser.getWindowForTarget in this
# build, and resizing via CDP is not the same thing as a user dragging the
# window. This goes through the real resize/move event path.
#
# Why not FindWindow("..."): FindWindow marshals the title as ANSI, so a
# Chinese title never matches. And the app has two windows (main window and
# the always-on-top island) in the SAME process, so the title is not unique
# enough anyway. Instead: enumerate the windows of the Electron process and
# pick the big one (the main window is ~480x580, the island is ~190x48).
#
# NOTE: this file is deliberately pure ASCII. Windows PowerShell 5.1 reads
# .ps1 files as ANSI when there is no BOM, so a Chinese literal in here would
# be mangled and break the parser.
#
# The C# source is assembled from an array instead of a here-string: the
# here-string swallowed the line breaks and produced a source file that would
# not compile.
#
# Usage: powershell -File scripts\resize-window.ps1 -Times 20 -ExePathLike '*\electron.exe'
#
# Process selection: by EXECUTABLE PATH only.
# Filtering by a command line fragment is forbidden on purpose: the fragment
# also shows up in the command line of the shell that runs this filter, so
# the filter ends up killing its own runner (it happened once).
# This file stays pure ASCII on purpose. Windows PowerShell 5.1 reads .ps1
# files as ANSI when there is no BOM, so a Chinese literal in here would be
# mangled and break the parser.

param(
  [int]$Times = 20,
  [string]$ExePathLike = '',
  [string]$CmdLineLike = ''
)

# Old switch, kept only to give a clear error instead of silently dragging
# the wrong window (or none).
if ($CmdLineLike -ne '') {
  Write-Output 'USE_EXEPATH: filtering by command line fragment is forbidden. Use -ExePathLike.'
  exit 2
}
if ($ExePathLike -eq '') {
  Write-Output 'NO_EXEPATH: pass -ExePathLike <path wildcard>.'
  exit 2
}

$src = @(
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class Win32Move {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct RECT { public int Left, Top, Right, Bottom; }',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")]',
  '  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);',
  '  public static IntPtr FindBigWindow(uint targetPid, int minW, int minH) {',
  '    IntPtr found = IntPtr.Zero;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      uint pid;',
  '      GetWindowThreadProcessId(h, out pid);',
  '      if (pid != targetPid) return true;',
  '      RECT r;',
  '      GetWindowRect(h, out r);',
  '      if ((r.Right - r.Left) >= minW && (r.Bottom - r.Top) >= minH) { found = h; return false; }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return found;',
  '  }',
  '}'
) -join "`n"

if (-not ('Win32Move' -as [type])) {
  Add-Type -TypeDefinition $src
}

# Pick the process by EXECUTABLE PATH (never by command line fragment).
# Several copies of the app can run side by side: the user's installed one
# and the packaged one under test -- the wrong one must not be dragged.
$pids = @()
foreach ($cim in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
  if ($null -eq $cim.ExecutablePath) { continue }
  if ($cim.ExecutablePath -notlike $ExePathLike) { continue }
  $pids += $cim.ProcessId
}
if ($pids.Count -eq 0) {
  Write-Output 'NO_PROCESS'
  exit 1
}

$h = [IntPtr]::Zero
foreach ($pid2 in $pids) {
  $h = [Win32Move]::FindBigWindow([uint32]$pid2, 300, 300)
  if ($h -ne [IntPtr]::Zero) { break }
}
if ($h -eq [IntPtr]::Zero) {
  Write-Output 'NO_WINDOW'
  exit 1
}

$r = New-Object Win32Move+RECT
[void][Win32Move]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top

for ($i = 0; $i -lt $Times; $i++) {
  # Alternate width and nudge the position, so both resize and move fire.
  $dw = if ($i % 2 -eq 0) { 12 } else { -12 }
  $dx = if ($i % 3 -eq 0) { 2 } else { -2 }
  [void][Win32Move]::MoveWindow($h, $r.Left + $dx, $r.Top + $dx, ($w + $dw), $ht, $true)
  Start-Sleep -Milliseconds 80
}

# Put it back where it was (the position is supposed to be remembered anyway).
[void][Win32Move]::MoveWindow($h, $r.Left, $r.Top, $w, $ht, $true)
Write-Output "RESIZED $Times"
