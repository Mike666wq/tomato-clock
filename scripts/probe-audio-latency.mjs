// 量一件事：**音频会话状态在"按媒体键"之后多久才变**。
//
// 背景（2026-11-24 下午）：
//   0.3.7 真机验证里有一条 FAIL —— 真机点「暂停」后，
//   独立进程读到的音频会话状态在 7.5 秒内**一直是 active**，
//   但脚本跑完之后再读，又变成了 inactive。
//   两种可能：
//     a) 点击没生效（晚点才生效）
//     b) 会话状态**本来就有延迟**，不是实时的
//   这两者对产品的含义完全不同，必须量出来。
//
// 用法：node scripts\probe-audio-latency.mjs
//
// ⚠ 会用媒体键切换用户的播放状态，**测完恢复原状**。

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const SMTC_EXE = path.join(process.cwd(), 'tools', 'smtc', 'publish', 'smtc.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 独立进程读音频会话的真实状态 */
function audioState() {
  try {
    const out = execFileSync(SMTC_EXE, ['audio'], { encoding: 'utf-8', timeout: 15000 })
    const lines = out.trim().split('\n').filter(Boolean)
    for (const line of lines.reverse()) {
      const parsed = JSON.parse(line)
      if (parsed.kind === 'audioPlayer') {
        return {
          playing: parsed.playing === null ? null : Boolean(parsed.playing),
          process: String(parsed.process ?? ''),
          error: String(parsed.error ?? '')
        }
      }
    }
    return null
  } catch (err) {
    return { playing: null, process: '', error: String(err.message ?? err) }
  }
}

/** 发一次媒体键（用 helper 的 pause 命令 = VK_MEDIA_PLAY_PAUSE 切换） */
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

const before = audioState()
console.log(`[${stamp()}] 按之前：${JSON.stringify(before)}`)

if (!before || before.playing === null) {
  console.log('\nNO_AUDIO_STATE —— 读不到音频会话，先让 QQ 音乐放起来再跑。\n')
  process.exit(2)
}

const wasPlaying = before.playing
console.log(`[${stamp()}] 发媒体键（切换）…`)
sendToggle()

// 每 300ms 读一次，直到状态反转或超时
let flippedAt = null
for (let i = 0; i < 100; i++) {
  await sleep(300)
  const s = audioState()
  const playing = s?.playing ?? null
  if (playing !== null && playing !== wasPlaying) {
    flippedAt = (Date.now() - t0) / 1000
    console.log(`[${stamp()}] 状态反转：playing ${wasPlaying} → ${playing}（耗时 ${flippedAt.toFixed(2)}s）`)
    break
  }
  if (i % 5 === 0) console.log(`[${stamp()}] 还是 playing=${playing}`)
}

if (flippedAt === null) {
  console.log(`[${stamp()}] 30 秒内状态没反转（最后读到 playing=${audioState()?.playing}）`)
}

// 收尾：恢复原状
const now = audioState()
if (now && now.playing !== null && now.playing !== wasPlaying) {
  console.log(`[${stamp()}] 收尾：恢复成 playing=${wasPlaying}`)
  sendToggle()
  await sleep(1500)
  console.log(`[${stamp()}] 恢复后：playing=${audioState()?.playing}`)
}
