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
// ⚠ **输出编码必须是 UTF-8**：Windows 上 .NET 的控制台默认按 GBK 输出，
//   而主进程那边是按 UTF-8 读的 → helper 报的中文全是乱码
//   （实测日志里是 `smtc: ��ѯʧ��:`），媒体相关的错根本读不懂。
//   不修这条，以后所有媒体故障都只能靠猜。
Console.OutputEncoding = System.Text.Encoding.UTF8;

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

/**
 * 拿会话管理器。
 *
 * @param timeoutMs 等多久算超时（毫秒）
 * @param useCache   是否允许用缓存
 */
static async Task<GlobalSystemMediaTransportControlsSessionManager?> ManagerAsync(int timeoutMs, bool useCache = true)
{
    // 有缓存就直接用：不再等 RequestAsync
    if (useCache)
    {
        var cached = ManagerCache.Get();
        if (cached is not null) return cached;
    }

    // ⚠ 超时套在「整个读取任务」外面，不要用 op.AsTask()：
    //   RequestAsync() 返回的是 WinRT 的 IAsyncOperation，
    //   `await` 它走的是 WinRT 自己的调度（能正常完成）；
    //   而 AsTask() 转成普通 Task 后在这台机器上读不到会话。
    var work = ReadManagerAsync();
    var m = await WithTimeout<GlobalSystemMediaTransportControlsSessionManager?>(work, timeoutMs, null);
    if (m is not null)
    {
        ManagerCache.Put(m);
    }
    else if (useCache)
    {
        // 这次没取到，但缓存还在 → 继续用旧的（总比没有强）
        return ManagerCache.Manager;
    }
    return m;
}

