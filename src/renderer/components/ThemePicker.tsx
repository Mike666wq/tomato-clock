// 主题选择：外观分区。
//
// 为什么是三张缩略卡而不是下拉框：用户看不懂"纸感""霓虹"这两个字是什么意思，
// 看一眼缩略图才知道选中的是什么。缩略图不是画出来的色块——
// 它借用各套主题自己的变量（[data-theme='paper'] 这种选择器），
// 所以纸感那张真的是"暖白底 + 一根细弧 + 衬线数字"的缩影。
//
// 深浅：纸感只有浅、霓虹只有深、系统感跟随系统/浅/深。
// 切到不支持当前深浅的主题时自动落到它支持的那一档，并在下面说明原因，
// 不能让人切完发现界面没变。

import { useState } from 'react'
import { UI_THEMES, type UiMode, type UiTheme } from '../../shared/types'

type Props = {
  theme: UiTheme
  mode: UiMode
  /** 换主题（深浅需要一起落档时两个都传） */
  onPick: (theme: UiTheme, mode: UiMode) => void
}

const MODE_LABEL: Record<UiMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

export function ThemePicker({ theme, mode, onPick }: Props): React.JSX.Element {
  const [note, setNote] = useState('')
  const current = UI_THEMES.find((t) => t.id === theme) ?? UI_THEMES[0]
  const supportsModes = current.modes.length > 1

  const pick = (t: UiTheme): void => {
    const info = UI_THEMES.find((x) => x.id === t) ?? UI_THEMES[0]
    if (info.modes.includes(mode)) {
      setNote('')
      onPick(t, mode)
      return
    }
    // 这套不支持当前深浅 → 落到它支持的那一档，并把原因说清楚
    const fallback = info.modes[0]
    const word = fallback === 'light' ? '浅色' : '深色'
    setNote(`${info.name}只有${word}，已自动切到${word}。`)
    onPick(t, fallback)
  }

  const setMode = (m: UiMode): void => {
    setNote('')
    onPick(theme, m)
  }

  return (
    <div className="theme-picker">
      <div className="theme-cards">
        {UI_THEMES.map((t) => (
          <button
            key={t.id}
            className={t.id === theme ? 'theme-card theme-card--on' : 'theme-card'}
            onClick={() => pick(t.id)}
            aria-pressed={t.id === theme}
          >
            <span
              className="theme-card__preview"
              data-theme={t.id}
              data-mode={t.modes.includes('light') ? 'light' : 'dark'}
            >
              <svg className="theme-card__ring" viewBox="0 0 48 48" aria-hidden="true">
                <circle cx="24" cy="24" r="18" className="theme-card__arc" />
              </svg>
              <span className="theme-card__time">25:00</span>
            </span>
            <span className="theme-card__name">{t.name}</span>
            <span className="theme-card__desc">{t.desc}</span>
          </button>
        ))}
      </div>

      <div className="theme-modes">
        <span className="theme-modes__label">深浅</span>
        {supportsModes ? (
          <div className="theme-seg">
            {current.modes.map((m) => (
              <button
                key={m}
                className={m === mode ? 'theme-seg__item theme-seg__item--on' : 'theme-seg__item'}
                onClick={() => setMode(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        ) : (
          <span className="theme-modes__fixed">
            {current.name}只有{current.modes[0] === 'light' ? '浅色' : '深色'}
          </span>
        )}
      </div>

      <div className="card__note">
        {note || '三套风格不只是配色：字体、圆角、按钮形态、光影都不同。'}
        {note ? '' : ' 纸感像一张纸，玻璃霓虹像一块发光装置，系统感像苹果自带的 app。'}
      </div>
    </div>
  )
}
