using SmtcTool;
// 灵动岛的媒体控制小工具（v0.4 / v0.2.2 接入产品）。
//
// 用法：
//   smtc list                列出所有会话（来源 / 标题 / 艺术家 / 播放状态）
//   smtc current             只打印当前会话
//   smtc play | pause | next | prev    发控制命令
//   smtc watch               常驻：每秒输出一行状态 JSON，stdin 收命令
//
// watch 模式是给主进程用的，协议就两行：
//   {"kind":"state","source":"Tencent.QQMusic","title":"…","artist":"…","playing":true}
//   {"kind":"ack","command":"play","ok":true}
// 主进程按 "kind" 区分：state 更新界面，ack 只是命令回执。
//
// 为什么是 C#：PowerShell 5.1 / 7 的 WinRT 投影只投得出会话管理器，
// Session 和 MediaPlaybackProperties 都是空壳（拿不到歌名、发不出命令）。
// 这里的 TFM 是 net8.0-windows10.0.19041.0，投影由 .NET SDK 自带，方法全都在。

using System.Text.Json;
using Windows.Media.Control;

var cmd = args.Length > 0 ? args[0] : "list";

try
{
    switch (cmd)
    {
        case "list":
            await ListAsync();
            break;
        case "current":
            await CurrentAsync();
            break;
        case "play":
        case "pause":
        case "next":
        case "prev":
            await CommandAsync(cmd);
            break;
        case "watch":
            await WatchAsync();
            break;
        default:
            Console.Error.WriteLine($"未知命令: {cmd}");
            return 1;
    }
}
catch (Exception e)
{
    Console.Error.WriteLine($"失败: {e.GetType().Name}: {e.Message}");
    return 2;
}
return 0;

static string J(object o) => JsonSerializer.Serialize(o);

static async Task<GlobalSystemMediaTransportControlsSessionManager> ManagerAsync()
{
    return await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
}

static async Task FillAsync(GlobalSystemMediaTransportControlsSession s, SessionInfo info)
{
    info.PlaybackState = s.GetPlaybackInfo().PlaybackStatus.ToString();
    try
    {
        var r = await s.TryGetMediaPropertiesAsync();
        info.Title = r.Title;
        info.Artist = r.Artist;
        info.Album = r.AlbumTitle;
    }
    catch (Exception e)
    {
        info.Error = e.Message;
    }
}

static async Task<List<SessionInfo>> SessionsAsync()
{
    var manager = await ManagerAsync();
    var list = new List<SessionInfo>();
    foreach (var s in manager.GetSessions())
    {
        var info = new SessionInfo { SourceAppId = s.SourceAppUserModelId };
        await FillAsync(s, info);
        list.Add(info);
    }
    return list;
}

static async Task ListAsync()
{
    var sessions = await SessionsAsync();
    Console.WriteLine(J(sessions));
    foreach (var s in sessions)
    {
        Console.Error.WriteLine(
            $"来源: {s.SourceAppId}  状态: {s.PlaybackState}  标题: '{s.Title}'  艺术家: '{s.Artist}'");
    }
}

static async Task CurrentAsync()
{
    var manager = await ManagerAsync();
    var s = manager.GetCurrentSession();
    if (s is null)
    {
        Console.WriteLine(J(new SessionInfo { Error = "没有当前会话" }));
        return;
    }
    var info = new SessionInfo { SourceAppId = s.SourceAppUserModelId };
    await FillAsync(s, info);
    Console.WriteLine(J(info));
}

/// 命令回执。watch 模式里主进程靠 kind=ack 区分它和状态行。
static async Task<bool> CommandAsync(string cmd)
{
    var manager = await ManagerAsync();
    var s = manager.GetCurrentSession();
    if (s is null)
    {
        Console.WriteLine(J(new { kind = "ack", command = cmd, ok = false, error = "没有当前会话" }));
        return false;
    }
    var ok = cmd switch
    {
        "play" => await s.TryPlayAsync(),
        "pause" => await s.TryPauseAsync(),
        "next" => await s.TrySkipNextAsync(),
        "prev" => await s.TrySkipPreviousAsync(),
        _ => false
    };
    Console.WriteLine(J(new { kind = "ack", command = cmd, ok }));
    return ok;
}

/// 当前会话的一行状态。没有会话 / 没开音乐软件时给空标题，
/// 主进程据此把灵动岛上的那一行整个藏掉（不是留个空行）。
static async Task<object> StateLineAsync()
{
    var manager = await ManagerAsync();
    var s = manager.GetCurrentSession();
    if (s is null)
    {
        return new { kind = "state", source = "", title = "", artist = "", playing = false };
    }
    var info = new SessionInfo { SourceAppId = s.SourceAppUserModelId };
    await FillAsync(s, info);
    var playing = string.Equals(info.PlaybackState, "Playing", StringComparison.OrdinalIgnoreCase);
    return new
    {
        kind = "state",
        source = info.SourceAppId ?? "",
        title = info.Title ?? "",
        artist = info.Artist ?? "",
        playing
    };
}

// 常驻模式：每秒推一次状态；stdin 收到 play/pause/next/prev 就发命令
static async Task WatchAsync()
{
    Console.WriteLine(J(await StateLineAsync()));
    Console.Out.Flush();

    _ = Task.Run(async () =>
    {
        while (true)
        {
            var line = await Console.In.ReadLineAsync();
            if (line is null) break;
            line = line.Trim();
            if (line.Length == 0) continue;
            try { await CommandAsync(line); }
            catch (Exception e) { Console.Error.WriteLine($"命令失败: {e.Message}"); }
            // 命令之后立刻推一次状态：界面不用等下一个轮询周期
            try
            {
                Console.WriteLine(J(await StateLineAsync()));
                Console.Out.Flush();
            }
            catch (Exception e) { Console.Error.WriteLine($"状态刷新失败: {e.Message}"); }
        }
    });

    while (true)
    {
        await Task.Delay(1000);
        try
        {
            Console.WriteLine(J(await StateLineAsync()));
            Console.Out.Flush();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"轮询失败: {e.Message}");
        }
    }
}
