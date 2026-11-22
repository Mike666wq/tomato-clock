using SmtcTool;
// 灵动岛的媒体控制小工具（v0.4）。
//
// 用法：
//   smtc list                列出所有会话（来源 / 标题 / 艺术家 / 播放状态）
//   smtc current             只打印当前会话
//   smtc play | pause | next | prev    发控制命令
//   smtc watch               常驻：每秒输出一行 JSON（给主进程用，stdin 收命令）
//
// 输出是 JSON（一行一条），方便主进程直接解析。
//
// 为什么是 C#：PowerShell 5.1 / 7 的 WinRT 投影只投得出会话管理器，
// Session 和 MediaPlaybackProperties 是空壳（拿不到歌名、发不出命令）。
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

static async Task<bool> CommandAsync(string cmd)
{
    var manager = await ManagerAsync();
    var s = manager.GetCurrentSession();
    if (s is null)
    {
        Console.WriteLine(J(new { command = cmd, ok = false, error = "没有当前会话" }));
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
    Console.WriteLine(J(new { command = cmd, ok }));
    return ok;
}

// 常驻模式：每秒推一次所有会话；stdin 收到 play/pause/next/prev 就发命令
static async Task WatchAsync()
{
    Console.WriteLine(J(await SessionsAsync()));
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
        }
    });

    while (true)
    {
        await Task.Delay(1000);
        try
        {
            Console.WriteLine(J(await SessionsAsync()));
            Console.Out.Flush();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"轮询失败: {e.Message}");
        }
    }
}

