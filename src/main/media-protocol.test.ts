// helper 与主进程之间的**协议一致性**（2026-11-24 加，v0.3.7）。
//
// 为什么要有这个测试：
//   踩过一次 —— helper 发 `titleSource: "window-title"`，
//   主进程认的是 `"window"`，两边对不上。
//   **现象上看不出来**：歌名照常显示、方向也大体对，
//   只是这一栏永远是空的，方向逻辑悄悄走错分支。
//
//   这种错只能靠"两边用同一个词"来防，
//   而"同一个词"必须由测试来保证 —— 人记不住。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const helperSrc = readFileSync(
  path.resolve(__dirname, '../../tools/smtc/Program.cs'),
  'utf-8'
)
const mediaSrc = readFileSync(path.resolve(__dirname, '../main/media.ts'), 'utf-8')

describe('helper 与主进程的字段名对得上', () => {
  it('titleSource：helper 发的值，主进程都认', () => {
    // helper 发出去的字面量：C# 里是 ["titleSource"] = ...,
    const sent = [
      ...helperSrc.matchAll(/\[\s*"titleSource"\s*\]\s*=\s*([^,\n]+),/g)
    ].map((m) => m[1])
    expect(sent.length).toBeGreaterThan(0)

    // 主进程认的值
    const accepted = [...mediaSrc.matchAll(/titleSourceRaw === '([^']+)'/g)].map((m) => m[1])

    // helper 里出现的字面量（单引号 C# 或双引号都算）
    const helperValues = new Set<string>()
    for (const expr of sent) {
      for (const m of expr.matchAll(/'([^']+)'/g)) helperValues.add(m[1])
      for (const m of expr.matchAll(/"([^"]+)"/g)) helperValues.add(m[1])
    }
    expect(helperValues.size).toBeGreaterThan(0)
    for (const v of helperValues) {
      expect(accepted, `主进程不认 helper 发的 titleSource="${v}"`).toContain(v)
    }
  })

  it('主进程读的字段名，helper 确实发了', () => {
    // 主进程从 state 行里读的字段
    const readFields = new Set(
      [...mediaSrc.matchAll(/parsed\['([a-zA-Z]+)'\]/g)].map((m) => m[1])
    )
    // helper 的 state 行里发的字段
    const sentFields = new Set(
      [...helperSrc.matchAll(/\["([a-zA-Z]+)"\]\s*=/g)].map((m) => m[1])
    )
    // 这几个是主进程自己解析的其它 kind（volume/ack），不在 state 行里
    const otherKinds = new Set(['volume', 'ack', 'kind', 'command', 'ok', 'value', 'error', 'changed', 'mode'])
    for (const f of readFields) {
      if (otherKinds.has(f)) continue
      expect(sentFields.has(f), `主进程读 parsed['${f}']，但 helper 的 state 行里没有这个字段`).toBe(
        true
      )
    }
  })
})
