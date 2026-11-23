# Which window is under a screen point? (diagnostic)
# Usage: powershell -File scripts\point-owner.ps1 <x> <y>
param([int]$X = 0, [int]$Y = 0)

$src = @(
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class PointOwner {',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '}'
) -join "`n"

if (-not ('PointOwner' -as [type])) { Add-Type -TypeDefinition $src }

$p = New-Object PointOwner+POINT
$p.X = $X
$p.Y = $Y
$h = [PointOwner]::WindowFromPoint($p)
$sb = New-Object System.Text.StringBuilder 512
[void][PointOwner]::GetWindowText($h, $sb, 512)
$r = New-Object PointOwner+RECT
[void][PointOwner]::GetWindowRect($h, [ref]$r)
$procId = 0
[void][PointOwner]::GetWindowThreadProcessId($h, [ref]$procId)
Write-Output ("HANDLE=" + $h)
Write-Output ("TITLE=" + $sb.ToString())
Write-Output ("RECT=" + $r.Left + "," + $r.Top + "," + $r.Right + "," + $r.Bottom)
Write-Output ("PID=" + $procId)
try {
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc) { Write-Output ("PROC=" + $proc.ProcessName + " PATH=" + $proc.Path) }
} catch { }
