// 量一件事：**峰值（真的在出声）在媒体键之后的反转延迟**（2026-11-24 下午）。
//
// 为什么量这个：
//   音频会话的 **Active 状态**实测滞后 —— 暂停方向要 23.5 秒才变（播放方向 1.1 秒）。
//   也就是说用状态判"在不在放"，图标会滞后二十多秒。
//   而**峰值**（peak）是"这一刻真的有没有声音"，应该立刻变。
//   这个量出来才敢把它当判据。
//
// 用法：node scripts\probe-peak-latency.mjs
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
const stamp = () => ((Date.now() - t0) / 1000).toFixed(2) + 's'

let st = audioState()
console.log(`[${stamp()}] 起始 playing=${st.playing} peak=${st.peak}`)

// 方向 1：在放 → 暂停（看峰值多久掉到 0）
if (st.playing === true) {
  console.log(`[${stamp()}] 发媒体键（播放→暂停）…`)
  sendToggle()
  let flipAt = null
  for (let i = 0; i < 60; i++) {
    await sleep(150)
    st = audioState()
    if (st.peak !== null && st.peak <= 0.002) {
      flipAt = (Date.now() - t0) / 1000
      console.log(`[${stamp()}] 峰值掉到 0（静音了），耗时 ${flipAt.toFixed(2)}s`)
      break
    }
    if (i % 10 === 0) console.log(`[${stamp()}] 还在 peak=${st.peak} playing=${st.playing}`)
  }
  if (flipAt === null) console.log(`[${stamp()}] 9 秒内峰值没掉（peak=${st.peak}）`)
} else {
  console.log('[跳过] 现在不是"在放"，先切过去')
}

// 方向 2：暂停 → 播放（看峰值多久升起来）
st = audioState()
if (st.playing === false) {
  console.log(`[${stamp()}] 发媒体键（暂停→播放）…`)
  const t1 = Date.now()
  sendToggle()
  let upAt = null
  for (let i = 0; i < 60; i++) {
    await sleep(150)
    st = audioState()
    if (st.peak !== null && st.peak > 0.002) {
      upAt = (Date.now() - t1) / 1000
      console.log(`[${stamp()}] 峰值起来了（出声了），耗时 ${upAt.toFixed(2)}s，peak=${st.peak}`)
      break
    }
    if (i % 10 === 0) console.log(`[${stamp()}] 还在 peak=${st.peak}`)
  }
  if (upAt === null) console.log(`[${stamp()}] 9 秒内峰值没起来（peak=${st.peak}）`)
}

// 收尾：恢复成"在放"
st = audioState()
if (st.playing === false) {
  console.log(`[${stamp()}] 收尾：恢复成在放`)
  sendToggle()
  await sleep(2000)
  console.log(`[${stamp()}] 恢复后 playing=${audioState().playing} peak=${audioState().peak}`)
}
