// 三个动作：开始/暂停、跳过、重置。

type ControlsProps = {
  running: boolean
  onToggle: () => void
  onSkip: () => void
  onReset: () => void
}

export function Controls({ running, onToggle, onSkip, onReset }: ControlsProps): React.JSX.Element {
  return (
    <div className="controls">
      <button className="btn btn--primary" onClick={onToggle}>
        {running ? '暂停' : '开始'}
      </button>
      <button className="btn btn--ghost" onClick={onSkip}>
        跳过
      </button>
      <button className="btn btn--ghost" onClick={onReset}>
        重置
      </button>
    </div>
  )
}
