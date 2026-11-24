// 量一件事：**媒体键"暂停"方向的会话状态延迟**（2026-11-24 下午）。
//
// 背景：
//   真机验证里「点一下 → 状态反转」这条 FAIL 了 —— 轮询 10 多秒一直是 active，
//   但脚本结束后再读却是 inactive。
//   而另一个方向（暂停→播放）实测只要 1.17 秒。
//   两个方向差这么多，必须单独量清楚：
//     - 是不是 QQ 音乐暂停时**仍然保持音频会话 Active**（流没关，只是不出声）？
//     - 还是暂停方向就是慢？
//
// 用法：node scripts\probe-pause-latency.mjs
//
// ⚠ 会切换用户的播放状态，测完恢复原状。

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function audioState() {
  try {
    const out = execFileSync(SMTC_EXE, ['audio'], { encoding: 'utf-8', timeout: 15000 })
    let peak = null
    let playing = null
    for (const line of out.trim().split('\n').filter(Boolean).reverse()) {
      const parsed = JSON.parse(line)
      if (parsed.kind === 'audioSession' && parsed.peak !== null && parsed.peak !== undefined) {
        peak = Number(parsed.peak)
      }
      if (parsed.kind === 'audioPlayer') {
        playing = parsed.playing === null ? null : Boolean(parsed.playing)
      }
    }
    return { playing, peak }
  } catch {
    return { playing: null, peak: null }
  }
}

function sendToggle() {
  try {
    execFileSync(SMTC_EXE, ['pause'], { encoding: 'utf-8', timeout: 15000 })
    return true
  } catch {
    return false
  }
}

const t0 = Date.now()
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'

let before = audioState()
console.log(`[${stamp()}] 起始 playing=${before}`)

// 先确保是"在放"状态（要量的是播放→暂停这个方向）
if (before === false) {
  console.log(`[${stamp()}] 先切到"在放"…`)
  sendToggle()
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    before = audioState()
    if (before === true) break
  }
  console.log(`[${stamp()}] 现在 playing=${before}`)
}
if (before !== true) {
  console.log('\nCANNOT_START —— 没切到"在放"状态，先让 QQ 音乐放起来再跑。\n')
  process.exit(2)
}

console.log(`[${stamp()}] 发媒体键（播放→暂停）…`)
sendToggle()

let flipAt = null
for (let i = 0; i < 200; i++) {
  await sleep(300)
  const s = audioState()
  if (s === false) {
    flipAt = (Date.now() - t0) / 1000
    console.log(`[${stamp()}] 反转成 paused，耗时 ${flipAt.toFixed(2)}s`)
    break
  }
  if (i % 10 === 0) console.log(`[${stamp()}] 还在 playing=${s}`)
}
if (flipAt === null) {
  console.log(`[${stamp()}] 60 秒内没反转（最后 playing=${audioState()}）`)
}

// 收尾：恢复成"在放"
const now = audioState()
if (now === false) {
  console.log(`[${stamp()}] 收尾：恢复成在放`)
  sendToggle()
  await sleep(2000)
  console.log(`[${stamp()}] 恢复后 playing=${audioState()}`)
}
