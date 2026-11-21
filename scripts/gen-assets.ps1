# 生成静态资源：托盘图标（番茄造型）+ 结束提示音 wav。
#
#   pwsh -File scripts/gen-assets.ps1
#
# 资产放在 resources/，与方案第三节目录结构一致。
# 托盘图标是几何番茄（小尺寸下不能糊），三态：
#   focus  番茄红实心
#   break  休息绿
#   paused 灰色 + 降低不透明度

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$res = Join-Path $root 'resources'
if (-not (Test-Path $res)) { New-Item -ItemType Directory -Path $res -Force | Out-Null }

$colors = @{
  focus = '#FF6B57'
  break = '#5AC49B'
  paused = '#9AA1AC'
}

function New-Tomato([string]$path, [string]$hex, [double]$alpha, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $body = [System.Drawing.ColorTranslator]::FromHtml($hex)
  $stem = [System.Drawing.ColorTranslator]::FromHtml('#5AC49B')
  if ($state -eq 'break') { $stem = [System.Drawing.ColorTranslator]::FromHtml('#3E9E7C') }

  # 番茄身：略高于宽的椭圆
  $bx = [float]($size * 0.16)
  $by = [float]($size * 0.26)
  $bw = [float]($size * 0.68)
  $bh = [float]($size * 0.68)
  $bodyBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int](255 * $alpha), $body))
  $g.FillEllipse($bodyBrush, $bx, $by, $bw, $bh)
  $bodyBrush.Dispose()

  # 蒂：顶部一个小三角 + 两片短叶，纯几何
  $stemBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int](255 * $alpha), $stem))
  $cx = [float]($size / 2)
  $tipY = [float]($size * 0.06)
  $points = New-Object 'System.Drawing.PointF[]' 3
  $points[0] = New-Object System.Drawing.PointF ([float]($cx - $size * 0.05)), $tipY
  $points[1] = New-Object System.Drawing.PointF $cx, ([float]($tipY + $size * 0.13))
  $points[2] = New-Object System.Drawing.PointF ([float]($cx + $size * 0.05)), $tipY
  $g.FillPolygon($stemBrush, $points)

  $leafPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb([int](255 * $alpha), $stem)), ([float][math]::Max(1, $size * 0.07))
  $leafPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $leafPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($leafPen, $cx, [float]($size * 0.19), [float]($cx - $size * 0.17), [float]($size * 0.11))
  $g.DrawLine($leafPen, $cx, [float]($size * 0.19), [float]($cx + $size * 0.17), [float]($size * 0.11))
  $leafPen.Dispose()
  $stemBrush.Dispose()

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

foreach ($size in @(16, 32)) {
  foreach ($state in @('focus', 'break', 'paused')) {
    $a = if ($state -eq 'paused') { 0.55 } else { 1.0 }
    New-Tomato (Join-Path $res "tray-$state-$size.png") $colors[$state] $a $size
  }
}

