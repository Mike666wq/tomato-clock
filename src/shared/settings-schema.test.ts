// 设置写盘前的校验（v0.6 缺陷 D5）。
//
// 规矩：传进来一个坏值，**磁盘一个字节都不许变**，界面上给一句人话。

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import { validateSettings } from './settings-schema'

const good = (): typeof DEFAULT_SETTINGS => ({
  ...DEFAULT_SETTINGS,
  presets: DEFAULT_SETTINGS.presets.map((p) => ({ ...p })),
  topics: []
})

describe('D5 设置校验', () => {
  it('D5-1 正常的设置通过', () => {
    expect(validateSettings(good())).toBeNull()
  })

  it('D5-2 主题不是认识的那个就拒绝', () => {
    expect(validateSettings({ ...good(), uiTheme: 123 })).toMatch(/主题/)
    expect(validateSettings({ ...good(), uiTheme: 'neon' })).toBeNull()
  })

  it('D5-3 深浅模式不认识就拒绝', () => {
    expect(validateSettings({ ...good(), uiMode: 'dark-ish' })).toMatch(/深浅/)
  })

  it('D5-4 模板列表不是数组就拒绝', () => {
    expect(validateSettings({ ...good(), presets: 'oops' })).toMatch(/模板/)
  })

  it('D5-5 模板的时长不对就拒绝', () => {
    const bad = good()
    bad.presets[0] = { ...bad.presets[0], focusMin: '25 分钟' as unknown as number }
    expect(validateSettings(bad)).toMatch(/专注时长/)
  })

  it('D5-6 模板列表空了才拒绝（当前模板指向已删的模板不算坏数据）', () => {
    expect(validateSettings({ ...good(), activePresetId: '不存在的' })).toBeNull()
    expect(validateSettings({ ...good(), presets: [] })).toMatch(/模板/)
  })

  it('D5-7 音量超出 0 到 1 就拒绝', () => {
    expect(validateSettings({ ...good(), volume: 5 })).toMatch(/音量/)
    expect(validateSettings({ ...good(), volume: 0.5 })).toBeNull()
  })

  it('D5-8 开关不是布尔就拒绝', () => {
    expect(validateSettings({ ...good(), islandVisible: 'yes' })).toMatch(/开关/)
  })

  it('D5-9 不是对象的设置直接拒绝', () => {
    expect(validateSettings(null)).toMatch(/对象/)
    expect(validateSettings('nope')).toMatch(/对象/)
  })
})
