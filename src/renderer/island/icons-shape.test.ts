// 灵动岛图标组件的**结构**约束（2026-11-24 加，v0.3.7）。
//
// 为什么要有这个测试：
//   1. **图标形状**：上一首/下一首的竖条位置画反过（渲染成"◀◀|"），
//      用户一眼就看出来了。这里锁住几何数据。
//   2. **合并图标**：播放/暂停曾经是三个独立组件，状态一变就换掉整个
//      `<svg>` 节点 —— 而按钮正好在鼠标底下，
//      浏览器把"光标下的元素被删"报成 mouseout → **岛当场自己收起**。
//      所以这三个形态必须由**同一个组件、同一个 svg 节点**渲染。
//
// 这些是"看得见摸得着"的界面契约，写成断言才不会以后又画错。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const iconsSrc = readFileSync(
  path.resolve(__dirname, 'Icons.tsx'),
  'utf-8'
)
const islandSrc = readFileSync(
  path.resolve(__dirname, 'Island.tsx'),
  'utf-8'
)

describe('上一首 / 下一首的形状', () => {
  it('上一首：竖条在左（x 最小），两个三角朝左', () => {
    const m = iconsSrc.match(/export function PrevIcon[\s\S]*?\n}/)
    expect(m).not.toBeNull()
    const src = m![0]
    // 竖条在 x=2（viewBox 0..14 里最左边）
    expect(src).toMatch(/<rect x="2"/)
    // 两个三角：d 里第一个数 > 第三个数 → 尖端朝左
    const ds = [...src.matchAll(/d="([^"]+)"/g)].map((x) => x[1])
    expect(ds).toHaveLength(2)
    for (const d of ds) {
      const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number)
      expect(nums[0]).toBeGreaterThan(nums[2])
    }
  })

  it('下一首：竖条在右（x 最大），两个三角朝右', () => {
    const m = iconsSrc.match(/export function NextIcon[\s\S]*?\n}/)
    expect(m).not.toBeNull()
    const src = m![0]
    expect(src).toMatch(/<rect x="10\.4"/)
    const ds = [...src.matchAll(/d="([^"]+)"/g)].map((x) => x[1])
    expect(ds).toHaveLength(2)
    for (const d of ds) {
      const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number)
      expect(nums[0]).toBeLessThan(nums[2])
    }
  })

  it('上一首和下一首的竖条位置相反（不是镜像画错）', () => {
    const prev = iconsSrc.match(/export function PrevIcon[\s\S]*?\n}/)![0]
    const next = iconsSrc.match(/export function NextIcon[\s\S]*?\n}/)![0]
    const prevX = Number(prev.match(/<rect x="([\d.]+)"/)![1])
    const nextX = Number(next.match(/<rect x="([\d.]+)"/)![1])
    expect(prevX).toBeLessThan(nextX)
  })
})

describe('播放/暂停图标：必须是合并的一个 svg', () => {
  /** 取某个导出组件的**整个函数体**（到下一个顶层 `export` 之前） */
  function componentBody(name: string): string {
    const start = iconsSrc.indexOf(`export function ${name}`)
    expect(start).toBeGreaterThan(-1)
    const rest = iconsSrc.slice(start + 1)
    const next = rest.search(/\nexport (function|const)/)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('有 PlayPauseGlyph 这一个组件，三种形态都在它里面', () => {
    const src = componentBody('PlayPauseGlyph')
    // 三种形态：play 一个三角 / pause 两个竖条 / both 三角+竖条
    expect(src).toContain("kind === 'play'")
    expect(src).toContain("kind === 'pause'")
    // **只有一个 <svg>**：形态之间只换里面的内容，不换节点
    expect((src.match(/<svg/g) || []).length).toBe(1)
  })

  it('Island 用的是合并图标，不是三个独立组件', () => {
    expect(islandSrc).toContain('PlayPauseGlyph')
    // 不许再直接用独立的 PlayIcon / PauseIcon 画这个按钮
    const m = islandSrc.match(/aria-label=\{[\s\S]{0,400}?PlayPause/)
    expect(m).not.toBeNull()
    expect(m![0]).not.toMatch(/<PlayIcon/)
    expect(m![0]).not.toMatch(/<PauseIcon/)
    expect(m![0]).not.toMatch(/<PlayPauseIcon/)
  })

  it('旧的独立两态图标组件已被移除（避免以后又拆回去）', () => {
    expect(iconsSrc).not.toContain('export function PlayPauseIcon')
  })
})
