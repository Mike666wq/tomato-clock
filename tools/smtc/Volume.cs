using System;
using System.Runtime.InteropServices;

namespace SmtcTool;

/// <summary>
/// 系统主音量（Windows Core Audio 的 IAudioEndpointVolume）。
///
/// 这是**系统总音量** —— 跟键盘上的音量键调的是同一个数：
/// 改它，所有应用的声音一起变大变小。
/// （"只调 QQ 音乐那一路"是另一套 API —— 按会话枚举的 IAudioSessionManager2，
///   不在这轮里。）
///
/// 为什么手写 COM 互操作：
///   音量接口是 Win32 COM，不是 WinRT —— .NET 的 WinRT 投影里没有它。
///   NAudio 那类封装需要 NuGet 拉包（离线环境装不稳），
///   所以这里直接声明 [ComImport] 接口，让 CLR 按声明顺序映射 vtable。
///
/// **接口方法的声明顺序就是 COM vtable 的顺序**，改顺序 = 调错方法。
///   IAudioEndpointVolume：IUnknown 之后依次是
///   RegisterControlBus / UnregisterControlBus / GetChannelCount /
///   SetMasterVolumeLevel / SetMasterVolumeLevelScalar /
///   GetMasterVolumeLevel / GetMasterVolumeLevelScalar / ...
/// </summary>
internal static class Volume
{
    /// <summary>eRender：默认的音频输出设备</summary>
    private const uint DataFlowRender = 0;
    /// <summary>eMultimedia：多媒体角色的默认设备（音量键调的就是这一路）</summary>
    private const uint RoleMultimedia = 1;
    private const uint ClsCtxAll = 23;

    private static readonly Guid ClsidMmDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid IidImmDeviceEnumerator = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    private static readonly Guid IidImmDevice = new("D666063F-1587-4E43-81F1-B948E807363F");
    private static readonly Guid IidAudioEndpointVolume = new("5CDF2C82-841E-4546-9722-0CF74078229A");

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
        // 顺序不能改：GetDefaultAudioEndpoint 是第 2 个（IUnknown 之后）
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
        // Activate 是第 1 个（IUnknown 之后）
        [PreserveSig] int Activate(
            ref Guid iid,
            uint clsCtx,
            IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport]
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        // 顺序 = vtable 位置，别动
        [PreserveSig] int RegisterControlBus(IntPtr busId, ref Guid iid, IntPtr ppv);
        [PreserveSig] int UnregisterControlBus(IntPtr busId, ref Guid iid);
        [PreserveSig] int GetChannelCount(out uint channelCount);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, Guid eventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, Guid eventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, Guid eventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, Guid eventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
        [PreserveSig] int VolumeStepUp(ref Guid eventContext, uint flags);
        [PreserveSig] int VolumeStepDown(ref Guid eventContext, uint flags);
        [PreserveSig] int QueryHardwareSupport(out uint hardwareSupportMask);
        [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
    }

    /// <summary>最近一次失败的**原因**（写进 ack 的 error 字段，别让人猜）</summary>
    public static string LastError { get; private set; } = "";

    /// <summary>缓存的端点实例（设备不变时不必每次重建 COM 对象）</summary>
    private static IAudioEndpointVolume? _cached;
    private static DateTime _cachedAt = DateTime.MinValue;

    /// <summary>拿到默认输出设备的音量接口；拿不到就返回 null（没有音频设备 / 没有会话）</summary>
    private static IAudioEndpointVolume? TryGetEndpointVolume()
    {
        // 缓存 5 分钟：轮询时每次都 CoCreateInstance + Activate 太浪费
        if (_cached is not null && (DateTime.UtcNow - _cachedAt).TotalMinutes < 5) return _cached;
        try
        {
            var clsid = ClsidMmDeviceEnumerator;
            var iid = IidImmDeviceEnumerator;
            int hr = CoCreateInstance(ref clsid, IntPtr.Zero, ClsCtxAll, ref iid, out object enumeratorObj);
            if (hr != 0)
            {
                LastError = $"CoCreateInstance(MMDeviceEnumerator) hr=0x{hr:X8}";
                return null;
            }
            var enumerator = (IMMDeviceEnumerator)enumeratorObj;
            int hrEnum = enumerator.GetDefaultAudioEndpoint(DataFlowRender, RoleMultimedia, out IMMDevice device);
            if (hrEnum != 0 || device is null)
            {
                LastError = $"GetDefaultAudioEndpoint hr=0x{hrEnum:X8}";
                return null;
            }
            var iidVol = IidAudioEndpointVolume;
            int hr2 = device.Activate(ref iidVol, ClsCtxAll, IntPtr.Zero, out object volObj);
            if (hr2 != 0)
            {
                LastError = $"Activate(IAudioEndpointVolume) hr=0x{hr2:X8}";
                return null;
            }
            _cached = (IAudioEndpointVolume)volObj;
            _cachedAt = DateTime.UtcNow;
            return _cached;
        }
        catch (Exception e)
        {
            LastError = $"{e.GetType().Name}: {e.Message}";
            return null;
        }
    }

