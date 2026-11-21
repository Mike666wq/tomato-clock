// 自绘标题栏：拖拽区 + 最小化 / 关闭。
// 隐藏系统标题栏后，拖拽靠 -webkit-app-region: drag，按钮区域标 no-drag。

export function TitleBar(): React.JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar__drag">
        <span className="titlebar__title">番茄钟</span>
      </div>
      <div className="titlebar__actions">
        <button
          className="titlebar__btn"
          aria-label="最小化"
          title="最小化"
          onClick={() => window.pomodoro?.window.minimize()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1" y="5.25" width="10" height="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          aria-label="关闭"
          title="关闭"
          onClick={() => window.pomodoro?.window.close()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </header>
  )
}