/// <summary>
/// 读取会话管理器。
///
/// ⚠ 这里**直接 `await RequestAsync()`**（WinRT 的 IAsyncOperation 自带 awaiter）。
/// </summary>
static async Task<GlobalSystemMediaTransportControlsSessionManager?> ReadManagerAsync()
{
    return await RunOnStaThread(async () =>
        await GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
}

/// <summary>
/// 在一个**专用 STA 线程**上跑一段异步工作，把结果拿回来。
///
/// 为什么需要：WinRT 的很多 API 在 MTA 线程上会挂死（见 ReadManagerAsync 的注释）。
///
/// ⚠ 注意里面是 `work().GetAwaiter().GetResult()` —— 这是**阻塞** STA 线程等结果。
///   WinRT 的 awaiter 会把续体投回线程池（没有 SynchronizationContext 时），
///   所以不会自锁；真正的 COM 调用是在这个 STA 线程上发起的，那才是关键。
/// </summary>
static Task<T> RunOnStaThread<T>(Func<Task<T>> work)
{
    var tcs = new TaskCompletionSource<T>();
    var thread = new Thread(() =>
    {
        try
        {
            var result = work().GetAwaiter().GetResult();
            tcs.TrySetResult(result);
        }
        catch (Exception e)
        {
            tcs.TrySetException(e);
        }
    });
    thread.SetApartmentState(ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();
    return tcs.Task;
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

static async Task<List<SessionInfo>> SessionsAsync(int timeoutMs, bool useCache)
{
    var manager = await ManagerAsync(timeoutMs, useCache);
    var list = new List<SessionInfo>();
    if (manager is null) return list;
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
    // 一次性命令给**更长的超时**（10 秒）且**不用缓存**：
    // 它不是常驻循环，等得起；每次都重新取，避免拿到过期的 manager。
    var sessions = await SessionsAsync(10000, useCache: false);
    Console.WriteLine(J(sessions));
    foreach (var s in sessions)
    {
        Console.Error.WriteLine(
            $"来源: {s.SourceAppId}  状态: {s.PlaybackState}  标题: '{s.Title}'  艺术家: '{s.Artist}'");
    }
}

static async Task CurrentAsync()
{
    var manager = await ManagerAsync(10000, useCache: false);
    var s = manager?.GetCurrentSession();
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
    // 命令路径：**500ms 超时 + 用缓存**。
    // 缓存命中时是 0 等待；没命中也只等 500ms ——
    // 命令不该为了拿状态先堵 3 秒（那样媒体键回退要等 3 秒才发得出）。
    var manager = await ManagerAsync(500);
    var s = manager?.GetCurrentSession();

    // ⚠ **toggle 永远走媒体键**：它表示"播放/暂停切换"，
    //   而读不到会话时我们根本不知道当前是在放还是在停 ——
    //   SMTC 的 TryPlay/TryPause 是有方向的，用猜的方向会把状态弄反。
    //   媒体键（VK_MEDIA_PLAY_PAUSE）本身就是切换语义，交给 Windows 判断。
    if (cmd == "toggle")
    {
        bool sent = SendMediaKeyOnly(cmd);
        Console.WriteLine(J(new
        {
            kind = "ack",
            command = cmd,
            ok = sent,
            via = sent ? "mediaKey" : "none",
            changed = false,
            error = sent ? "已发全局媒体键（播放/暂停切换），无法验证是否生效" : "媒体键发送失败"
        }));
        return sent;
    }

    // ⚠⚠ **没有 SMTC 会话时，也要发媒体键** —— 这不是"放弃"，是能走的路。
    //
    // 背景：媒体键是**全局**的（Windows 直接发给当前媒体会话，不经过 SMTC 查询），
    // 所以即使读不到会话，命令照样发得出去。
    //
    // 以前这里是 `if (s is null) return false;` —— 直接放弃，
    // 于是"先 SMTC、600ms 没动静就补发媒体键"这条策略在
    // **读不到会话的机器上永远走不到回退那一步**，
    // 音乐控制在这些机器上等于完全失效（点了没反应，也不报错）。
    //
    // ⚠ **changed 必须是 false**：读不到状态就**无法验证**命令有没有生效。
    //   谎报 true 会让主进程把界面切成"已生效"，然后 400ms 后又弹回去 ——
    //   那就是"看起来动了其实没动"，正是这个功能最初被投诉的现象。
    //   诚实的做法：changed=false，界面保持原样；
    //   主进程那边 pending 超时后会恢复原状，不会骗用户。
    if (s is null)
    {
        bool sent = SendMediaKeyOnly(cmd);
        Console.WriteLine(J(new
        {
            kind = "ack",
            command = cmd,
            ok = sent,
            via = sent ? "mediaKey" : "none",
            changed = false,
            error = sent
                ? "读不到 SMTC 会话，已发全局媒体键，但无法验证是否生效"
                : "没有当前会话，且这个命令没有对应的媒体键"
        }));
        return sent;
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
        // toggle：没有会话时用的（不知道当前状态，让 Windows 自己判断）
        "toggle" => false,
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
        if (SendMediaKeyOnly(cmd))
        {
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

/// <summary>
/// 只走媒体键通道发一条命令。
///
/// 什么时候用：
///   1. SMTC 命令发了但状态没变（QQ 音乐只肯读、不肯收）；
///   2. **读不到 SMTC 会话** —— 媒体键是全局的，不需要会话也能发
///      （2026-11-24 中午实测：媒体键能控制 QQ 音乐，SMTC 却读不到它）。
///
/// 返回 false = 这个命令没有对应的媒体键（未知命令）。
/// </summary>
static bool SendMediaKeyOnly(string cmd)
{
    ushort vk = cmd switch
    {
        "play" or "pause" or "toggle" => MediaKeys.VkMediaPlayPause,
        "next" => MediaKeys.VkMediaNext,
        "prev" => MediaKeys.VkMediaPrev,
        _ => (ushort)0
    };
    if (vk == 0) return false;
    MediaKeys.Send(vk);
    return true;
}

/// 当前会话的一行状态。没有会话 / 没开音乐软件时给空标题，
/// 主进程据此把灵动岛上的那一行整个藏掉（不是留个空行）。
static async Task<Dictionary<string, object>> StateLineAsync()
{
    // watch 路径：**500ms 超时 + 用缓存**。
    // 原来用 3 秒超时且每次都重取 → 没音乐时轮询被拖成 4 秒一拍
    // （实测：每条 state 间隔 4015ms = 3 秒超时 + 1 秒轮询）。
    // 500ms + 缓存后，轮询回到 1 秒一拍，
    // 音乐关掉后那颗歌名也能在 ~1.5 秒内从岛上消失。
    var manager = await ManagerAsync(500);
    var s = manager?.GetCurrentSession();
    // 系统主音量：拿不到就是 null（界面据此隐藏音量入口，不显示假的 0）
    var volume = Volume.GetPercent();
    if (s is null)
    {
        return new Dictionary<string, object>
        {
            ["kind"] = "state",
            ["source"] = "",
            ["title"] = "",
            ["artist"] = "",
            ["playing"] = false,
            ["volume"] = volume ?? 0,
            ["volumeOk"] = volume.HasValue
        };
    }
    var info = new SessionInfo { SourceAppId = s.SourceAppUserModelId };
    await FillAsync(s, info);
    var playing = string.Equals(info.PlaybackState, "Playing", StringComparison.OrdinalIgnoreCase);
    return new Dictionary<string, object>
    {
        ["kind"] = "state",
        ["source"] = info.SourceAppId ?? "",
        ["title"] = info.Title ?? "",
        ["artist"] = info.Artist ?? "",
        ["playing"] = playing,
        ["volume"] = volume ?? 0,
        ["volumeOk"] = volume.HasValue
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

    // ---- 命令通道 ----
    //
    // ⚠ **读命令的循环绝不能被慢操作堵住**：
    //   媒体命令要等 SMTC 回状态（没开音乐软件时 RequestAsync 会挂到 3 秒超时），
    //   音量命令是纯 COM 调用（毫秒级）。
    //   以前两类在同一个循环里串行处理，音量命令排在媒体命令后面就被堵住了；
    //   更糟的是每条命令后都 await 一次 StateLineAsync()，
    //   那个调用同样会挂 3 秒 —— 结果是**每条音量命令之间隔了 3 秒**。
    //   实测拖动滑条时系统真值一直卡在第一次的值（80），界面却跟着乐观值走。
    //
    // 现在：音量命令在读循环里**就地处理**（快，不等任何人）；
    //       媒体命令丢给另一条通道慢慢办，不占着读循环。
    var mediaChannel = new SemaphoreSlim(1, 1);

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
                    // vol <0-100>：设系统主音量（**就地处理，不等 SMTC**）
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2 && int.TryParse(parts[1], out int percent))
                    {
                        bool ok = Volume.SetPercent(percent);
                        var after = Volume.GetPercent();
                        if (after.HasValue) lastVolume = after.Value;
                        Console.WriteLine(J(new { kind = "ack", command = "vol", ok, value = after ?? percent, error = ok ? "" : Volume.LastError }));
                        Console.Out.Flush();
                        // 只推音量行，不推媒体状态（那会拖慢这条通道）
                        PushVolumeLine();
                    }
                    else
                    {
                        Console.WriteLine(J(new { kind = "ack", command = "vol", ok = false, value = 0, error = "用法: vol <0-100>" }));
                        Console.Out.Flush();
                    }
                    continue; // 音量不等媒体状态刷新
                }
                // 媒体命令：另开一条通道办，不占着读循环
                string cmd = line;
                _ = Task.Run(async () =>
                {
                    await mediaChannel.WaitAsync();
                    try
                    {
                        await CommandAsync(cmd);
                        // 命令之后立刻推一次状态：界面不用等下一个轮询周期
                        Console.WriteLine(J(await StateLineAsync()));
                        Console.Out.Flush();
                    }
                    catch (Exception e) { Console.Error.WriteLine($"命令失败: {e.Message}"); }
                    finally { mediaChannel.Release(); }
                });
            }
            catch (Exception e) { Console.Error.WriteLine($"命令失败: {e.Message}"); }
        }
    });

    int tick = 0;
    // ---- 自愈计数 ----
    //
    // 连续读空（没有会话）达到阈值 → 丢弃缓存的 manager 重取；
    // 还是读空 → 自己退出，让主进程按它已有的重启机制拉一个新的。
    //
    // 为什么要有：SMTC 读会话这条路**时好时坏**（2026-11-23 深夜能读到，
    // 之后就一直读不到了，RequestAsync 不返回）。
    // 卡住的是**这个进程里**的 WinRT 调用和缓存的 manager ——
    // 换一个新进程往往就恢复了。主进程那边已经有"子进程退出就重启"的机制，
    // 这里主动退出就是用它。
    //
    // ⚠ **只在"曾经读到过、后来坏了"时才退出**：
    //   如果这个进程**从来没读到过**会话（没装音乐软件 / 这台机器的 SMTC 通道坏了），
    //   退出重来多少次都没用 —— 只会变成
    //   "退出 → 5 秒后重启 → 再退出"的无限循环（实测踩过，每 20 秒一轮）。
    //   那种情况下安静地继续跑着（音量照常工作），等真读到了会话再说。
    int emptyReads = 0;
    int cacheDrops = 0;
    bool everReadSession = false;
    const int EMPTY_READS_TO_DROP_CACHE = 5;   // 连续 5 次读空 → 丢缓存重取
    const int EMPTY_READS_TO_EXIT = 10;        // 丢过缓存还是读空 → 自己退出

    while (true)
    {
        await Task.Delay(1000);
        tick++;
        try
        {
            // 媒体状态每秒推一次（音量的推送在别的任务里，不受 SMTC 拖累）
            var line = await StateLineAsync();
            Console.WriteLine(J(line));
            Console.Out.Flush();

            // 读空计数：state 里 title/artist 都是空 = 没读到会话
            bool empty = ReadStateIsEmpty(line);
            if (empty)
            {
                emptyReads++;
                if (emptyReads == EMPTY_READS_TO_DROP_CACHE && ManagerCache.Manager is not null)
                {
                    // 缓存的 manager 可能是坏的（拿着它就是读不到）→ 丢掉重取
                    ManagerCache.Clear();
                    cacheDrops++;
                    Console.Error.WriteLine($"连续 {emptyReads} 次读不到会话，丢弃缓存的会话管理器重取");
                }
                else if (emptyReads >= EMPTY_READS_TO_EXIT && everReadSession)
                {
                    Console.Error.WriteLine(
                        $"连续 {emptyReads} 次读不到会话（曾经读到过，现在坏了；丢弃缓存 {cacheDrops} 次仍无效），自己退出让主进程重启");
                    // 用退出码告诉主进程"这是自愈退出，不是崩溃"
                    Environment.Exit(3);
                }
                else if (emptyReads == EMPTY_READS_TO_EXIT && !everReadSession)
                {
                    // 从来没读到过 → 退出重来没用，安静继续跑（音量照常可用）
                    Console.Error.WriteLine(
                        $"连续 {emptyReads} 次读不到会话（从未读到过会话，重启也没用），继续运行（音量照常可用）");
                    emptyReads = 0; // 别反复刷这条日志
                }
            }
            else
            {
                emptyReads = 0;
                everReadSession = true;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"轮询失败: {e.Message}");
        }
    }
}

/**
 * 判断一条 state 里有没有会话（title/artist 都空 = 没读到）。
 * 传进来的是 StateLineAsync 返回的对象。
 */
static bool ReadStateIsEmpty(object lineObj)
{
    if (lineObj is not Dictionary<string, object> map) return true;
    string title = map.TryGetValue("title", out var t) ? (t as string ?? "") : "";
    string artist = map.TryGetValue("artist", out var a) ? (a as string ?? "") : "";
    return title.Length == 0 && artist.Length == 0;
}

// ---------------------------------------------------------------------------
// 类型声明必须在顶层语句之后（C# 的要求）。
// ---------------------------------------------------------------------------

/**
 * 会话管理器的缓存。
 *
 * 为什么缓存：`RequestAsync()` 有时要好几秒才返回（甚至不返回）。
 * 每秒轮询都重取一次 → 轮询节奏被它拖死，而且**拿到过一次的 manager 之后
 * 完全可以复用**（它是系统级的句柄，会话列表自己会变）。
 *
 * 缓存在这里有两个好处：
 *   1. 轮询节奏恢复成 1 秒（原来被 3 秒超时拖成 4 秒一拍）；
 *   2. 命令不必等 3 秒才走媒体键回退。
 */
internal static class ManagerCache
{
    /// <summary>缓存的会话管理器；null = 还没取到过</summary>
    public static GlobalSystemMediaTransportControlsSessionManager? Manager;

    /// <summary>缓存是什么时候取的</summary>
    public static DateTime At = DateTime.MinValue;

    /// <summary>缓存有效期：5 分钟。系统会话变化不需要重新取，GetSessions 会自己反映</summary>
    public const int ValidMinutes = 5;

    /// <summary>取缓存里的（过期的当没有）</summary>
    public static GlobalSystemMediaTransportControlsSessionManager? Get()
    {
        if (Manager is null) return null;
        if ((DateTime.UtcNow - At).TotalMinutes >= ValidMinutes) return null;
        return Manager;
    }

    /// <summary>存起来</summary>
    public static void Put(GlobalSystemMediaTransportControlsSessionManager manager)
    {
        Manager = manager;
        At = DateTime.UtcNow;
    }

    /// <summary>丢掉缓存（自愈用：缓存的 manager 本身可能是坏的）</summary>
    public static void Clear()
    {
        Manager = null;
        At = DateTime.MinValue;
    }
}
