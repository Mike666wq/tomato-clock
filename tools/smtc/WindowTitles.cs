using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace SmtcTool;

/// <summary>一个窗口的标题（以及认出它所需的其它信息）。</summary>
internal sealed class WindowTitleInfo
{
    /// <summary>窗口所属进程 id</summary>
    public uint ProcessId;

    /// <summary>进程名</summary>
    public string ProcessName = "";

    /// <summary>窗口类名</summary>
    public string ClassName = "";

    /// <summary>窗口标题</summary>
    public string Title = "";

    /// <summary>窗口是不是可见</summary>
    public bool Visible;
}

/// <summary>
/// 读**窗口标题**当作歌名的来源（2026-11-24 下午）。
///
/// 为什么需要它：
///   QQ 音乐这一版（内核 `qmbrowser.exe`）**不再向 Windows 报告 SMTC 会话**，
///   所以 `smtc current` 读不到歌名 —— 岛上那一块一直是空的。
///   但实测 QQMusic.exe **有一个窗口，标题就是「歌名 - 歌手」**：
///     class='QQMusic_Daemon_Wnd'  title='东风破 - 周杰伦'
///   而且按「下一首」时它**立刻跟着变**（实测：切之前"觉悟 - 混音太子"，
///   切之后"东风破 - 周杰伦"）。
///
/// ⚠ **这是个兜底，不是主力**：
///   Windows 上读"现在在放什么歌"的官方接口还是 SMTC，
///   读得到就该用它（有歌名还有播放状态）。
///   只有读不到的时候，才退到窗口标题这条路。
///
/// 为什么窗口标题这条路能走通：
///   主窗口的标题栏本来就显示"歌名 - 歌手"（这是播放器的惯例），
///   所以这不是 hack 出来的巧合，是**界面本来就在显示的信息**。
///
/// ⚠ **认窗口不能靠"第一个带 ' - ' 的"**：
///   QQ 音乐同时开着「播放模式选择」「播放队列」「TXMenuWindow」等十几个窗口，
///   挑错了就会显示"播放队列"。这里按**类名**认：
///   `QQMusic_Daemon_Wnd` 是主窗口（实测它的标题一直跟着歌变）。
/// </summary>
internal static class WindowTitles
{
    /// <summary>
    /// 认作"音乐播放器主窗口"的（进程名 → 窗口类名）。
    ///
    /// 类名是按类名认的，不是按标题 —— 标题会变，类名不会。
    /// </summary>
    private static readonly Dictionary<string, string[]> MusicWindowClasses = new()
    {
        // QQ 音乐：主窗口类名固定，标题是「歌名 - 歌手」
        ["qqmusic"] = new[] { "QQMusic_Daemon_Wnd" },
    };

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    /// <summary>最近一次失败的**原因**（写进日志，别让人猜）</summary>
    public static string LastError { get; private set; } = "";

    /// <summary>
    /// 列出所有音乐播放器主窗口的标题。
    ///
    /// 返回空列表 = 没有匹配的窗口（播放器没开，或者这一版换了类名）。
    /// </summary>
    public static List<WindowTitleInfo> MusicWindows()
    {
        var result = new List<WindowTitleInfo>();
        LastError = "";
        try
        {
            EnumWindows((hWnd, _) =>
            {
                try
                {
                    int len = GetWindowTextLength(hWnd);
                    if (len <= 0) return true;
                    var title = new StringBuilder(len + 1);
                    GetWindowText(hWnd, title, title.Capacity);
                    string text = title.ToString().Trim();
                    if (text.Length == 0) return true;

                    GetWindowThreadProcessId(hWnd, out uint pid);
                    string procName = ProcessNameOf(pid);
                    string key = procName.ToLowerInvariant();
                    if (!MusicWindowClasses.TryGetValue(key, out var classes)) return true;

                    var cls = new StringBuilder(256);
                    GetClassName(hWnd, cls, cls.Capacity);
                    string className = cls.ToString();
                    bool wanted = false;
                    foreach (var c in classes)
                    {
                        if (string.Equals(className, c, StringComparison.Ordinal)) { wanted = true; break; }
                    }
                    if (!wanted) return true;

                    result.Add(new WindowTitleInfo
                    {
                        ProcessId = pid,
                        ProcessName = procName,
                        ClassName = className,
                        Title = text,
                        Visible = IsWindowVisible(hWnd),
                    });
                }
                catch
                {
                    /* 单个窗口读不到就跳过，不影响其它 */
                }
                return true;
            }, IntPtr.Zero);
        }
        catch (Exception e)
        {
            LastError = $"{e.GetType().Name}: {e.Message}";
        }
        return result;
    }

    /// <summary>
    /// 从音乐播放器主窗口标题里拆出歌名和歌手。
    ///
    /// 格式是「歌名 - 歌手」（播放器标题栏的惯例）。
    /// **用最后一个 ' - ' 分**：歌名里也可能带 ' - '。
    ///
    /// 返回 (title, artist)：拆不出来就 title=原样、artist=""。
    /// </summary>
    public static (string title, string artist) ParseSongTitle(string windowTitle)
    {
        if (string.IsNullOrWhiteSpace(windowTitle)) return ("", "");
        int i = windowTitle.LastIndexOf(" - ", StringComparison.Ordinal);
        if (i <= 0 || i + 3 >= windowTitle.Length) return (windowTitle.Trim(), "");
        string song = windowTitle.Substring(0, i).Trim();
        string artist = windowTitle.Substring(i + 3).Trim();
        if (song.Length == 0) return (windowTitle.Trim(), "");
        return (song, artist);
    }

    /// <summary>
    /// 读音乐播放器现在放的歌（歌名 + 歌手）。
    ///
    /// 返回 null = 读不到（没有匹配窗口 / 标题里没有歌名）。
    /// </summary>
    public static (string title, string artist)? SongTitle()
    {
        var windows = MusicWindows();
        if (windows.Count == 0) return null;
        // 多个匹配时取标题最长的那个（主窗口的标题最完整）
        WindowTitleInfo? best = null;
        foreach (var w in windows)
        {
            if (best is null || w.Title.Length > best.Title.Length) best = w;
        }
        if (best is null) return null;
        var (song, artist) = ParseSongTitle(best.Title);
        if (song.Length == 0) return null;
        return (song, artist);
    }

    /// <summary>进程 id → 进程名（拿不到就空，不抛）</summary>
    private static string ProcessNameOf(uint pid)
    {
        if (pid == 0) return "";
        try
        {
            using var p = System.Diagnostics.Process.GetProcessById((int)pid);
            return p.ProcessName;
        }
        catch
        {
            return "";
        }
    }
}
