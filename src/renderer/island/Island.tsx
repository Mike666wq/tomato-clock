// 灵动岛的渲染层：贴顶胶囊。
//
// 计时状态全部来自主进程（和主窗口共用同一个状态机），
// 这里不自己算时间、不自己存状态，只读快照。
//
// 交互（方案第三节 + v0.2-c 重做）：
//   收起态单击 = 开始 / 暂停（最常用的动作给最短路径，不展开）
//   悬停 120ms 展开，移开 400ms 收起
//   展开态分两层，**不平铺**：
//     第一层：时间 + 任务名 + 三个图标 + 一行两个"当前值胶囊"
//     第二层：点某个胶囊，下面那一行换成它的候选项（一次只展开一行）
//   Esc 逐层收回：先收回第二层，再收起整个岛

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings, TimerState } from '../../shared/types'
import { OpenIcon, PauseIcon, PlayIcon, SkipIcon } from './Icons'

/** 悬停多久展开 */
const HOVER_OPEN_MS = 120
/** 离开多久收起 */
const HOVER_CLOSE_MS = 400

/** 展开态第二层显示什么 */
type Layer = 'idle' | 'presets' | 'topics'

/** 秒 → mm:ss */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export default function Island(): React.JSX.Element {
  const [state, setState] = useState<TimerState | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [layer, setLayer] = useState<Layer>('idle')
  const [hint, setHint] = useState('')
  const [editingTask, setEditingTask] = useState(false)
  const [taskDraft, setTaskDraft] = useState('')
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    const api = window.island
    if (!api) return
    void api.timer.getState().then(setState)
    void api.settings.get().then(setSettings)
    const offState = api.timer.onState(setState)
    const offSettings = api.settings.onChanged(setSettings)
    return () => {
      offState()
      offSettings()
    }
  }, [])

  // 阶段色靠 html 上的 data 属性驱动：tokens.css 里 html[data-phase] 换 --phase，
  // 圆点、进度条都跟着变，渲染层不写死任何颜色。
  useEffect(() => {
    const el = document.documentElement
    if (!state) return
    el.dataset.phase = state.phase
    el.dataset.paused = state.running ? '0' : '1'
  }, [state])

  /** 收起 / 展开：本地状态决定画什么，主进程据此改窗口大小 */
  const setMode = useCallback((next: boolean) => {
    setExpanded(next)
    if (!next) setLayer('idle')
    window.island?.island.setMode(next ? 'expanded' : 'collapsed')
  }, [])

  // 悬停展开 / 离开收起
  const onEnter = useCallback(() => {
    if (openTimer.current) window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => setMode(true), HOVER_OPEN_MS)
  }, [setMode])

  const onLeave = useCallback(() => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setMode(false), HOVER_CLOSE_MS)
  }, [setMode])

  // Esc：先收回第二层，再收起整个岛
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (layer !== 'idle') {
        setLayer('idle')
        return
      }
      setMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layer, setMode])

  useEffect(
    () => () => {
      if (openTimer.current) window.clearTimeout(openTimer.current)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    []
  )

  const toggle = (): void => window.island?.timer.action('toggle')
  const skip = (): void => window.island?.timer.action('skip')
  const openMain = (): void => window.island?.island.openMain()

  /** 切模板：只影响下一段，跑着的时候给一句轻提示 */
  const pickPreset = (id: string): void => {
    window.island?.settings.save({ activePresetId: id })
    setLayer('idle')
    if (state?.running) {
      setHint('下一段生效')
      window.setTimeout(() => setHint(''), 2000)
    }
  }

  /** 切主题：同一条规则，只影响下一段 */
  const pickTopic = (id: string | null): void => {
    window.island?.settings.save({ activeTopicId: id })
    setLayer('idle')
    if (state?.running) {
      setHint('下一段生效')
      window.setTimeout(() => setHint(''), 2000)
    }
  }

  // 任务名就地编辑
  const startEditTask = (): void => {
    setTaskDraft(state?.task ?? '')
    setEditingTask(true)
  }

  const commitTask = (): void => {
    window.island?.timer.setTask(taskDraft.trim())
    setEditingTask(false)
  }

  const remaining = state ? state.remainingSec : 0
  const running = state?.running ?? false
  const percent = state && state.totalSec > 0 ? Math.min(100, (state.activeSec / state.totalSec) * 100) : 0

  const activePreset = (settings?.presets ?? []).find((p) => p.id === settings?.activePresetId)
  const activeTopic = (settings?.topics ?? []).find((t) => t.id === (state?.topicId ?? null))

  if (!expanded) {
    return (
      <div
        className="island"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={toggle}
      >
        <span className="island__dot" />
        <span className="island__time">{formatTime(remaining)}</span>
      </div>
    )
  }

  return (
    <div
      className="island island--expanded"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={() => {
        // 展开态点空白：收回第二层。第一层点空白还是"开始/暂停"（整条岛是大号开关）
        if (layer !== 'idle') setLayer('idle')
        else toggle()
      }}
    >
      <div className="island__row">
        <button
          className="island__clock"
          onClick={(e) => {
            e.stopPropagation()
            openMain()
          }}
        >
          {formatTime(remaining)}
        </button>

        {editingTask ? (
          <input
            className="island__task-input"
            value={taskDraft}
            autoFocus
            placeholder="这一段做什么"
            onChange={(e) => setTaskDraft(e.target.value)}
            onBlur={commitTask}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTask()
              if (e.key === 'Escape') setEditingTask(false)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <button
            className="island__task"
            onClick={(e) => {
              e.stopPropagation()
              startEditTask()
            }}
          >
            {state?.task || '点这里写这一段做什么'}
          </button>
        )}

        <span className="island__actions">
          <button
            className="island__btn"
            onClick={(e) => {
              e.stopPropagation()
              toggle()
            }}
            aria-label={running ? '暂停' : '继续'}
          >
            {running ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            className="island__btn"
            onClick={(e) => {
              e.stopPropagation()
              skip()
            }}
            aria-label="跳过本段"
          >
            <SkipIcon />
          </button>
          <button
            className="island__btn"
            onClick={(e) => {
              e.stopPropagation()
              openMain()
            }}
            aria-label="打开主界面"
          >
            <OpenIcon />
          </button>
        </span>
      </div>

      {layer === 'presets' ? (
        <span className="island__opts">
          {[...(settings?.presets ?? [])]
            .sort((a, b) => a.order - b.order)
            .map((p) => (
              <button
                key={p.id}
                className={
                  p.id === settings?.activePresetId ? 'island__opt island__opt--on' : 'island__opt'
                }
                onClick={(e) => {
                  e.stopPropagation()
                  pickPreset(p.id)
                }}
              >
                {p.name}
              </button>
            ))}
        </span>
      ) : layer === 'topics' ? (
        <span className="island__opts">
          <button
            className={!activeTopic ? 'island__opt island__opt--on' : 'island__opt'}
            onClick={(e) => {
              e.stopPropagation()
              pickTopic(null)
            }}
          >
            未分类
          </button>
          {[...(settings?.topics ?? [])]
            .filter((t) => !t.archived)
            .sort((a, b) => a.order - b.order)
            .map((t) => (
              <button
                key={t.id}
                className={
                  t.id === (state?.topicId ?? null) ? 'island__opt island__opt--on' : 'island__opt'
                }
                onClick={(e) => {
                  e.stopPropagation()
                  pickTopic(t.id)
                }}
              >
                <i style={{ background: t.color }} />
                {t.name}
              </button>
            ))}
        </span>
      ) : (
        <span className="island__vals">
          <button
            className="island__val"
            onClick={(e) => {
              e.stopPropagation()
              setLayer('presets')
            }}
          >
            {activePreset ? `${activePreset.name} · ${activePreset.focusMin}/${activePreset.shortMin}` : '未选模板'}
          </button>
          <button
            className="island__val"
            onClick={(e) => {
              e.stopPropagation()
              setLayer('topics')
            }}
          >
            {activeTopic ? (
              <>
                <i style={{ background: activeTopic.color }} />
                {activeTopic.name}
              </>
            ) : (
              '未分类'
            )}
          </button>
          {hint ? <em className="island__hint">{hint}</em> : null}
        </span>
      )}

      <span className="island__bar" style={{ opacity: percent > 0 ? 1 : 0.5 }}>
        <i style={{ width: `${percent}%` }} />
      </span>
    </div>
  )
}