    /// <summary>
    /// 读系统主音量，返回 0..100 的整数；拿不到返回 null。
    /// 界面上拿不到就该隐藏音量入口，不许显示一个假的 0。
    /// </summary>
    public static int? GetPercent()
    {
        var vol = TryGetEndpointVolume();
        if (vol is null) return null;
        try
        {
            int hr = vol.GetMasterVolumeLevelScalar(out float scalar);
            // 注意：**S_FALSE(1) 也算成功** —— 不能只认 hr == 0
            if (hr < 0) return null;
            double p = Math.Round(scalar * 100.0);
            if (p < 0) p = 0;
            if (p > 100) p = 100;
            return (int)p;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 设系统主音量（0..100）。
    /// 返回 false = 没设备 / 设不进去（调用方据此隐藏音量入口）。
    /// </summary>
    public static bool SetPercent(int percent)
    {
        LastError = "";
        if (percent < 0) percent = 0;
        if (percent > 100) percent = 100;
        var vol = TryGetEndpointVolume();
        if (vol is null) return false;
        try
        {
            int hr = vol.SetMasterVolumeLevelScalar(percent / 100.0f, Guid.Empty);
            // ⚠ **不能只信 HRESULT**：实测这台机器上它返回
            //   ERROR_NOT_FOUND(0x80070490)，**但音量确实改了**（读回就是目标值）。
            //   所以判定改成「设完再读回来比对」—— 以事实为准，不以返回码为准。
            var after = GetPercent();
            if (after.HasValue && Math.Abs(after.Value - percent) <= 1) return true;
            LastError = $"SetMasterVolumeLevelScalar hr=0x{hr:X8}，读回={after?.ToString() ?? "null"} 目标={percent}";
            return false;
        }
        catch (Exception e)
        {
            LastError = $"{e.GetType().Name}: {e.Message}";
            return false;
        }
    }

    /// <summary>这台机器上到底能不能用音量（给界面决定显不显示入口）</summary>
    public static bool IsAvailable() => TryGetEndpointVolume() is not null;

    // ---- 通知：外部（键盘音量键 / 别的程序）改了音量时要跟手 ----
    //
    // 机制：IAudioEndpointVolume 的实现带一个 COM 连接点（IConnectionPoint），
    // 注册一个 IAudioEndpointVolumeCallback 进去，音量一变就回调。
    // **不轮询** —— 轮询只能做到"最多差 500ms"，而且一直在烧 CPU。
    //
    // 回调接口的 IID 与签名是手写的（SDK 里没有托管封装）：
    //   IAudioEndpointVolumeCallback
    //     OnVolumeLevelChanged / OnDeviceStateChanged / OnPropertyValueChanged
    // 注册失败（GUID 不对、接口不存在）时返回 false，
    // 由调用方降级成轮询 —— 功能不因为这个挂掉。

    private static readonly Guid IidConnectionPoint = new("B196B286-BAB4-101A-B69C-00AA00341D07");
    private static readonly Guid IidConnectionPointContainer = new("B196B284-BAB4-101A-B69C-00AA00341D07");
    private static readonly Guid IidAudioEndpointVolumeCallback = new("65E1D560-91EF-4544-98AC-6D0E70A1D7D9");

    [ComImport]
    [Guid("B196B286-BAB4-101A-B69C-00AA00341D07")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IConnectionPoint
    {
        [PreserveSig] int Advise([MarshalAs(UnmanagedType.IUnknown)] object pUnk, out uint pdwCookie);
        [PreserveSig] int Unadvise(uint dwCookie);
        [PreserveSig] int GetConnectionPoint(IntPtr pIID);
    }

    [ComImport]
    [Guid("65E1D560-91EF-4544-98AC-6D0E70A1D7D9")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolumeCallback
    {
        [PreserveSig] int OnVolumeLevelChanged(IntPtr notificationData);
        [PreserveSig] int OnDeviceStateChanged(IntPtr notificationData, [MarshalAs(UnmanagedType.LPWStr)] string sessionGuid);
        [PreserveSig] int OnPropertyValueChanged(IntPtr notificationData, [MarshalAs(UnmanagedType.LPWStr)] string sessionGuid, IntPtr propertyKey);
    }

    /// <summary>
    /// COM 回调对象。要 **ComVisible**，原生那边才能通过 IUnknown 拿到它。
    /// 回调里只做一件事：把"音量可能变了"这个信号抛出去，读值交给调用方。
    /// </summary>
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    private sealed class VolumeCallback : IAudioEndpointVolumeCallback
    {
        public Action? Changed;

        [PreserveSig]
        public int OnVolumeLevelChanged(IntPtr notificationData)
        {
            Changed?.Invoke();
            return 0;
        }

        [PreserveSig]
        public int OnDeviceStateChanged(IntPtr notificationData, string sessionGuid)
        {
            Changed?.Invoke();
            return 0;
        }

        [PreserveSig]
        public int OnPropertyValueChanged(IntPtr notificationData, string sessionGuid, IntPtr propertyKey)
        {
            Changed?.Invoke();
            return 0;
        }
    }

    // 回调对象必须活着：GC 收走了，原生那边再回调就是访问已释放对象
    private static VolumeCallback? _callback;
    private static IConnectionPoint? _connectionPoint;
    private static uint _cookie;

    /// <summary>
    /// 开始监听音量变化。返回 false = 这个接口注册不上（调用方降级成轮询）。
    /// </summary>
    [ComImport]
    [Guid("B196B284-BAB4-101A-B69C-00AA00341D07")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IConnectionPointContainer
    {
        [PreserveSig] int EnumConnectionPoints(IntPtr ppEnum);
        [PreserveSig] int FindConnectionPoint(ref Guid iid, out IConnectionPoint ppCP);
        [PreserveSig] int GetConnectionPoint(ref Guid iid, out IntPtr ppCP);
    }

    /// <summary>
    /// 原生的 QueryInterface。
    ///
    /// 为什么不用 Marshal.QueryInterface：**.NET 的 RCW 只暴露「声明过」的接口**，
    /// 对 ComImport 接口做 QI(IConnectionPoint) 会直接 E_NOINTERFACE。
    /// 所以这里手工取 vtable 的第 0 个槽（QueryInterface）直接调原生实现。
    /// </summary>
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int QueryInterfaceFn(IntPtr self, ref Guid iid, out IntPtr ppv);

    private static int NativeQueryInterface(IntPtr unk, ref Guid iid, out IntPtr ppv)
    {
        IntPtr vtbl = Marshal.ReadIntPtr(unk);
        if (vtbl == IntPtr.Zero)
        {
            ppv = IntPtr.Zero;
            return unchecked((int)0x80004005); // E_FAIL
        }
        IntPtr fnPtr = Marshal.ReadIntPtr(vtbl); // slot 0 = QueryInterface
        var fn = Marshal.GetDelegateForFunctionPointer<QueryInterfaceFn>(fnPtr);
        return fn(unk, ref iid, out ppv);
    }

    public static bool TryStartNotification(Action onChanged)
    {
        LastError = "";
        try
        {
            var vol = TryGetEndpointVolume();
            if (vol is null) return false;

            var iid = IidConnectionPoint;
            IntPtr unk = Marshal.GetIUnknownForObject(vol);
            try
            {
                int hr = NativeQueryInterface(unk, ref iid, out IntPtr cpPtr);
                if (hr != 0)
                {
                    // 再退一步试试 IConnectionPointContainer::FindConnectionPoint
                    var iidContainer = IidConnectionPointContainer;
                    int hrC = NativeQueryInterface(unk, ref iidContainer, out IntPtr containerPtr);
                    if (hrC == 0)
                    {
                        try
                        {
                            var container = (IConnectionPointContainer)Marshal.GetObjectForIUnknown(containerPtr);
                            var iidCb = IidAudioEndpointVolumeCallback;
                            int hrF = container.FindConnectionPoint(ref iidCb, out IConnectionPoint cpFound);
                            if (hrF == 0)
                            {
                                var cbTmp = new VolumeCallback { Changed = onChanged };
                                int hrA = cpFound.Advise(cbTmp, out uint cookieTmp);
                                if (hrA == 0)
                                {
                                    _callback = cbTmp;
                                    _connectionPoint = cpFound;
                                    _cookie = cookieTmp;
                                    return true;
                                }
                                LastError = $"FindConnectionPoint→Advise hr=0x{hrA:X8}";
                                return false;
                            }
                            LastError = $"FindConnectionPoint hr=0x{hrF:X8}";
                            return false;
                        }
                        finally
                        {
                            Marshal.Release(containerPtr);
                        }
                    }
                    LastError = $"QueryInterface(IConnectionPoint) hr=0x{hr:X8}；QI(IConnectionPointContainer) hr=0x{hrC:X8}";
                    return false;
                }
                try
                {
                    var cp = (IConnectionPoint)Marshal.GetObjectForIUnknown(cpPtr);
                    var cb = new VolumeCallback { Changed = onChanged };
                    int hr2 = cp.Advise(cb, out uint cookie);
                    if (hr2 != 0)
                    {
                        LastError = $"Advise(IAudioEndpointVolumeCallback) hr=0x{hr2:X8}";
                        return false;
                    }
                    _callback = cb;
                    _connectionPoint = cp;
                    _cookie = cookie;
                    return true;
                }
                finally
                {
                    Marshal.Release(cpPtr);
                }
            }
            finally
            {
                Marshal.Release(unk);
            }
        }
        catch (Exception e)
        {
            LastError = $"{e.GetType().Name}: {e.Message}";
            return false;
        }
    }

    /// <summary>停掉监听（收尾时用）</summary>
    public static void StopNotification()
    {
        try
        {
            if (_connectionPoint is not null && _cookie != 0) _connectionPoint.Unadvise(_cookie);
        }
        catch
        {
            /* 已经断了就算了 */
        }
        _callback = null;
        _connectionPoint = null;
        _cookie = 0;
    }
}
