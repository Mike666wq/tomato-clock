# Find a visible window by its title and report its screen rect (in DIP).
# Used by verification scripts that need a window's screen position --
# the packaged build has no dev-only IPC for that (it is compiled out).
#
# NOTE: this file is deliberately pure ASCII. Windows PowerShell 5.1 reads
# .ps1 files as ANSI when there is no BOM, so a Chinese literal in here
# would be mangled and break the parser. Pass the title as an argument
# instead (command-line arguments are Unicode).
#
# Usage: powershell -NoProfile -File scripts\find-window.ps1 <title>

param([string]$Title = '')

if ($Title -eq '') { Write-Output 'NO_TITLE'; exit 1 }

$src = @(
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class FindWin {',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
  '}'
) -join "`n"

if (-not ('FindWin' -as [type])) { Add-Type -TypeDefinition $src }

$script:Target = $Title
$script:found = $null
$cb = [FindWin+EnumProc]{
  param($hw, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][FindWin]::GetWindowText($hw, $sb, 256)
  if ($sb.ToString() -eq $script:Target) {
    if ([FindWin]::IsWindowVisible($hw)) { $script:found = $hw; return $false }
  }
  return $true
}
[void][FindWin]::EnumWindows($cb, [IntPtr]::Zero)

if ($found) {
  $r = New-Object FindWin+RECT
  [void][FindWin]::GetWindowRect($found, [ref]$r)
  Write-Output ("$($r.L),$($r.T),$($r.R),$($r.B)")
} else {
  Write-Output 'NOT_FOUND'
}
