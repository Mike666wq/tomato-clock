# Find a visible window by its title AND by the executable path that owns it.
# Reports the screen rect (in DIP).
#
# Why the path filter: the packaged build has no dev-only IPC to ask for its
# own window rect (it is compiled out), so verification scripts fall back to
# enumerating windows. But the machine may run several copies at once -- the
# user's own install plus the one under test -- and every island window has the
# SAME title ("\u7075\u52a8\u5c9b"). Matching on title alone picks whichever
# comes first in the enumeration, which may be the wrong one.
#
# The path filter makes it deterministic: only the window owned by the
# executable under test is reported.
#
# NOTE: this file is deliberately pure ASCII. Windows PowerShell 5.1 reads
# .ps1 files as ANSI when there is no BOM, so a Chinese literal in here would
# be mangled and break the parser. Pass the title as an argument instead
# (command-line arguments are Unicode).
#
# Usage:
#   powershell -NoProfile -File scripts\find-window-by-path.ps1 <title> <exePathSubstring>

param(
  [string]$Title = '',
  [string]$PathLike = ''
)

if ($Title -eq '') { Write-Output 'NO_TITLE'; exit 1 }

$src = @(
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class FindWinBP {',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
  '}'
) -join "`n"

if (-not ('FindWinBP' -as [type])) { Add-Type -TypeDefinition $src }

$script:Target = $Title
$script:PathLike = $PathLike
$script:found = $null

# Does this process (or any ancestor) belong to the executable under test?
#
# Why ancestors matter: the portable single-file build unpacks itself into a
# temp folder and the real window belongs to that unpacked copy
# (Temp\<hash>\app.exe), whose path does NOT contain the downloaded file's
# name. Its parent process, however, IS the downloaded file -- so walking up
# the parent chain finds it.
$script:procInfo = @{}

function Test-BelongsToTarget([uint32]$procId) {
  if ($script:PathLike -eq '') { return $true }
  $cur = $procId
  for ($i = 0; $i -lt 5; $i++) {
    if ($cur -eq 0) { break }
    $info = $script:procInfo[$cur]
    if ($null -eq $info) {
      $info = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
      $script:procInfo[$cur] = $info
    }
    if ($null -eq $info) { break }
    $path = "$($info.ExecutablePath) $($info.CommandLine)"
    if ($path -like "*$($script:PathLike)*") { return $true }
    $cur = [uint32]$info.ParentProcessId
  }
  return $false
}

$cb = [FindWinBP+EnumProc]{
  param($hw, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][FindWinBP]::GetWindowText($hw, $sb, 256)
  if ($sb.ToString() -ne $script:Target) { return $true }
  if (-not [FindWinBP]::IsWindowVisible($hw)) { return $true }

  $procId = 0
  [void][FindWinBP]::GetWindowThreadProcessId($hw, [ref]$procId)
  if (-not (Test-BelongsToTarget $procId)) { return $true }

  $script:found = $hw
  return $false
}

[void][FindWinBP]::EnumWindows($cb, [IntPtr]::Zero)

if ($found) {
  $r = New-Object FindWinBP+RECT
  [void][FindWinBP]::GetWindowRect($found, [ref]$r)
  Write-Output ("$($r.L),$($r.T),$($r.R),$($r.B)")
} else {
  Write-Output 'NOT_FOUND'
}
