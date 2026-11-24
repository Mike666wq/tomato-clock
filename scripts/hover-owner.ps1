# Move the real cursor to a point AND ask which window is there.
# Both in ONE process, so the DPI awareness state is identical for both.
#
# Commands (stdin):
#   probe <x> <y>   move the cursor there, then report cursor pos + window owner
#   quit
#
# NOTE: this file is deliberately pure ASCII (Windows PowerShell 5.1 reads
# .ps1 files as ANSI when there is no BOM).

$src = @(
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class HoverProbe {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
  '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '}'
) -join "`n"

if (-not ('HoverProbe' -as [type])) { Add-Type -TypeDefinition $src }

function Get-CursorInfo {
  $p = New-Object HoverProbe+POINT
  [void][HoverProbe]::GetCursorPos([ref]$p)
  return $p
}

function Get-WindowInfo([int]$x, [int]$y) {
  $p = New-Object HoverProbe+POINT
  $p.X = $x
  $p.Y = $y
  $h = [HoverProbe]::WindowFromPoint($p)
  $t = New-Object System.Text.StringBuilder 512
  [void][HoverProbe]::GetWindowText($h, $t, 512)
  $c = New-Object System.Text.StringBuilder 512
  [void][HoverProbe]::GetClassName($h, $c, 512)
  $r = New-Object HoverProbe+RECT
  [void][HoverProbe]::GetWindowRect($h, [ref]$r)
  $procId = 0
  [void][HoverProbe]::GetWindowThreadProcessId($h, [ref]$procId)
  $procName = ''
  try { $procName = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName } catch { }
  return ("HWND=" + $h + " CLASS=" + $c.ToString() + " TITLE=" + $t.ToString() +
          " RECT=" + $r.Left + "," + $r.Top + "," + $r.Right + "," + $r.Bottom +
          " PID=" + $procId + " PROC=" + $procName)
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split(' ')
  switch ($parts[0]) {
    'probe' {
      $x = [int]$parts[1]
      $y = [int]$parts[2]
      # 先挪到别处，再挪到目标点 ——
      # Windows 会**合并鼠标移动消息**：光标本来就在那儿的话，
      # 再移过去可能不产生移动事件，hover 就不会触发（踩过）。
      [void][HoverProbe]::SetCursorPos(5, 5)
      Start-Sleep -Milliseconds 300
      [void][HoverProbe]::SetCursorPos($x, $y)
      Start-Sleep -Milliseconds 400
      $cur = Get-CursorInfo
      Write-Output ("POS " + $cur.X + " " + $cur.Y + "  TARGET " + $x + " " + $y)
      Write-Output ("OWNER_AT_CURSOR " + (Get-WindowInfo $cur.X $cur.Y))
      Write-Output ("OWNER_AT_TARGET " + (Get-WindowInfo $x $y))
      [Console]::Out.Flush()
      continue
    }
    'quit' { break }
    default { }
  }
  Write-Output 'ok'
  [Console]::Out.Flush()
}
