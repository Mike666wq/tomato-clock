// 三个动作：重置 / 开始·暂停 / 跳过。
//
// 每个按钮里同时放**图标和文字**，主题决定显示哪个：
//   纸感 —— 只显示文字（按钮是"带下划线的文字"）
//   霓虹 —— 主按钮是发光圆键，次要按钮只显示图标
//   系统感 —— 主按钮是药丸（带文字），次要按钮是圆形图标键
// 组件里不许为某个主题写 if，所以两样都渲染出来，主题文件用结构覆盖块挑。
//
// 顺序也按三套稿子统一：重置在左，主按钮在中间，跳过在右。

type ControlsProps = {
  running: boolean
  onToggle: () => void
  onSkip: () => void
  onReset: () => void
}

export function Controls({ running, onToggle, onSkip, onReset }: ControlsProps): React.JSX.Element {
  return (
    <div className="controls">
      <button className="btn btn--ghost" onClick={onReset} aria-label="重置">
        <span className="btn__icon">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.2 4.6a6.4 6.4 0 1 1-1 5.6" />
            <path d="M3 3.4v3.4h3.4" />
          </svg>
        </span>
        <span className="btn__label">重置</span>
      </button>

      <button className="btn btn--primary" onClick={onToggle}>
        <span className="btn__icon">
          {running ? (
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <rect x="9.5" y="5.5" width="3.4" height="17" rx="1.4" fill="currentColor" />
              <rect x="16.1" y="5.5" width="3.4" height="17" rx="1.4" fill="currentColor" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <path d="M11 5.5 22 14 11 22.5Z" fill="currentColor" />
            </svg>
          )}
        </span>
        <span className="btn__label">{running ? '暂停' : '开始'}</span>
      </button>

      <button className="btn btn--ghost" onClick={onSkip} aria-label="跳过">
        <span className="btn__icon">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4.4 4.4 12 9l-7.6 4.6Z" fill="currentColor" />
            <rect x="12.6" y="4.4" width="1.8" height="9.2" rx="0.8" fill="currentColor" />
          </svg>
        </span>
        <span className="btn__label">跳过</span>
      </button>
    </div>
  )
}
