// 底部导航：计时 / 统计 / 设置。
// 文字按钮，不做图标，安静一点。

export type PageKey = 'timer' | 'stats' | 'settings'

const ITEMS: Array<{ key: PageKey; label: string }> = [
  { key: 'timer', label: '计时' },
  { key: 'stats', label: '统计' },
  { key: 'settings', label: '设置' }
]

type Props = {
  page: PageKey
  onChange: (p: PageKey) => void
}

export function Nav({ page, onChange }: Props): React.JSX.Element {
  return (
    <nav className="nav">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          className={page === it.key ? 'nav__item nav__item--on' : 'nav__item'}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </nav>
  )
}
