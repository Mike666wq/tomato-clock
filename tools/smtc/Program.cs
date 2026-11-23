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
        case "vol":
            VolAsync(args);
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

/// <summary>
/// 给一个可能挂死的调用加超时。
///
/// 为什么要：**没开音乐软件时，SMTC 的 RequestAsync 可能一直不返回**
/// （实测：QQ 音乐关掉后 helper 的 watch 循环整个卡住，
///   连音量这种跟 SMTC 无关的功能都被拖死）。
/// 超时就当"没有会话"，音乐行藏掉，其余功能照常。
/// </summary>
static async Task<T> WithTimeout<T>(Task<T> task, int timeoutMs, T fallback)
{
    var finished = await Task.WhenAny(task, Task.Delay(timeoutMs));
    if (finished == task)
    {
        try { return await task; }
        catch { return fallback; }
    }
    return fallback;
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

/// <summary>读当前会话的播放状态和标题（判断命令到底有没有生效）</summary>
static async Task<(bool playing, string title)> ReadPlayingAsync(GlobalSystemMediaTransportControlsSession s)
{
    var info = new SessionInfo { SourceAppId = s.SourceAppUserModelId };
    await FillAsync(s, info);
    var playing = string.Equals(info.PlaybackState, "Playing", StringComparison.OrdinalIgnoreCase);
    return (playing, info.Title ?? "");
}

/// <summary>
/// 命令回执。watch 模式里主进程靠 kind=ack 区分它和状态行。
///
/// **策略：先 SMTC 命令 → 600ms 内状态没变 → 补发全局媒体键。**
///   原因（实测）：QQ 音乐**只肯读、不肯收** —— TryPlayAsync/TryPauseAsync
///   返回成功，但状态纹丝不动；真实媒体键却能立刻控制。
///
///   回执里的 ok = "真的生效了"（不是"调用成功"）。
///   主进程据此**不做乐观更新** —— 界面只认真实状态回流。
/// </summary>
static async Task<bool> CommandAsync(string cmd)
{
    var manager = await WithTimeout(ManagerAsync(), 3000, null);
    var s = manager?.GetCurrentSession();
    if (s is null)
    {
        Console.WriteLine(J(new { kind = "ack", command = cmd, ok = false, via = "none", error = "没有当前会话" }));
        return false;
    }

    var before = await ReadPlayingAsync(s);

    // 已经是目标状态就别发：别让「点暂停」把正在暂停的音乐点成播放
    bool alreadyThere = cmd switch
    {
        "play" => before.playing,
        "pause" => !before.playing,
        _ => false
    };
    if (alreadyThere)
    {
        Console.WriteLine(J(new { kind = "ack", command = cmd, ok = true, via = "noop", changed = false }));
        return true;
    }

    bool ok = cmd switch
    {
        "play" => await s.TryPlayAsync(),
        "pause" => await s.TryPauseAsync(),
        "next" => await s.TrySkipNextAsync(),
        "prev" => await s.TrySkipPreviousAsync(),
        _ => false
    };

    // SMTC 命令：等 600ms 看状态到底有没有变
    await Task.Delay(600);
    var after = await ReadPlayingAsync(s);
    bool changed = cmd switch
    {
        "play" => after.playing && !before.playing,
        "pause" => !after.playing && before.playing,
        "next" or "prev" => after.title != before.title,
        _ => false
    };

    string via = "smtc";
    if (!changed && ok)
    {
        // SMTC 没效果（QQ 音乐只肯读不肯收）→ 补发全局媒体键
        ushort vk = cmd switch
        {
            "play" or "pause" => MediaKeys.VkMediaPlayPause,
            "next" => MediaKeys.VkMediaNext,
            "prev" => MediaKeys.VkMediaPrev,
            _ => (ushort)0
        };
        if (vk != 0)
        {
            MediaKeys.Send(vk);
            via = "mediaKey";
            await Task.Delay(350);
            var final = await ReadPlayingAsync(s);
            changed = cmd switch
            {
                "play" => final.playing,
                "pause" => !final.playing,
                "next" or "prev" => final.title != before.title,
                _ => false
            };
        }
    }

    if (!changed && ok && via == "smtc")
    {
        // 不静默：主进程会把这行写进日志
        Console.Error.WriteLine($"SMTC 无效果，已走媒体键回退：{cmd}");
    }

    Console.WriteLine(J(new { kind = "ack", command = cmd, ok = ok && changed, via, changed }));
    return ok && changed;
}

/// 当前会话的一行状态。没有会话 / 没开音乐软件时给空标题，
/// 主进程据此把灵动岛上的那一行整个藏掉（不是留个空行）。
static async Task<object> StateLineAsync()
{
    var manager = await WithTimeout(ManagerAsync(), 3000, null);
    var s = manager?.GetCurrentSession();
    // 系统主音量：拿不到就是 null（界面据此隐藏音量入口，不显示假的 0）
    var volume = Volume.GetPercent();
    if (s is null)
    {
        return new
        {
            kind = "state",
            source = "",
            title = "",
            artist = "",
            playing = false,
            volume = volume ?? 0,
            volumeOk = volume.HasValue
        };
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
        playing,
        volume = volume ?? 0,
        volumeOk = volume.HasValue
    };
}

/// <summary>
/// 系统主音量：vol get | vol set &lt;0-100&gt;
///
/// 这跟键盘音量键调的是同一个数（系统总音量）。
/// 拿不到设备时 ok=false —— 界面据此隐藏音量入口，不显示一个假的 0。
/// </summary>
static void VolAsync(string[] argv)
{
    var sub = argv.Length > 1 ? argv[1] : "get";
    if (sub == "get")
    {
        var v = Volume.GetPercent();
        Console.WriteLine(J(new { kind = "volume", ok = v.HasValue, value = v ?? 0 }));
        return;
    }
    if (sub == "set")
    {
        if (argv.Length < 3 || !int.TryParse(argv[2], out int percent))
        {
            Console.WriteLine(J(new { kind = "volume", ok = false, value = 0, error = "用法: vol set <0-100>" }));
            return;
        }
        bool ok = Volume.SetPercent(percent);
        var after = Volume.GetPercent();
        Console.WriteLine(J(new { kind = "volume", ok, value = after ?? percent, error = ok ? "" : Volume.LastError }));
        return;
    }
    Console.WriteLine(J(new { kind = "volume", ok = false, value = 0, error = "未知子命令" }));
}

/// <summary>推一行音量状态（音量变了就推）</summary>
static void PushVolumeLine()
{
    var v = Volume.GetPercent();
    Console.WriteLine(J(new { kind = "volume", ok = v.HasValue, value = v ?? 0 }));
    Console.Out.Flush();
}

/// 常驻模式：每秒推一次状态；stdin 收到 play/pause/next/prev 就发命令
static async Task WatchAsync()
{
    // **音量先推**：音量跟 SMTC 无关，不能让它被"没有音乐会话"拖住
    PushVolumeLine();
    Console.WriteLine(J(await StateLineAsync()));
    Console.Out.Flush();

    // 音量变化通知：**优先用 Core Audio 的连接点回调**（跟手，不轮询）。
    // 注册不上（接口不存在 / GUID 对不上）就降级成 500ms 轮询 ——
    // 功能不因为这个挂掉，只是跟手差一点。
    bool notifyOk = Volume.TryStartNotification(() =>
    {
        try { PushVolumeLine(); }
        catch { /* 回调里出错也不许把 helper 带崩 */ }
    });
    int lastVolume = Volume.GetPercent() ?? -1;

    // 明说自己走的哪条路（回调 / 轮询），免得以后只能靠猜
    Console.WriteLine(J(new { kind = "volumeMode", mode = notifyOk ? "callback" : "poll", error = notifyOk ? "" : Volume.LastError }));
    Console.Out.Flush();

    // 音量的兜底轮询**独立跑**：绝不跟 SMTC 的主循环绑在一起
    // （SMTC 在没有会话时会挂住，曾把音量一起拖死）。
    //
    // 为什么是轮询而不是 IAudioEndpointVolumeCallback：
    //   Windows 10+ 的默认端点**不实现 COM 连接点** ——
    //   QI(IConnectionPoint) 和 QI(IConnectionPointContainer) 都回 E_NOINTERFACE
    //   （实测 hr=0x80004002），所以那条回调路在系统音量上走不通。
    //   200ms 一次 GetMasterVolumeLevelScalar 的开销可以忽略，
    //   外部按音量键后最多 200ms 滑条就跟上。
    //   （拖滑条时是界面本地先动，不等这个轮询。）
    if (!notifyOk)
    {
        _ = Task.Run(async () =>
        {
            int seen = Volume.GetPercent() ?? -1;
            while (true)
            {
                await Task.Delay(200);
                try
                {
                    var v = Volume.GetPercent();
                    if (v.HasValue && v.Value != seen)
                    {
                        seen = v.Value;
                        PushVolumeLine();
                    }
                }
                catch { /* 忽略，下一轮再试 */ }
            }
        });
    }

    _ = Task.Run(async () =>
    {
        while (true)
        {
            var line = await Console.In.ReadLineAsync();
            if (line is null) break;
            line = line.Trim();
            if (line.Length == 0) continue;
            try
            {
                if (line.StartsWith("vol", StringComparison.Ordinal))
                {
                    // vol <0-100>：设系统主音量
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2 && int.TryParse(parts[1], out int percent))
                    {
                        bool ok = Volume.SetPercent(percent);
                        var after = Volume.GetPercent();
                        if (after.HasValue) lastVolume = after.Value;
                        Console.WriteLine(J(new { kind = "ack", command = "vol", ok, value = after ?? percent, error = ok ? "" : Volume.LastError }));
                        Console.Out.Flush();
                    }
                    else
                    {
                        Console.WriteLine(J(new { kind = "ack", command = "vol", ok = false, value = 0, error = "用法: vol <0-100>" }));
                        Console.Out.Flush();
                    }
                }
                else
                {
                    await CommandAsync(line);
                }
            }
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

    int tick = 0;
    while (true)
    {
        await Task.Delay(1000);
        tick++;
        try
        {
            // 媒体状态每秒推一次（音量的推送在别的任务里，不受 SMTC 拖累）
            Console.WriteLine(J(await StateLineAsync()));
            Console.Out.Flush();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"轮询失败: {e.Message}");
        }
    }
}
