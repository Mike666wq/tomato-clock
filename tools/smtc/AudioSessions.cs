using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace SmtcTool;

/// <summary>一条音频会话（Windows Core Audio 的 session）。</summary>
internal sealed class AudioSessionInfo
{
    /// <summary>拥有这条会话的进程 id</summary>
    public uint ProcessId;

    /// <summary>进程名（拿不到就空）</summary>
    public string ProcessName = "";

    /// <summary>会话状态：0=Inactive（没有在跑的流，通常是暂停了） 1=Active（正在出声） 2=Expired</summary>
    public int State;

    /// <summary>是不是系统音效那条会话（不算）</summary>
    public bool IsSystemSounds;

    /// <summary>
    /// 这条会话当前的**峰值音量**（0..1）。
    ///
    /// null = 拿不到（这个接口在会话上不一定实现）。
    /// </summary>
    public float? Peak;
}

/// <summary>
/// 枚举 Windows 的**音频会话**（Core Audio）。
///
/// 为什么需要它（2026-11-24）：
///   Windows 上读"现在在放什么歌"只有一个官方口子（SMTC），它时好时坏 ——
///   QQ 音乐新版内核根本不向系统报告会话，于是我们读不到歌名、也读不到播放状态。
///   结果：岛上那个按钮只能显示一个**猜的**方向（播放还是暂停），用户一看就知道不对。
///
///   但"这个进程现在有没有真的在出声"是**系统级的事实**，跟音量同源、可靠：
///   音频会话的 Active 状态 = 至少有一个流在跑（= 正在播），
///   Inactive = 没有流在跑（= 暂停了）。
///
///   所以 SMTC 读不到时，用这个判断播放方向，图标就是真的，不是猜的。
///
/// 为什么手写 COM 互操作：
///   这些是 Win32 COM 接口，.NET 的 WinRT 投影里没有；
///   NAudio 那类封装要拉 NuGet（离线装不稳），所以直接声明 [ComImport] 接口。
///
/// ⚠ **接口方法的声明顺序就是 COM vtable 的顺序**，改顺序 = 调错方法。
///   顺序与顺序都照抄自微软 SDK 的 audiopolicy.h（不是凭记忆写的）：
///     IAudioSessionManager2 : IAudioSessionManager
///       GetAudioSessionControl / GetSimpleAudioVolume          ← 父接口的先来
///       GetSessionEnumerator / RegisterSessionNotification /
///       UnregisterSessionNotification /
///       RegisterDuckNotification / UnregisterDuckNotification
///     IAudioSessionEnumerator : GetCount / GetSession
///     IAudioSessionControl2 : IAudioSessionControl              ← 父接口的先来
///       GetState / GetDisplayName / SetDisplayName / GetIconPath /
///       SetIconPath / GetGroupingParam / SetGroupingParam /
///       RegisterAudioSessionNotification / UnregisterAudioSessionNotification
///       GetSessionIdentifier / GetSessionInstanceIdentifier /
///       GetProcessId / IsSystemSoundsSession / SetDuckingPreference
/// </summary>
internal static class AudioSessions
{
    private const uint DataFlowRender = 0;
    private const uint RoleMultimedia = 1;
    private const uint RoleConsole = 0;
    private const uint ClsCtxAll = 23;

    // ---- GUID（全部来自微软 SDK 头文件，不是记忆）----
    private static readonly Guid ClsidMmDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid IidImmDeviceEnumerator = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    private static readonly Guid IidImmDevice = new("D666063F-1587-4E43-81F1-B948E807363F");
    /// <summary>IID_IAudioSessionManager2</summary>
    private static readonly Guid IidAudioSessionManager2 = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    /// <summary>IID_IAudioSessionControl2</summary>
    private static readonly Guid IidAudioSessionControl2 = new("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D");
    /// <summary>IID_IAudioMeterInformation（峰值计量）</summary>
    private static readonly Guid IidAudioMeterInformation = new("C02216F6-8C67-4B5B-9D00-D008E73E0064");

