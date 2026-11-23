# List the top-level windows of a process (diagnostic).
# Usage: powershell -File scripts\list-process-windows.ps1 [pid]
#
# Shows, per window: handle, visible?, title, class, rect.
# Used to answer "is the island window actually there?" without needing any
# real mouse input (which is impossible while the screen is locked).

param([int]$TargetPid = 0)

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

Write-Output ("=== windows of pid " + $TargetPid + " ===")
Write-Output ([WinList]::Dump([uint32]$TargetPid))

Write-Output "=== all visible top-level windows ==="
$all = [WinList]::Dump(0)
$lines = $all -split "`r?`n" | Where-Object { $_ -match 'VISIBLE=True' }
if ($lines) { $lines | ForEach-Object { Write-Output $_ } } else { Write-Output '  (none)' }
