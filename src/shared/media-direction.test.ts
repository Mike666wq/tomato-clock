// 媒体"真实播放方向"的判定（2026-11-24，v0.3.7）。
//
// 这条逻辑决定了岛上那个播放/暂停按钮**画哪个图标、点了发哪条命令**。
// 用户抱怨过"图标以及暂停播放标志不对" —— 根因就是以前这里在猜。
// 所以每条分支都有断言，不靠肉眼。

import { describe, expect, it } from 'vitest'
import {
  directionIsLive,
  mediaCommandFor,
  playPauseIconFor,
  playingDirection
} from './media-direction'
import type { MediaSnapshot } from './types'

function snap(over: Partial<MediaSnapshot> = {}): MediaSnapshot {
  return {
    source: '',
    title: '',
    artist: '',
    playing: false,
    hasSession: false,
    audioPlaying: null,
    audioPeakKnown: false,
    volume: 25,
    volumeOk: true,
    pending: '',
    ...over
  }
}

describe('真实播放方向', () => {
  it('读得到 SMTC 会话时，以 SMTC 的 playing 为准', () => {
    expect(playingDirection(snap({ hasSession: true, playing: true }))).toBe(true)
    expect(playingDirection(snap({ hasSession: true, playing: false }))).toBe(false)
  })

  it('读不到会话时，用音频会话的状态', () => {
    expect(playingDirection(snap({ hasSession: false, audioPlaying: true }))).toBe(true)
    expect(playingDirection(snap({ hasSession: false, audioPlaying: false }))).toBe(false)
  })

  it('SMTC 与音频会话都有时，SMTC 优先', () => {
    // SMTC 说在放、音频会话说暂停 → 以 SMTC 为准（它同时给得出歌名，最权威）
    expect(playingDirection(snap({ hasSession: true, playing: true, audioPlaying: false }))).toBe(
      true
    )
  })

  it('两个都读不到时是"不知道"，不是"暂停"', () => {
    // ⚠ 这条是最关键的一条：把"不知道"当成 false 就是猜，
    //   界面上就会永远显示一个猜的方向 —— 用户看得出来。
    expect(playingDirection(snap({ hasSession: false, audioPlaying: null }))).toBeNull()
    expect(playingDirection(null)).toBeNull()
  })
})

describe('按方向发哪条命令', () => {
  it('知道在放 → pause；知道暂停 → play', () => {
    expect(mediaCommandFor(true)).toBe('pause')
    expect(mediaCommandFor(false)).toBe('play')
  })

  it('不知道 → toggle（不猜方向）', () => {
    expect(mediaCommandFor(null)).toBe('toggle')
  })
})

describe('按方向画哪个图标', () => {
  it('知道在放 → 暂停图标；知道暂停 → 播放图标', () => {
    expect(playPauseIconFor(true)).toBe('pause')
    expect(playPauseIconFor(false)).toBe('play')
  })

  it('不知道 → 两态图标', () => {
    expect(playPauseIconFor(null)).toBe('both')
  })
})

describe('这个方向可不可信（会不会滞后）', () => {
  it('SMTC 会话在 → 实时', () => {
    expect(directionIsLive(snap({ hasSession: true, playing: true }))).toBe(true)
  })

  it('音频会话 + 峰值 → 实时', () => {
    // 实测峰值 1~2 秒内就反转
    expect(directionIsLive(snap({ hasSession: false, audioPlaying: true, audioPeakKnown: true }))).toBe(
      true
    )
  })

  it('音频会话但没峰值（退回会话状态）→ 可能滞后', () => {
    // 实测暂停方向滞后 23.5 秒 —— 这时不能立刻判"命令没生效"
    expect(
      directionIsLive(snap({ hasSession: false, audioPlaying: false, audioPeakKnown: false }))
    ).toBe(false)
  })

  it('根本不知道方向 → null', () => {
    expect(directionIsLive(snap({ hasSession: false, audioPlaying: null }))).toBeNull()
    expect(directionIsLive(null)).toBeNull()
  })
})

describe('播放/暂停图标：三种形态互不相同', () => {
  it('三种形态画出来的东西不一样（用户要能一眼分清）', () => {
    // 'play'  = 一个三角
    // 'pause' = 两个竖条
    // 'both'  = 一个三角 + 一个竖条
    const shapes = new Set([playPauseIconFor(true), playPauseIconFor(false), playPauseIconFor(null)])
    expect(shapes.size).toBe(3)
  })

  it('两态图标不是"播放"也不是"暂停"（不猜方向）', () => {
    expect(playPauseIconFor(null)).not.toBe(playPauseIconFor(true))
    expect(playPauseIconFor(null)).not.toBe(playPauseIconFor(false))
  })
})