# ---------- 结束提示音：三音上行、短促、带衰减（接近木琴，不用电子闹表那种双音） ----------
function New-Ding([string]$path) {
  $sampleRate = 44100
  # 三个音依次上行：A5 → D6 → G6
  $tones = @(
    @{ freq = 880.0; dur = 0.13; gain = 0.42 },
    @{ freq = 1174.66; dur = 0.13; gain = 0.36 },
    @{ freq = 1567.98; dur = 0.34; gain = 0.30 }
  )
  $total = 0.0
  foreach ($t in $tones) { $total += $t.dur }
  $n = [int]($total * $sampleRate)
  $samples = New-Object 'double[]' $n

  $pos = 0
  foreach ($t in $tones) {
    $len = [int]($t.dur * $sampleRate)
    for ($i = 0; $i -lt $len; $i++) {
      $tt = $i / $sampleRate
      # 快衰减 + 极短起音，像被敲了一下
      $env = [math]::Exp(-16.0 * $tt) * [math]::Min(1.0, $tt / 0.0025)
      # 基频 + 一点点二次谐波，木琴那种有木头味
      $s = [math]::Sin(2 * [math]::PI * $t.freq * $tt) + 0.22 * [math]::Sin(4 * [math]::PI * $t.freq * $tt)
      $samples[$pos + $i] = $t.gain * $env * $s
    }
    $pos += $len
  }

  $bytes = New-Object 'System.Collections.Generic.List[byte]'
  $dataSize = $n * 2
  $bytes.AddRange([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
  $bytes.AddRange([System.BitConverter]::GetBytes([int](36 + $dataSize)))
  $bytes.AddRange([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
  $bytes.AddRange([System.Text.Encoding]::ASCII.GetBytes('fmt '))
  $bytes.AddRange([System.BitConverter]::GetBytes([int]16))
  $bytes.AddRange([System.BitConverter]::GetBytes([int16]1))      # PCM
  $bytes.AddRange([System.BitConverter]::GetBytes([int16]1))      # mono
  $bytes.AddRange([System.BitConverter]::GetBytes([int]$sampleRate))
  $bytes.AddRange([System.BitConverter]::GetBytes([int]($sampleRate * 2)))
  $bytes.AddRange([System.BitConverter]::GetBytes([int16]2))
  $bytes.AddRange([System.BitConverter]::GetBytes([int16]16))
  $bytes.AddRange([System.Text.Encoding]::ASCII.GetBytes('data'))
  $bytes.AddRange([System.BitConverter]::GetBytes([int]$dataSize))
  foreach ($s in $samples) {
    $v = [int]([math]::Round($s * 32767))
    if ($v -gt 32767) { $v = 32767 }
    if ($v -lt -32768) { $v = -32768 }
    $bytes.AddRange([System.BitConverter]::GetBytes([int16]$v))
  }
  [System.IO.File]::WriteAllBytes($path, $bytes.ToArray())
}

New-Ding (Join-Path $res 'ding.wav')

# ---------- 应用图标：256 PNG + ICO（打包用） ----------
function New-AppIcon([string]$pngPath, [string]$icoPath, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # 深色圆角底
  $bg = [System.Drawing.ColorTranslator]::FromHtml('#0E1013')
  $radius = [float]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [float]($size * 0.06)
  $path.AddArc([float]$d, [float]$d, $radius, $radius, 180, 90)
  $path.AddArc([float]($size - $d - $radius), [float]$d, $radius, $radius, 270, 90)
  $path.AddArc([float]($size - $d - $radius), [float]($size - $d - $radius), $radius, $radius, 0, 90)
  $path.AddArc([float]$d, [float]($size - $d - $radius), $radius, $radius, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $bg), $path)

  # 番茄
  $body = [System.Drawing.ColorTranslator]::FromHtml('#FF6B57')
  $stem = [System.Drawing.ColorTranslator]::FromHtml('#5AC49B')
  $brush = New-Object System.Drawing.SolidBrush $body
  $g.FillEllipse($brush, [float]($size * 0.22), [float]($size * 0.30), [float]($size * 0.56), [float]($size * 0.56))
  $brush.Dispose()

  $stemBrush = New-Object System.Drawing.SolidBrush $stem
  $cx = [float]($size / 2)
  $tipY = [float]($size * 0.12)
  $pts = New-Object 'System.Drawing.PointF[]' 3
  $pts[0] = New-Object System.Drawing.PointF ([float]($cx - $size * 0.05)), $tipY
  $pts[1] = New-Object System.Drawing.PointF $cx, ([float]($tipY + $size * 0.12))
  $pts[2] = New-Object System.Drawing.PointF ([float]($cx + $size * 0.05)), $tipY
  $g.FillPolygon($stemBrush, $pts)
  $pen = New-Object System.Drawing.Pen $stem, ([float][math]::Max(2, $size * 0.045))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($pen, $cx, [float]($size * 0.25), [float]($cx - $size * 0.15), [float]($size * 0.17))
  $g.DrawLine($pen, $cx, [float]($size * 0.25), [float]($cx + $size * 0.15), [float]($size * 0.17))
  $pen.Dispose()
  $stemBrush.Dispose()
  $g.Dispose()

  $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

  # ICO：把 PNG 原样塞进去（Vista+ 支持 PNG 压缩的 ICO 图标）
  $pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
  $ico = New-Object 'System.Collections.Generic.List[byte]'
  $ico.AddRange([System.BitConverter]::GetBytes([int16]0))
  $ico.AddRange([System.BitConverter]::GetBytes([int16]1))
  $ico.AddRange([System.BitConverter]::GetBytes([int16]1))
  $ico.AddRange([System.BitConverter]::GetBytes([byte]0))
  $ico.AddRange([System.BitConverter]::GetBytes([byte]0))
  $ico.AddRange([System.BitConverter]::GetBytes([byte]0))
  $ico.AddRange([System.BitConverter]::GetBytes([byte]0))
  $ico.AddRange([System.BitConverter]::GetBytes([int16]1))
  $ico.AddRange([System.BitConverter]::GetBytes([int16]32))
  $ico.AddRange([System.BitConverter]::GetBytes([int16]32))
  $ico.AddRange([System.BitConverter]::GetBytes([int]$pngBytes.Length))
  $ico.AddRange([System.BitConverter]::GetBytes([int]22))
  $ico.AddRange($pngBytes)
  [System.IO.File]::WriteAllBytes($icoPath, $ico.ToArray())

  $bmp.Dispose()
}

New-AppIcon (Join-Path $res 'icon.png') (Join-Path $res 'icon.ico') 256

Get-ChildItem $res | Select-Object Name, Length | Format-Table -AutoSize
