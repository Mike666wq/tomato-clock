// 把设置里的「主题 / 深浅」写到 html 根元素上。
//
// 主题不是只有颜色：圆角、数字字体、按钮形态都在主题文件里，
// 所以切换主题 = 换 html 上的 data-theme，样式整体换掉。
//
// 深浅用 data-mode。纸感只能浅、霓虹只能深——切到不支持的那档时，
// resolveUiTheme 会自动落到这套主题支持的那一档（用户不会"切了没反应"）。

import { useEffect, useState } from 'react'
import { resolveUiTheme, type Settings } from '../shared/types'

export function useTheme(settings: Settings | null): void {
  const theme = settings?.uiTheme ?? 'paper'
  const mode = settings?.uiMode ?? 'system'

  useEffect(() => {
    const apply = (): void => {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const r = resolveUiTheme(theme, mode, systemDark)
      document.documentElement.dataset.theme = r.theme
      document.documentElement.dataset.mode = r.mode
    }
    apply()
    // 跟随系统时，系统深浅变了界面要跟着变
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme, mode])
}

/**
 * 读一个会随主题变化的 CSS 变量（数值型）。
 *
 * 环的描边宽度就是这种：纸感 2px、霓虹 10px、系统感 8px。
 * 环的半径要用它算（半径按描边宽度往外让位），所以主题一变就得重算。
 */
export function useThemeNumber(name: string, fallback: number): number {
  const [value, setValue] = useState(fallback)

  useEffect(() => {
    const read = (): void => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
      const n = Number.parseFloat(raw)
      if (Number.isFinite(n)) setValue(n)
    }
    read()
    const mo = new MutationObserver(read)
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode']
    })
    return () => mo.disconnect()
  }, [name])

  return value
}
