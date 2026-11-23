# v0.5 UI 静态稿：怎么出图、怎么拍

日期：2026-11-23
执行：小M
方案：`docs/v0.5-UI重做稿.md`（肥鱼）

**这一轮只出静态稿，不改真代码。** 挑完版再动产品代码。

## 一、稿子文件

| 文件 | 内容 |
|---|---|
| `docs/mockups/mock-a.html` | A 版·极简（主界面 + 统计页） |
| `docs/mockups/mock-b.html` | B 版·质感（主界面 + 统计页） |

两个文件结构一样，用查询串切换：

```
?screen=main|stats   切主界面 / 统计页
?theme=dark|light    切深色 / 浅色
?size=small          切最小窗口 420×560
```

## 二、颜色从哪来（重要）

- **深色底直接链的是真的 `src/renderer/styles/tokens.css`**（`<link rel="stylesheet">`），
  所以稿子里的颜色没有一个是我自己编的。
- **浅色底和 `--ink-3` 是稿子本地补的**（写在稿子自己的 `<style>` 里，`html[data-theme='light']`）。
  tokens.css 目前只有深色一套，也没有 `--ink-3`。
  **真要采纳这一版，这两块得先并进 tokens.css**——那才是"颜色只从 tokens.css 取"的正解。
- 图标全是手写内联 SVG（16/18/20 三个尺寸），没引图标库。

## 三、怎么拍照

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 这台机器预置了它
node_modules\.bin\electron.cmd scripts\shot-mockup.mjs <html> <out.png> [宽] [高] [查询串]
```

例：

```powershell
node_modules\.bin\electron.cmd scripts\shot-mockup.mjs docs\mockups\mock-a.html docs\shots\v05-A-主界面-深色.png 560 700 "screen=main,theme=dark"
```

`scripts/shot-mockup.mjs` 是新加的开发期工具：起一个无边框 electron 窗口加载稿子，
`capturePage()` 抓一张图存盘，然后退出。

**为什么不用浏览器**：项目里已经装了 electron，不用再引 puppeteer/playwright；
`capturePage` 出来的图尺寸与 DPI 都准，不会像 `PrintWindow` 那样按 DPI 放大后被裁掉。

**两个踩过的坑**：

1. 查询串用**逗号**分隔，不用 `&`——`&` 在 `.cmd` 里会被 cmd 拆开，
   报 "operable program or batch file"。
2. 这台机器预置了 `ELECTRON_RUN_AS_NODE=1`，不清掉 electron 会退化成纯 Node，
   报 "bad option"。`scripts/dev.mjs` 里也清同一件事。

## 四、出图清单（10 张）

| 文件 | 版 | 页面 | 配色/尺寸 |
|---|---|---|---|
| `v05-A-主界面-深色.png` | A | 主界面 | 深色 480×620 |
| `v05-A-主界面-浅色.png` | A | 主界面 | 浅色 480×620 |
| `v05-A-主界面-420x560.png` | A | 主界面 | 深色 最小窗口 |
| `v05-A-统计页-深色.png` | A | 统计页 | 深色 480×620 |
| `v05-A-统计页-浅色.png` | A | 统计页 | 浅色 480×620 |
| `v05-B-主界面-深色.png` | B | 主界面 | 深色 480×620 |
| `v05-B-主界面-浅色.png` | B | 主界面 | 浅色 480×620 |
| `v05-B-主界面-420x560.png` | B | 主界面 | 深色 最小窗口 |
| `v05-B-统计页-深色.png` | B | 统计页 | 深色 480×620 |
| `v05-B-统计页-浅色.png` | B | 统计页 | 浅色 480×620 |

## 五、跟方案的出入（两点，都要拍板）

1. **环直径**：方案里 A 版 ≈320、B 版 ≈340。我把两版都取成
   `min(宽-112, 高×0.52)`，在 480×620 下都是 322。
   原因：420×560 时固定 340 会**压叠**（硬要求第 2 条），按公式缩到 291 才塞得下。
   实现时两版共用同一条缩放公式，跟现在 `Timer.tsx` 里的算法一致。
2. **画板尺寸**：稿子是 480×620，但方案里画的是 620 高。我按 620 出的图
   （现在这个窗口默认 480×580，620 是给"以后能拖大"留的余量）。

## 六、没做的

- **灵动岛没出稿**：方案说"结构不动，只把圆角/颜色跟新版对齐"，
  那属于实现阶段（改 tokens 就够了），不是设计选择。
- **没做交互和动画**：抽屉滑出、阶段切换的交叉淡入都只是方案里的文字，
  这轮不出稿。