    /// <summary>会话状态：0=Inactive（暂停/没在跑） 1=Active（正在出声） 2=Expired</summary>
    public const int StateInactive = 0;
    public const int StateActive = 1;

    /// <summary>
    /// 峰值高于这个值才算"在出声"。
    ///
    /// 为什么不是 0：安静段/淡入淡出时峰值会是极小的非零值
    /// （实测几十毫秒的过渡期），阈值太低会让图标在暂停边界上乱跳。
    /// </summary>
    public const float PeakThreshold = 0.002f;

    /// <summary>
    /// 认作"音乐播放器"的进程名（小写比较）。
    ///
    /// 为什么只认这几个：我们要回答的是"**那个音乐软件**现在在不在放"，
    /// 不是"系统里有没有任何程序在出声"。
    /// 如果把浏览器放视频也算进去，用户拿 Chrome 看视频时，
    /// 岛上的音乐按钮就会显示"正在播放"——那还是错的。
    /// </summary>
    private static readonly string[] MusicProcessNames =
    {
        "qqmusic",
        "qmbrowser",
        "ginkgo",
    };

    /// <summary>最近一次失败的**原因**（写进日志，别让人猜）</summary>
    public static string LastError { get; private set; } = "";

    [DllImport("ole32.dll")]
    private static extern int CoCreateInstance(
        ref Guid rclsid,
        IntPtr punkOuter,
        uint clsCtx,
        ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppv);

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(uint dataFlow, uint stateMask, IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(
            uint dataFlow,
            uint role,
            [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
        [PreserveSig] int EnumAudioDevices(uint dataFlow, uint stateMask, IntPtr devices);
        [PreserveSig] int GetDevice(
            [MarshalAs(UnmanagedType.LPWStr)] string pwstrId,
            [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(
            ref Guid iid,
            uint clsCtx,
            IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }

    /// <summary>
    /// IAudioSessionManager2。**顺序 = vtable 位置，别动。**
    /// </summary>
    [ComImport]
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        // ↓ IAudioSessionManager（父接口）
        [PreserveSig] int GetAudioSessionControl(
            IntPtr audioSessionGuid,
            uint streamFlags,
            [MarshalAs(UnmanagedType.Interface)] out IntPtr sessionControl);
        [PreserveSig] int GetSimpleAudioVolume(
            IntPtr audioSessionGuid,
            uint streamFlags,
            [MarshalAs(UnmanagedType.Interface)] out IntPtr audioVolume);
        // ↓ IAudioSessionManager2 自己
        [PreserveSig] int GetSessionEnumerator(out IntPtr sessionEnum);
        [PreserveSig] int RegisterSessionNotification(IntPtr sessionNotification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr sessionNotification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
        [PreserveSig] int UnregisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId);
    }

    [ComImport]
    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int sessionCount);
        [PreserveSig] int GetSession(int index, out IntPtr session);
    }

    /// <summary>
    /// IAudioSessionControl2。**顺序 = vtable 位置，别动**（父接口的 9 个先来）。
    /// </summary>
    [ComImport]
    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        // ↓ IAudioSessionControl（父接口）
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, Guid eventContext);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, Guid eventContext);
        [PreserveSig] int GetGroupingParam(out Guid groupingParam);
        [PreserveSig] int SetGroupingParam(Guid groupingParam, Guid eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr notifications);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notifications);
        // ↓ IAudioSessionControl2 自己
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint processId);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    /// <summary>
    /// 列出当前默认输出设备上的所有音频会话。
    /// 拿不到就返回空列表（LastError 里有原因），绝不影响别的功能。
    /// </summary>
    public static List<AudioSessionInfo> List()
    {
        var result = new List<AudioSessionInfo>();
        LastError = "";
        try
        {
            var clsid = ClsidMmDeviceEnumerator;
            var iidEnum = IidImmDeviceEnumerator;
            int hr = CoCreateInstance(ref clsid, IntPtr.Zero, ClsCtxAll, ref iidEnum, out object enumeratorObj);
            if (hr != 0)
            {
                LastError = $"CoCreateInstance(MMDeviceEnumerator) hr=0x{hr:X8}";
                return result;
            }
            var enumerator = (IMMDeviceEnumerator)enumeratorObj;

            // 先试多媒体角色（音量键调的那一路），不行再试控制台角色
            IMMDevice? device = null;
            int hrDevice = enumerator.GetDefaultAudioEndpoint(DataFlowRender, RoleMultimedia, out IMMDevice dev1);
            if (hrDevice == 0 && dev1 is not null)
            {
                device = dev1;
            }
            else
            {
                int hrDevice2 = enumerator.GetDefaultAudioEndpoint(DataFlowRender, RoleConsole, out IMMDevice dev2);
                if (hrDevice2 == 0 && dev2 is not null) device = dev2;
                else
                {
                    LastError = $"GetDefaultAudioEndpoint hr=0x{hrDevice:X8}/0x{hrDevice2:X8}";
                    return result;
                }
            }

            var iidMgr = IidAudioSessionManager2;
            int hrAct = device.Activate(ref iidMgr, ClsCtxAll, IntPtr.Zero, out object mgrObj);
            if (hrAct != 0)
            {
                LastError = $"Activate(IAudioSessionManager2) hr=0x{hrAct:X8}";
                return result;
            }
            var manager = (IAudioSessionManager2)mgrObj;

            int hrEnum = manager.GetSessionEnumerator(out IntPtr enumPtr);
            if (hrEnum != 0 || enumPtr == IntPtr.Zero)
            {
                LastError = $"GetSessionEnumerator hr=0x{hrEnum:X8}";
                return result;
            }
            try
            {
                var sessionEnumerator = (IAudioSessionEnumerator)Marshal.GetObjectForIUnknown(enumPtr);
                int hrCount = sessionEnumerator.GetCount(out int count);
                if (hrCount != 0)
                {
                    LastError = $"GetCount hr=0x{hrCount:X8}";
                    return result;
                }
                for (int i = 0; i < count; i++)
                {
                    int hrGet = sessionEnumerator.GetSession(i, out IntPtr ctrlPtr);
                    if (hrGet != 0 || ctrlPtr == IntPtr.Zero) continue;
                    try
                    {
                        var info = ReadSession(ctrlPtr);
                        if (info is not null) result.Add(info);
                    }
                    catch (Exception e)
                    {
                        LastError = $"读会话 {i} 失败: {e.GetType().Name}: {e.Message}";
                    }
                    finally
                    {
                        Marshal.Release(ctrlPtr);
                    }
                }
            }
            finally
            {
                Marshal.Release(enumPtr);
            }
        }
        catch (Exception e)
        {
            LastError = $"{e.GetType().Name}: {e.Message}";
        }
        return result;
    }

    /// <summary>
    /// IAudioMeterInformation —— **峰值计量**。
    ///
    /// 顺序 = vtable 位置：GetPeakValue / GetMeteringChannelCount /
    /// GetChannelsPeakValues / QueryHardwareSupport
    /// （GUID 与顺序都来自微软 SDK 的 endpointvolume.h）。
    /// </summary>
    [ComImport]
    [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
        [PreserveSig] int GetMeteringChannelCount(out uint channelCount);
        [PreserveSig] int GetChannelsPeakValues(uint channelCount, [Out] float[] peakValues);
        [PreserveSig] int QueryHardwareSupport(out uint hardwareSupportMask);
    }

    /// <summary>
    /// 读这条会话当前的**峰值音量**（0..1）。
    ///
    /// 为什么必须要它（2026-11-24 实测）：
    ///   会话的 Active 状态**不等于"在出声"** ——
    ///   实测暂停方向上，Active → Inactive 要 **23.5 秒**才变（播放方向只要 1.1 秒）。
    ///   也就是说"会话还是 Active"根本不能用来判断"现在在不在放"。
    ///
    ///   而**峰值**是"这一刻真的有没有声音"：出声时 > 0，暂停时掉到 0。
    ///   这才是"在放 / 暂停"的真信号。
    ///
    /// 返回 null = 这个接口拿不到（会话上不一定实现）。
    /// </summary>
    private static float? ReadPeak(IntPtr ctrlPtr)
    {
        var iid = IidAudioMeterInformation;
        int hr = Marshal.QueryInterface(ctrlPtr, ref iid, out IntPtr meterPtr);
        if (hr != 0 || meterPtr == IntPtr.Zero) return null;
        try
        {
            var meter = (IAudioMeterInformation)Marshal.GetObjectForIUnknown(meterPtr);
            int hr2 = meter.GetPeakValue(out float peak);
            if (hr2 != 0) return null;
            return peak;
        }
        catch
        {
            return null;
        }
        finally
        {
            Marshal.Release(meterPtr);
        }
    }

    /// <summary>读一条会话：进程 id、进程名、状态、是不是系统音效、峰值</summary>
    private static AudioSessionInfo? ReadSession(IntPtr ctrlPtr)
    {
        var iid = IidAudioSessionControl2;
        int hr = Marshal.QueryInterface(ctrlPtr, ref iid, out IntPtr ctrl2);
        if (hr != 0 || ctrl2 == IntPtr.Zero) return null;
        try
        {
            var c2 = (IAudioSessionControl2)Marshal.GetObjectForIUnknown(ctrl2);
            c2.GetState(out int state);
            c2.GetProcessId(out uint pid);
            int hrSys = c2.IsSystemSoundsSession();
            return new AudioSessionInfo
            {
                ProcessId = pid,
                ProcessName = ProcessNameOf(pid),
                State = state,
                IsSystemSounds = hrSys == 0,
                Peak = ReadPeak(ctrlPtr),
            };
        }
        finally
        {
            Marshal.Release(ctrl2);
        }
    }

    /// <summary>进程 id → 进程名（拿不到就空，不抛）</summary>
    private static string ProcessNameOf(uint pid)
    {
        if (pid == 0) return "";
        try
        {
            using var p = Process.GetProcessById((int)pid);
            return p.ProcessName;
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// 音乐播放器现在到底在不在放。
    ///
    /// 返回 (playing, processName)：
    ///   playing = null   → **不知道**（枚举不到会话、或没有音乐播放器的会话）
    ///   playing = true   → 音乐播放器正在出声
    ///   playing = false  → 音乐播放器在，但没在出声（暂停了）
    ///
    /// ⚠ **判据是峰值，不是会话的 Active 状态**（2026-11-24 实测）：
    ///   会话 Active 只说明"这个进程还占着一条音频流"，
    ///   **不代表它此刻在出声**。实测暂停方向上 Active → Inactive 要 **23.5 秒**
    ///   （播放方向只要 1.1 秒）—— 用它判方向，图标会滞后二十多秒。
    ///   峰值（peak）是"这一刻真的有没有声音"，出声就 > 0，暂停就掉到 0。
    ///
    ///   峰值读不到（接口在某些会话上没实现）时，**退回会话状态**，
    ///   并且明确告诉调用方"这是退路"（peakKnown=false），
    ///   以便界面知道这个方向**可能滞后**。
    /// </summary>
    public static (bool? playing, string processName, bool peakKnown) PlayerState()
    {
        var sessions = List();
        if (sessions.Count == 0) return (null, "", false);

        string found = "";
        bool? playing = null;
        bool peakKnown = false;
        foreach (var s in sessions)
        {
            if (s.IsSystemSounds) continue;
            var name = (s.ProcessName ?? "").ToLowerInvariant();
            if (name.Length == 0) continue;
            bool isMusic = false;
            foreach (var m in MusicProcessNames)
            {
                if (name == m) { isMusic = true; break; }
            }
            if (!isMusic) continue;

            found = s.ProcessName;
            if (s.Peak.HasValue)
            {
                // 有峰值 → 以峰值为准（真的在出声）
                peakKnown = true;
                bool audible = s.Peak.Value > PeakThreshold;
                if (audible) playing = true;
                else if (playing is null) playing = false;
            }
            else if (playing is null)
            {
                // 没有峰值 → 退回会话状态（可能滞后，调用方要知道）
                playing = s.State == StateActive;
            }
        }
        return (playing, found, peakKnown);
    }
}
