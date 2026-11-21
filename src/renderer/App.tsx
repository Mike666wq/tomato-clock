// 应用外壳。第 1 轮只有主界面（计时）；
// 统计页与设置页在第 4 轮接入导航。

import { useCallback, useEffect, useRef, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { Toast } from './components/Toast'
import { RecordCard } from './components/RecordCard'
import { Timer } from './pages/Timer'
import type { InterruptKind, Notice, Session } from '../shared/types'

/** 结束提醒：播放自带 wav（不依赖系统提示音） */
function playDing(volume: number): void {
  try {
    const audio = new Audio('ding.wav')
    audio.volume = Math.min(1, Math.max(0, volume))
    void audio.play().catch(() => {
      /* 播放失败不打断流程 */
    })
  } catch {
    /* 忽略 */
  }
}

export default function App(): React.JSX.Element {
  const [notice, setNotice] = useState<Notice | null>(null)
  const [record, setRecord] = useState<Session | null>(null)
  const [flash, setFlash] = useState(false)
  const noticeTimer = useRef<number | null>(null)

  const showNotice = useCallback((n: Notice) => {
    setNotice(n)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000)
  }, [])

  useEffect(() => {
    const api = window.pomodoro
    if (!api) return

    const offNotice = api.notice.onShow(showNotice)
    const offOpen = api.records.onOpen((s) => setRecord(s))
    const offClose = api.records.onClose(() => setRecord(null))
    const offFire = api.reminder.onFire(() => {
      // 边框呼吸 3 次 × 600ms
      setFlash(true)
      window.setTimeout(() => setFlash(false), 1850)
      void api.settings.get().then((s) => {
        if (s.soundOn) playDing(s.volume)
      })
    })
    // 早于界面订阅发出的通知在这里补取
    void api.notice.take().then((list) => list.forEach(showNotice))

    return () => {
      offNotice()
      offOpen()
      offClose()
      offFire()
    }
  }, [showNotice])

  const submitRecord = (task: string, interrupt: InterruptKind): void => {
    if (record) window.pomodoro?.records.submit(record.id, task, interrupt)
  }

  const skipRecord = (): void => {
    // 直接跳过也落一条：已完成、无任务、无打断
    if (record) window.pomodoro?.records.submit(record.id, '', 'none')
  }

  return (
    <div className={flash ? 'app app--flash' : 'app'}>
      <TitleBar />
      <Timer />
      {record ? <RecordCard session={record} onSubmit={submitRecord} onSkip={skipRecord} /> : null}
      {notice ? <Toast notice={notice} onClose={() => setNotice(null)} /> : null}
    </div>
  )
}
