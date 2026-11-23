# 开发期工具：临时换壁纸（截图用），用完必须换回去。
#
# 用法：
#   powershell -File scripts\wallpaper.ps1 -Set "C:\path\light.jpg"
#   powershell -File scripts\wallpaper.ps1 -Restore
#
# 背景：验收「浅底界面放在深色/浅色桌面上跳不跳」需要两种桌面各截一张。
# 改用户的壁纸属于有副作用的操作，所以这个脚本负责改，也负责改回去，
# 并且把原壁纸路径记在 .tmp\wallpaper-backup.txt 里。
param(
  [string]$Set = '',
  [switch]$Restore,
  [string]$Backup = '.tmp\wallpaper-backup.txt'
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Wallpaper {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@

$SPI_SETDESKWALLPAPER = 20
$SPIF_UPDATEINIFILE = 1
$SPIF_SENDCHANGE = 2

$dir = Split-Path -Parent $Backup
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

if ($Restore) {
  if (Test-Path $Backup) {
    $orig = (Get-Content $Backup -Raw).Trim()
    if ($orig) {
      [Wallpaper]::SystemParametersInfo($SPI_SETDESKWALLPAPER, 0, $orig, $SPIF_UPDATEINIFILE -bor $SPIF_SENDCHANGE) | Out-Null
      Write-Output "[wallpaper] restored: $orig"
    }
    Remove-Item $Backup -Force
  } else {
    Write-Output "[wallpaper] 没有备份可还原"
  }
  exit 0
}

if ($Set) {
  if (-not (Test-Path $Backup)) {
    $cur = (Get-ItemProperty 'HKCU:\Control Panel\Desktop').WallPaper
    Set-Content -Path $Backup -Value $cur -Encoding UTF8
  }
  [Wallpaper]::SystemParametersInfo($SPI_SETDESKWALLPAPER, 0, $Set, $SPIF_UPDATEINIFILE -bor $SPIF_SENDCHANGE) | Out-Null
  Write-Output "[wallpaper] set: $Set"
}
