using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace SmtcTool;

/// <summary>
/// 媒体键通道（全局热键那套）。
///
/// 为什么需要它：**QQ 音乐只肯读 SMTC，不肯收控制**。
/// 实测：给会话发 TryPlayAsync/TryPauseAsync，helper 回 ok:true，
/// 但状态纹丝不动；而用真实媒体键（VK_MEDIA_PLAY_PAUSE）能立刻控制。
/// 所以策略是「先 SMTC，不见效就补发媒体键」。
///
/// ⚠ 媒体键是**全局**的：同时有别的播放器在放时，这一下可能打到别人身上。
/// 这是 Windows 的机制，不是我们的 bug —— 但得写进文档，别瞒着用户。
///
/// 键码：
///   VK_MEDIA_NEXT_TRACK  0xB0
///   VK_MEDIA_PREV_TRACK  0xB1
///   VK_MEDIA_PLAY_PAUSE  0xB3
/// </summary>
internal static class MediaKeys
{
    public const ushort VkMediaNext = 0xB0;
    public const ushort VkMediaPrev = 0xB1;
    public const ushort VkMediaPlayPause = 0xB3;

    private const uint KeyEventFKeyUp = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    /// <summary>发一次媒体键（按下 + 抬起）</summary>
    public static void Send(ushort vk)
    {
        keybd_event((byte)vk, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event((byte)vk, 0, KeyEventFKeyUp, UIntPtr.Zero);
    }
}
