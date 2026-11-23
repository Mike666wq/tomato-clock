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
import type { MediaSnapshot, Settings, TimerState } from '../../shared/types'
import { resolveUiTheme } from '../../shared/types'
import { NextIcon, OpenIcon, PauseIcon, PlayIcon, PrevIcon, SkipIcon } from './Icons'

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
  const [media, setMedia] = useState<MediaSnapshot | null>(null)
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

  // 音乐状态：主进程从 SMTC 子进程拿到后广播过来
  useEffect(() => {
    const api = window.island
    if (!api) return
    void api.media.getState().then(setMedia)
    const off = api.media.onState(setMedia)
    return off
  }, [])

  // 阶段色靠 html 上的 data 属性驱动：tokens.css 里 html[data-phase] 换 --phase，
  // 圆点、进度条都跟着变，渲染层不写死任何颜色。
  useEffect(() => {
    const el = document.documentElement
    if (!state) return
    el.dataset.phase = state.phase
    el.dataset.paused = state.running ? '0' : '1'
  }, [state])

  /**
   * 灵动岛跟随主窗口的主题。
   *
   * 只换**颜色和圆角**，结构不动（还是那条胶囊）。
   * 每套主题在 styles/themes/*.css 里定义自己的一套 --island-* 变量，
   * 这里只负责把 data-theme / data-mode 写到 html 上。
   */
  useEffect(() => {
    const el = document.documentElement
    const r = resolveUiTheme(
      settings?.uiTheme ?? 'paper',
      settings?.uiMode ?? 'system',
      window.matchMedia('(prefers-color-scheme: dark)').matches
    )
    el.dataset.theme = r.theme
    el.dataset.mode = r.mode
  }, [settings?.uiTheme, settings?.uiMode])

  /** 收起 / 展开：本地状态决定画什么，主进程据此改窗口大小 */
  const setMode = useCallback((next: boolean) => {
    setExpanded(next)
    if (!next) setLayer('idle')
  }, [])

  /**
   * 展开态要不要显示音乐控制那一行。
   * 三个条件缺一不可：设置里开了、有音乐在放、歌名或歌手至少有一个。
   * 没开音乐软件是常态 → 那一行整个消失，不留空行、不报错。
   */
  const showMusic =
    (settings?.showMusicControl ?? false) &&
    media !== null &&
    (media.title !== '' || media.artist !== '')

  /**
   * 窗口尺寸由主进程管，这里告诉它"要不要多一行音乐"。
   * 音乐那一行出现/消失时胶囊高度会变，窗口必须跟着变，否则会截掉或者多一块空白。
   */
  useEffect(() => {
    window.island?.island.setMode(expanded ? 'expanded' : 'collapsed', expanded && showMusic)
  }, [expanded, showMusic])

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
    // 正在写任务名时不许收起：之前这里没判断，鼠标一离开 400ms 岛就缩回去，
    // 输入框跟着消失，用户点进去刚开始打字就全没了。
    if (editingTask) return
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setMode(false), HOVER_CLOSE_MS)
  }, [setMode, editingTask])

  // Esc：编辑中先取消编辑；否则先收回第二层，再收起整个岛
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (editingTask) {
        setEditingTask(false)
        return
      }
      if (layer !== 'idle') {
        setLayer('idle')
        return
      }
      setMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layer, setMode, editingTask])

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
    // 岛是常驻置顶的浮层，不一定持有键盘焦点；不主动要一次焦点，
    // 打进去的字符会跑到下面的主窗口去。主进程那边 win.focus() + webContents.focus()。
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    window.island?.island.focus()
  }

  const commitTask = (): void => {
    window.island?.timer.setTask(taskDraft.trim())
    setEditingTask(false)
  }

  const remaining = state ? state.remainingSec : 0
  /** 只有专注段能写任务名（D3） */
  const isFocus = (state?.phase ?? 'focus') === 'focus'
  const running = state?.running ?? false
  const percent = state && state.totalSec > 0 ? Math.min(100, (state.activeSec / state.totalSec) * 100) : 0

  const activePreset = (settings?.presets ?? []).find((p) => p.id === settings?.activePresetId)

  /**
   * 主题要显示「用户选中的那个」，不是「这一段正在用的那个」。
   *
   * 切主题按设计只影响下一段，所以 state.topicId 在跑着的时候不会变。
   * 之前这里用 state.topicId，用户点了「未分类」→ activeTopicId 存进去了，
   * 但界面高亮纹丝不动，看起来就是"点了没反应"。
   *
   * 现在：高亮跟 settings.activeTopicId（选中的）；正在跑的这段用的是哪个，
   * 用一个小「本段」标记单独标出来，两者不同时用户才看得懂发生了什么。
   */
  const selectedTopicId = settings?.activeTopicId ?? null
  const runningTopicId = state?.topicId ?? null
  const activeTopic = (settings?.topics ?? []).find((t) => t.id === selectedTopicId)

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
      style={
        {
          // 高度跟着"有没有音乐行"走，主进程那边的窗口高度用的是同一个数
          '--island-h-expanded': showMusic ? 'var(--island-h-expanded-music)' : undefined
        } as React.CSSProperties
      }
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={() => {
        // 展开态点空白：收回第二层。第一层点空白还是"开始/暂停"（整条岛是大号开关）
        // 正在写任务名时点空白 = 结束编辑并提交，别顺手把计时也切了
        if (editingTask) {
          commitTask()
          return
        }
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
            className={isFocus ? 'island__task' : 'island__task island__task--off'}
            onClick={(e) => {
              e.stopPropagation()
              // D3：休息段不许写任务名（休息段的任务没意义，还会进记录）
              if (!isFocus) return
              startEditTask()
            }}
          >
            {state?.task || (isFocus ? '点这里写这一段做什么' : '休息中')}
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
          {[...(settings?.topics ?? [])]
            .filter((t) => !t.archived)
            .sort((a, b) => a.order - b.order)
            .map((t) => (
              <button
                key={t.id}
                className={t.id === selectedTopicId ? 'island__opt island__opt--on' : 'island__opt'}
                onClick={(e) => {
                  e.stopPropagation()
                  // 再点一次已选中的那个 = 取消选择（不然没有别的办法取消）
                  pickTopic(t.id === selectedTopicId ? null : t.id)
                }}
              >
                <i style={{ background: t.color }} />
                {t.name}
                {/* 正在跑的这段挂的是这个主题，但用户已经选了别的 → 标一下，别让人以为没生效 */}
                {runningTopicId === t.id && runningTopicId !== selectedTopicId ? (
                  <em className="island__opt-tag">本段</em>
                ) : null}
              </button>
            ))}
          {/* 没有"未分类"这个选项了 —— 它是数据概念（记录里没挂主题），不是能选的东西。
              想要一个"还没选"的状态，这里给一条创建入口。 */}
          <button
            className="island__opt island__opt--add"
            onClick={(e) => {
              e.stopPropagation()
              window.island?.island.openTopics()
            }}
          >
            ＋ 主题
          </button>
          {/* 这一段没挂主题但用户选了别的：说明一下，别让人以为这段也会记到那个主题上 */}
          {runningTopicId === null && selectedTopicId !== null ? (
            <em className="island__opt-note">本段没挂主题</em>
          ) : null}
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
            className={activeTopic ? 'island__val' : 'island__val island__val--add'}
            onClick={(e) => {
              e.stopPropagation()
              // 没选主题时，这个位置是**提示可以创建主题**，
              // 不是"未分类"这个伪选项 ——
              // "未分类"是数据概念（记录里没挂主题），不是能选的东西。
              if (!activeTopic) {
                window.island?.island.openTopics()
                return
              }
              setLayer('topics')
            }}
          >
            {activeTopic ? (
              <>
                <i style={{ background: activeTopic.color }} />
                {activeTopic.name}
              </>
            ) : (
              '＋ 主题'
            )}
          </button>
          {hint ? <em className="island__hint">{hint}</em> : null}
        </span>
      )}

      {showMusic && media ? (
        <span className="island__music">
          <span className="island__music-note">♪</span>
          {/* key 跟着歌名走：换歌时这一段重新挂载，淡入动画重放（120ms，不闪）。
              歌名和歌手分成两个元素：**歌名左对齐、歌手右对齐**，中间留白。
              以前是「歌名 - 歌手」拼在一段文字里，长歌名截断后省略号后面紧跟一个
              " - "，读起来像省略号里还藏了半句话。
              分成两块之后，歌手那一块永远不会被歌名的省略号污染。 */}
          <span className="island__music-text" key={`${media.title}|${media.artist}`}>
            <span className="island__music-title">{media.title}</span>
            {media.artist ? <span className="island__music-artist">{media.artist}</span> : null}
          </span>
          <span className="island__music-actions">
            <button
              className="island__music-btn"
              onClick={(e) => {
                e.stopPropagation()
                window.island?.media.command('prev')
              }}
              aria-label="上一首"
            >
              <PrevIcon size={16} />
            </button>
            <button
              className="island__music-btn"
              onClick={(e) => {
                e.stopPropagation()
                window.island?.media.command(media.playing ? 'pause' : 'play')
              }}
              aria-label={media.playing ? '暂停' : '播放'}
            >
              {media.playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
            </button>
            <button
              className="island__music-btn"
              onClick={(e) => {
                e.stopPropagation()
                window.island?.media.command('next')
              }}
              aria-label="下一首"
            >
              <NextIcon size={16} />
            </button>
          </span>
        </span>
      ) : null}

      <span className="island__bar" style={{ opacity: percent > 0 ? 1 : 0.5 }}>
        <i style={{ width: `${percent}%` }} />
      </span>
    </div>
  )
}
