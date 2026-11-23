# 开发期工具：临时显示桌面（截图前把别的窗口让开），再按一次还原。
#
# 用法：
#   powershell -File scripts\show-desktop.ps1
#
# 为什么需要：真机验收要拍"桌面环境里的界面"，前面盖着别的窗口就拍不到壁纸。
param(
  [switch]$Undo
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Keys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint KEYUP = 0x0002;
  public static void WinD() {
    keybd_event(0x5B, 0, 0, UIntPtr.Zero);   // 左 Win
    keybd_event(0x44, 0, 0, UIntPtr.Zero);   // D
    keybd_event(0x44, 0, KEYUP, UIntPtr.Zero);
    keybd_event(0x5B, 0, KEYUP, UIntPtr.Zero);
  }
}
'@

[Keys]::WinD()
Write-Output "[show-desktop] toggled (run again to restore)"
