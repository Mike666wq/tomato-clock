// 应用外壳：标题栏 + 页面（计时 / 统计 / 设置）+ 记录卡片 + 提示条。

import { useCallback, useEffect, useRef, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { Toast } from './components/Toast'
import { RecordCard } from './components/RecordCard'
import { Nav, type PageKey } from './components/Nav'
import { Timer } from './pages/Timer'
import { Stats } from './pages/Stats'
import { SettingsPage } from './pages/Settings'
import { useTheme } from './useTheme'
import type { InterruptKind, Notice, Session, Settings } from '../shared/types'

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

/** 开发期可以用 ?page=stats 直接打开某页（打包后无效） */
function initialPage(): PageKey {
  if (!import.meta.env.DEV) return 'timer'
  const p = new URLSearchParams(window.location.search).get('page')
  return p === 'stats' || p === 'settings' ? p : 'timer'
}

export default function App(): React.JSX.Element {
  const [notice, setNotice] = useState<Notice | null>(null)
  const [record, setRecord] = useState<Session | null>(null)
  const [flash, setFlash] = useState(false)
  const [page, setPage] = useState<PageKey>(initialPage)
  const [settings, setSettings] = useState<Settings | null>(null)
  /** 主进程让界面滚到某一块（灵动岛的「＋ 主题」） */
  const [section, setSection] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)

  // 主题/深浅写到 html 根元素上（颜色、圆角、字体全在主题文件里）
  useTheme(settings)

  const showNotice = useCallback((text: string) => {
    setNotice({ id: String(Date.now()), text, tone: 'info' })
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5000)
  }, [])

  const showWarn = useCallback((text: string) => {
    setNotice({ id: String(Date.now()), text, tone: 'warn' })
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 8000)
  }, [])

  useEffect(() => {
    const api = window.pomodoro
    if (!api) return

    const offNotice = api.notice.onShow((n) => {
      if (n.tone === 'warn') showWarn(n.text)
      else showNotice(n.text)
    })
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
    void api.notice.take().then((list) => list.forEach((n) => (n.tone === 'warn' ? showWarn(n.text) : showNotice(n.text))))

    // 主进程让切页（灵动岛右键菜单里的"设置"）
    const offPage = api.nav.onPage((p) => setPage(p))
    // 主进程让滚到某一块（灵动岛的「＋ 主题」→ 设置页的主题那块）
    const offSection = api.nav.onSection((s) => {
      setSection(s)
      setPage('settings')
    })

    // 主题跟着设置走
    void api.settings.get().then(setSettings)
    const offSettings = api.settings.onChanged(setSettings)

    return () => {
      offNotice()
      offOpen()
      offClose()
      offFire()
      offPage()
      offSection()
      offSettings()
    }
  }, [showNotice, showWarn])

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
      {page === 'timer' ? <Timer onOpenTopics={() => setPage('settings')} /> : null}
      {page === 'stats' ? <Stats /> : null}
      {page === 'settings' ? <SettingsPage onNotice={showNotice} section={section} /> : null}
      <Nav page={page} onChange={setPage} />
      {record ? <RecordCard session={record} onSubmit={submitRecord} onSkip={skipRecord} /> : null}
      {notice ? <Toast notice={notice} onClose={() => setNotice(null)} /> : null}
    </div>
  )
}
