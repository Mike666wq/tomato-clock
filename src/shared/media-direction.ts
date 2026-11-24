// 媒体"真实播放方向"的判定（2026-11-24，v0.3.7）。
//
// 为什么单独抽出来：
//   界面上那个播放/暂停按钮，画哪个图标、发哪条命令，全看这个判定。
//   以前这段逻辑散在 Island.tsx 里，**没法写单测** ——
//   于是"图标方向对不对"只能靠肉眼（用户一看就说"图标不对"）。
//   抽成纯函数以后，每一条分支都能断言。
//
// 核心事实（决定判定规则）：
//   Windows 上读"现在在放什么歌"只有 SMTC 一个官方口子，它时好时坏
//   （QQ 音乐新版内核根本不注册会话）。读不到歌名是常态。
//   但"这个进程现在有没有真的在出声"是**系统级事实**，读音频会话就有。

import type { MediaSnapshot } from './types'

/**
 * 真实播放方向。
 *
 * - `true`  = 正在出声（该显示"暂停"图标，点了会暂停）
 * - `false` = 暂停中（该显示"播放"图标，点了会播放）
 * - `null`  = **不知道**（该显示两态图标，点了发切换命令 —— 不猜方向）
 */
export type PlayingDirection = boolean | null

/**
 * 从媒体快照算"真实播放方向"。
 *
 * 优先级（**不能改**）：
 *   1. 歌名来自 **SMTC** → 以 SMTC 的 `playing` 为准。
 *      理由：SMTC 是唯一能同时给出歌名和播放状态的源，它在的时候它最权威。
 *   2. 歌名来自**窗口标题**（SMTC 读不到时的兜底）→ 用**音频会话**的 `audioPlaying`。
 *      理由：那种情况下 SMTC 的 playing 根本没读出来（是空的），
 *      拿它当方向会**永远是"暂停"** —— 那是错的。
 *   3. 都读不到 → `null` = 不知道。
 *
 * ⚠ **第 2 条是关键**（2026-11-24 实测踩到）：
 *   以前这里只看"有没有会话"，而窗口标题兜底也会让 hasSession 变 true
 *   —— 于是方向去读了 SMTC 的 playing（空的 → false），
 *   界面永远显示"暂停"。歌名有了、方向却错了。
 *
 * ⚠ **第 3 条也是关键**：以前把"读不到"当成"暂停"（false），
 *   界面上就永远显示一个**猜的**方向 —— 用户看到的就是"图标不对"。
 *   现在不知道就说不知道，界面显示两态图标，点了发切换命令。
 */
export function playingDirection(media: MediaSnapshot | null): PlayingDirection {
  if (!media) return null
  if (media.titleSource === 'smtc') return media.playing
  return media.audioPlaying
}

/**
 * 这个播放方向**可不可信**（会不会滞后）。
 *
 * `true` = 实时（峰值判出来的，实测 1~2 秒内反转）
 * `false` = 可能滞后（退回会话 Active 状态，实测暂停方向要 23.5 秒）
 * `null`  = 根本不知道方向
 *
 * 为什么要有它：界面在用一个"慢"的信号时应该知道这件事，
 * 比如命令发出去以后**不要立刻判失败**（那是误判，不是事实）。
 */
export function directionIsLive(media: MediaSnapshot | null): boolean | null {
  if (!media) return null
  const direction = playingDirection(media)
  if (direction === null) return null
  // 歌名来自 SMTC → SMTC 的状态是实时的
  if (media.titleSource === 'smtc') return true
  return media.audioPeakKnown
}

/**
 * 按真实方向，该发哪条媒体命令。
 *
 * - 知道在放 → `pause`（点了要停）
 * - 知道暂停 → `play`（点了要放）
 * - 不知道 → `toggle`（让 Windows 自己判断）
 *
 * ⚠ 为什么"不知道"要发 toggle 而不是随便挑一个：
 *   媒体键（VK_MEDIA_PLAY_PAUSE）本来就是**切换**语义，
 *   猜方向会把状态弄反（"点暂停把音乐点成播放"）。
 */
export function mediaCommandFor(direction: PlayingDirection): 'play' | 'pause' | 'toggle' {
  if (direction === null) return 'toggle'
  return direction ? 'pause' : 'play'
}

/**
 * 按真实方向，该显示哪个图标（'pause' | 'play' | 'both'）。
 *
 * 'both' = 两态图标（不知道方向时用）。
 */
export function playPauseIconFor(direction: PlayingDirection): 'pause' | 'play' | 'both' {
  if (direction === null) return 'both'
  return direction ? 'pause' : 'play'
}
