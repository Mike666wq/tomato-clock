# 开发期工具：抓桌面最终合成结果（GDI），并按给定区域裁剪。
#
# 为什么不用 CDP 截图拍桌面：CDP 拍的是窗口自己的像素，没有桌面环境。
# 「纸感是浅底，放在深色桌面上会不会太跳」这个问题必须看桌面实况。
#
# 用法：
#   powershell -File scripts/desktop-shot.ps1 -Out docs\shots\x.png -X 140 -Y 80 -W 482 -H 585
#
# 参数：
#   -Out  输出文件
#   -X -Y -W -H  裁剪区域（不填就抓整屏）
#   -Pad  裁剪时四周留多少边（看得见桌面环境）
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
Write-Output "[desktop-shot] saved $Out"
