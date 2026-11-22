# SMTC 探针（一次性脚本，不进产品代码）
# 目的：回答"PowerShell 能不能枚举 SMTC 会话、拿到标题/艺术家、发播放/暂停/下一首"
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\smtc-probe.ps1
#
# 两个踩过的坑：
#   1) 脚本必须存成 UTF-8 带 BOM，否则 Windows PowerShell 5.1 按 ANSI 读，中文直接解析失败
#   2) 调 WinRT 静态方法必须写完整类型名：
#      [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()
#      短名（不带 ,ContentType=WindowsRuntime）在静态调用点上会解析失败

$ErrorActionPreference = 'Continue'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Write-Output "== 环境 =="
Write-Output ("PowerShell " + $PSVersionTable.PSVersion.ToString())

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $task = $asTask.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$MT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]

Write-Output "`n== 1) 哪些 WinRT 类型能加载 =="
foreach ($n in @(
  'Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime',
  'Windows.Media.Control.SystemMediaTransportControlsSession,Windows.Media.Control,ContentType=WindowsRuntime',
  'Windows.Media.Control.MediaPlaybackProperties,Windows.Media.Control,ContentType=WindowsRuntime',
  'Windows.Media.SystemMediaTransportControls,Windows.Media,ContentType=WindowsRuntime'
)) {
  try {
    $t = [Type]::GetType($n)
    if ($t) { Write-Output "  OK   " + $n } else { Write-Output "  加载不出来 " + $n }
  } catch { Write-Output ("  异常 " + $n + " :: " + $_.Exception.Message) }
}

Write-Output "`n== 2) 能不能枚举会话 =="
$manager = $null
try {
  $manager = Await ($MT::RequestAsync()) $MT
  $sessions = $manager.GetSessions()
  Write-Output ("  会话数: " + $sessions.Count)
  foreach ($s in $sessions) {
    Write-Output ("   - 来源: " + $s.SourceAppUserModelId + "  状态: " + $s.GetPlaybackInfo().PlaybackState)
  }
} catch {
  Write-Output ("  枚举失败: " + $_.Exception.Message)
}

Write-Output "`n== 3) 能不能拿标题 / 艺术家 =="
$session = $null
try {
  $session = $manager.GetCurrentSession()
  if ($null -eq $session) {
    Write-Output "  没有当前会话"
  } else {
    try {
      $props = Await ($session.GetMediaPropertiesAsync()) ([Windows.Media.Control.MediaPlaybackProperties,Windows.Media.Control,ContentType=WindowsRuntime])
      Write-Output ("  标题: '" + $props.Title + "'  艺术家: '" + $props.Artist + "'")
    } catch {
      Write-Output ("  取属性失败（WinRT 投影不出这个方法）: " + $_.Exception.Message)
    }
  }
} catch { Write-Output ("  取当前会话失败: " + $_.Exception.Message) }

Write-Output "`n== 4) 能不能发播放 / 暂停 / 下一首 =="
if ($null -eq $session) {
  Write-Output "  没有会话，跳过"
} else {
  try {
    Write-Output ("  TryPause    -> " + $session.TryPause())
    Start-Sleep -Milliseconds 300
    Write-Output ("  TryPlay     -> " + $session.TryPlay())
    Write-Output ("  TrySkipNext -> " + $session.TrySkipNext())
  } catch {
    Write-Output ("  命令发不出去（WinRT 投影不出这些方法）: " + $_.Exception.Message)
  }
}

Write-Output "`n== 5) 成本 =="
try {
  $t0 = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt 5; $i++) {
    $ss = $manager.GetSessions()
    foreach ($x in $ss) { $null = $x.GetPlaybackInfo().PlaybackState }
  }
  $t0.Stop()
  Write-Output ("  5 轮枚举: " + $t0.ElapsedMilliseconds + " ms，平均 " + [math]::Round($t0.ElapsedMilliseconds / 5, 1) + " ms/轮")
} catch { Write-Output ("  计时失败: " + $_.Exception.Message) }

$t1 = [System.Diagnostics.Stopwatch]::StartNew()
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Get-Process -Id $PID).Path
$psi.Arguments = '-NoProfile -Command "exit 0"'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$p = [System.Diagnostics.Process]::Start($psi)
$p.WaitForExit()
$t1.Stop()
Write-Output ("  冷启一个 PowerShell 子进程: " + $t1.ElapsedMilliseconds + " ms")

$sw.Stop()
Write-Output ("`n探针总耗时: " + $sw.ElapsedMilliseconds + " ms")
