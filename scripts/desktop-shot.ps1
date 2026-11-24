# Dev tool: capture the composited desktop (GDI) and crop to a region.
#
# WHY THIS FILE IS ASCII ONLY:
#   Windows PowerShell 5.1 reads a .ps1 file as ANSI when there is no BOM,
#   so a Chinese literal gets mangled and can break the parser
#   (a mangled byte can terminate a here-string early).
#   Same rule as scripts/real-mouse.ps1.
#
# WHY SetProcessDPIAware():
#   Without it this process is DPI-unaware, so:
#     1) Screen.PrimaryScreen.Bounds reports the VIRTUALIZED size
#        (1707x1066 here, not the physical 2560x1600)
#     2) CopyFromScreen then copies only the top-left physical region
#        (1707x1066 physical pixels) - the right/bottom of the screen
#        never reaches the picture, and the island sits exactly there
#     3) the picture and the -X/-Y/-W/-H crop values end up in two
#        different coordinate spaces (very hard to debug)
#   After the call: the bitmap is the whole PHYSICAL screen and the
#   crop coordinates are physical pixels too.
#
# Usage:
#   powershell -File scripts/desktop-shot.ps1 -Out docs\shots\x.png -X 140 -Y 80 -W 482 -H 585
#
# Parameters:
#   -Out  output file
#   -X -Y -W -H  crop area in PHYSICAL pixels (omit for the whole screen)
#   -Pad  padding around the crop (keeps some desktop context visible)
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$W = -1,
  [int]$H = -1,
  [int]$Pad = 70
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$src = @'
using System;
using System.Runtime.InteropServices;
public class DpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
Add-Type -TypeDefinition $src
[void][DpiAware]::SetProcessDPIAware()

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bmp.Size)
$g.Dispose()

if ($X -ge 0 -and $W -gt 0) {
  $left = [Math]::Max(0, $X - $Pad)
  $top = [Math]::Max(0, $Y - $Pad)
  $right = [Math]::Min($bmp.Width, $X + $W + $Pad)
  $bottom = [Math]::Min($bmp.Height, $Y + $H + $Pad)
  $rect = New-Object System.Drawing.Rectangle $left, $top, ($right - $left), ($bottom - $top)
  $crop = $bmp.Clone($rect, $bmp.PixelFormat)
  $bmp.Dispose()
  $bmp = $crop
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "[desktop-shot] saved $Out ($($bmp.Width)x$($bmp.Height))"
