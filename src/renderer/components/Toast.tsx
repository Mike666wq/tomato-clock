// 一次性提示条（例如全局快捷键注册失败）。
// 用户看不见日志，所以主进程把这类问题推到界面上。

import type { Notice } from '../../shared/types'

type Props = {
  notice: Notice
  onClose: () => void
}

export function Toast({ notice, onClose }: Props): React.JSX.Element {
  return (
    <div className={notice.tone === 'warn' ? 'toast toast--warn' : 'toast'} onClick={onClose}>
      {notice.text}
    </div>
  )
}
