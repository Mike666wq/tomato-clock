// 设置页：时长、轮数、自动开始、声音、开机自启、快捷键改键、导出 CSV。

import { useEffect, useRef, useState } from 'react'
import { keyCapture } from '../keyCapture'
import type { Settings, ShortcutDef, TimerState } from '../../shared/types'

const DEFAULTS: Settings = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsBeforeLong: 4,
  autoStartNext: false,
  soundOn: true,
  volume: 0.5,
  launchAtLogin: false,
  window: { w: 480, h: 580 }
}

type Props = {
  /** 界面提示回调（导出成功、改键成功等） */
  onNotice: (text: string) => void
}

export function SettingsPage({ onNotice }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULTS)
  const [shortcuts, setShortcuts] = useState<ShortcutDef[]>([])
  const [capturing, setCapturing] = useState<ShortcutDef['id'] | null>(null)
  const [exporting, setExporting] = useState(false)
  const [running, setRunning] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const api = window.pomodoro
    if (!api) return
    void api.settings.get().then(setSettings)
    void api.shortcuts.get().then(setShortcuts)
    // 计时是否在跑：用于提示"改时长只影响下一段"
    const off = api.timer.onState((s) => setRunning(s.running))
    return off
  }, [])

  // 正在改键时，捕获下一次按键
  useEffect(() => {
    const target = capturing
    if (!target) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        keyCapture.stop()
        setCapturing(null)
        return
      }
      const acc = keyCapture.toAccelerator(e)
      if (!acc) return
      keyCapture.stop()
      const id = target
      setCapturing(null)
      void window.pomodoro?.shortcuts.set(id, acc).then((res) => {
        if (res.ok) {
          // 重新拉一份，display 由主进程按平台生成
          void window.pomodoro?.shortcuts.get().then(setShortcuts)
          onNotice('快捷键已修改')
        }
        // 失败由主进程走提示条链路，这里不用重复提示
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, onNotice])

  const patch = (p: Partial<Settings>): void => {
    setSettings((prev) => ({ ...prev, ...p }))
    window.pomodoro?.settings.save(p)
  }

  const startCapture = (id: ShortcutDef['id']): void => {
    keyCapture.start()
    setCapturing(id)
  }

  const doExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const res = await window.pomodoro?.csv.export()
      if (res?.ok) onNotice(`已导出到 ${res.path}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="main main--page" ref={rootRef}>
      <section className="card">
        <h3 className="card__title">时长</h3>
        <div className="field">
          <label>专注</label>
          <div className="field__num">
            <input
              type="number"
              min={1}
              max={120}
              value={settings.focusMin}
              onChange={(e) => patch({ focusMin: Math.max(1, Number(e.target.value) || 1) })}
            />
            <span>分钟</span>
          </div>
        </div>
        <div className="field">
          <label>短休</label>
          <div className="field__num">
            <input
              type="number"
              min={1}
              max={60}
              value={settings.shortBreakMin}
              onChange={(e) => patch({ shortBreakMin: Math.max(1, Number(e.target.value) || 1) })}
            />
            <span>分钟</span>
          </div>
        </div>
        <div className="field">
          <label>长休</label>
          <div className="field__num">
            <input
              type="number"
              min={1}
              max={60}
              value={settings.longBreakMin}
              onChange={(e) => patch({ longBreakMin: Math.max(1, Number(e.target.value) || 1) })}
            />
            <span>分钟</span>
          </div>
        </div>
        <div className="field">
          <label>几个番茄后长休</label>
          <div className="field__num">
            <input
              type="number"
              min={1}
              max={12}
              value={settings.roundsBeforeLong}
              onChange={(e) => patch({ roundsBeforeLong: Math.max(1, Number(e.target.value) || 1) })}
            />
            <span>轮</span>
          </div>
        </div>
        {running ? (
          <div className="card__note">计时进行中，改时长只影响下一段，当前这一段不变。</div>
        ) : null}
      </section>

      <section className="card">
        <h3 className="card__title">提醒</h3>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.soundOn}
            onChange={(e) => patch({ soundOn: e.target.checked })}
          />
          <span>结束提示音</span>
        </label>
        <div className="field">
          <label>音量</label>
          <input
            className="slider"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            onChange={(e) => patch({ volume: Number(e.target.value) })}
          />
          <span className="field__val">{Math.round(settings.volume * 100)}%</span>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.autoStartNext}
            onChange={(e) => patch({ autoStartNext: e.target.checked })}
          />
          <span>自动开始下一段</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => patch({ launchAtLogin: e.target.checked })}
          />
          <span>开机自启</span>
        </label>
      </section>

      <section className="card">
        <h3 className="card__title">全局快捷键</h3>
        {shortcuts.map((s) => (
          <div className="field" key={s.id}>
            <label>{s.label}</label>
            <button className="field__key" onClick={() => startCapture(s.id)}>
              {capturing === s.id ? '按下组合键…' : s.display}
            </button>
          </div>
        ))}
        <div className="card__note">改键后如果被别的程序占用，会在界面上提示，旧的键仍然可用。</div>
      </section>

      <section className="card">
        <h3 className="card__title">数据</h3>
        <button className="btn btn--ghost field__wide" onClick={() => void doExport()} disabled={exporting}>
          {exporting ? '导出中…' : '导出 CSV'}
        </button>
        <div className="card__note">导出全部记录为 CSV，带 UTF-8 BOM，Excel 直接打开不乱码。</div>
      </section>
    </div>
  )
}

export type { TimerState }
