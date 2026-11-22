# 番茄钟

> 一个自用的 Windows 桌面番茄钟。计时时是一条贴着屏幕顶端的悬浮胶囊（灵动岛式），不占任务栏、不抢焦点。

不是商业产品，只给自己用。做它的理由写在 [`research/`](research/) 里：市面上番茄钟功能已经饱和，但**PC 桌面端是真空**，而且主流产品的统计回答不了"我的时间去哪了"。

---

## 功能

**计时**
- 专注 / 短休 / 长休自动流转，25/5/15 默认，每 4 轮进长休
- 计时状态在主进程，**关掉窗口计时照样走**
- 到点三件套：窗口置顶切前台 + 自带提示音 + 系统通知（Windows 通知会被专注助手吞掉，所以不只靠通知）
- 每段结束记一行：任务名 + 是否被打断，回车提交，60 秒无人响应自动落一条

**灵动岛**
- 贴着屏幕顶端居中，上沿直角、下沿半圆，鼠标悬停展开
- 收起态单击 = 开始/暂停；展开态两层：第一层是计时和当前值，点胶囊才展开选项
- 右键菜单：打开主界面 / 设置 / 隐藏 / 退出

**模板与主题**
- 计时模板：经典 25/5、深度 50/10、冲刺 15/3、考试 45/10，可自建
- 主题相当于"项目分类"，每个番茄挂一个，不选就是"未分类"
- 统计：今日分布、近 7 天趋势、打断原因排行、**各主题时间占比 + 打断率**

**其他**
- 数据全在本机 JSON，零账号零云；CSV 导出（UTF-8 BOM，Excel 不乱码）
- 音乐控制（可选，默认关）：读 Windows SMTC，显示歌名 + 播放/暂停/切歌

---

## 下载

不本地打包，构建都在 GitHub Actions 上跑：

- **打标签的版本** → 到 [Releases](../../releases) 下载 `.exe`
- **每次推到 master** → 到 [Actions](../../actions) 里那次运行的 Artifacts 下载（需登录 GitHub）

产物三个：`番茄钟 Setup x.y.z.exe`（安装版）、`番茄钟 x.y.z.exe`（免安装单文件）、`-免安装.zip`。

---

## 本地开发

需要 Node 24、pnpm 11；音乐控制那部分另需要 .NET 8 SDK。

```bash
pnpm install
pnpm dev        # 开发模式跑起来（脚本里会清掉 ELECTRON_RUN_AS_NODE）
pnpm typecheck  # 类型检查
pnpm dist       # 打包：先编 smtc.exe，再 electron-builder 出安装包和免安装版
```

没装 .NET SDK 也能打包——`scripts/prepare-smtc.mjs` 发布失败只留空目录，主进程找不到 `smtc.exe` 会静默关掉音乐功能，其他照常。

---

## 数据在哪

| 东西 | 位置 |
|---|---|
| 记录、设置、主题、模板 | `%APPDATA%\pomodoro\data.json` |
| 日志 | `%APPDATA%\pomodoro\app.log` |
| 卸载重装 | 数据不丢（在 userData，不在安装目录） |
| 备份 | 直接复制 `data.json` |

---

## 目录

```
src/
  main/       主进程：窗口、托盘、快捷键、计时状态机、存储
  preload/    两个独立 preload（主窗口 / 灵动岛，各给最小权限）
  renderer/   界面，颜色全在 styles/tokens.css
  shared/     主进程与界面共用的类型
tools/smtc/   C# 媒体控制小工具（.NET 8 + WinRT 投影）
docs/         方案、验证方法、使用说明、三天自用清单
research/     立项前的市场调研（四份）
scripts/      dev 启动、smtc 发布、CDP 截图与断言
```

---

## 几个已知的坑（都实测过，写在 `docs/验证方法.md`）

- **真亚克力毛玻璃做不了**：材质铺满窗口矩形，`setShape` 只裁内容不裁材质，DWM 圆角固定 8px 不可控。所以是半透明 + 噪点 + 1px 高光做的伪毛玻璃。
- **`resizable:false` 在 Windows 上连程序化 `setSize` 都禁掉**，改用 `resizable:true` + `will-resize` 拦用户拖拽。
- **不能用带投影的 PowerShell 读 SMTC**：PS 的 WinRT 投影不完整，会话是空壳。必须用 .NET 8 的 `net8.0-windows10.0.19041.0`。
