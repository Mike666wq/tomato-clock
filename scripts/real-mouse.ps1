# Real mouse driver (Windows).
#
# Drives the ACTUAL mouse cursor with SetCursorPos + mouse_event, so the app
# receives genuine OS-level input (unlike CDP's Input.dispatchMouseEvent,
# which is synthetic and does not carry pointer-capture semantics).
#
# NOTE: this file is deliberately pure ASCII. Windows PowerShell 5.1 reads
# .ps1 files as ANSI when there is no BOM, so a Chinese literal in here would
# be mangled and break the parser.
#
# Protocol: one command per line on stdin, "ok" on stdout.
#   move <x> <y>     move the cursor
#   down <x> <y>     move then press the left button
#   up               release the left button
#   get              print the current cursor position
#
# The C# source is assembled from an array instead of a here-string: the
# here-string swallowed the line breaks and produced a source file that would
# not compile.

$src = @(
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class RealMouse {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  public const uint LEFTDOWN = 0x0002;',
  '  public const uint LEFTUP = 0x0004;',
  '}'
) -join "`n"

if (-not ('RealMouse' -as [type])) {
  Add-Type -TypeDefinition $src
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split(' ')
  switch ($parts[0]) {
    'move' {
      [void][RealMouse]::SetCursorPos([int]$parts[1], [int]$parts[2])
    }
    'down' {
      [void][RealMouse]::SetCursorPos([int]$parts[1], [int]$parts[2])
      Start-Sleep -Milliseconds 150
      [RealMouse]::mouse_event([RealMouse]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    }
    'up' {
      [RealMouse]::mouse_event([RealMouse]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    }
    'get' {
      $p = New-Object RealMouse+POINT
      [void][RealMouse]::GetCursorPos([ref]$p)
      Write-Output ("POS " + $p.X + " " + $p.Y)
      [Console]::Out.Flush()
      continue
    }
    default { }
  }
  Write-Output 'ok'
  [Console]::Out.Flush()
}
