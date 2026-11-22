// 计时模板管理（v0.3-a，设置页用）。
//
// 内置四个模板不可删、不可改，只能复制成自己的；
// 自定义的可以新建 / 编辑 / 复制 / 删除。
// 超范围直接拒绝并把原因写在表单下面，不静默截断。

import { useState } from 'react'
import {
  PRESET_LIMITS,
  makePreset,
  validatePreset,
  type Preset,
  type PresetDraft
} from '../../shared/presets'
import { DEFAULT_PRESET_ID } from '../../shared/presets'

type Props = {
  presets: Preset[]
  activeId: string
  /** 改动模板列表（整体覆盖） */
  onPresets: (presets: Preset[]) => void
  /** 切换当前模板 */
  onActivate: (id: string) => void
  /** 提示条 */
  onNotice: (text: string) => void
}

type EditorMode = 'new' | 'edit' | 'copy'

const EMPTY: PresetDraft = { name: '', focusMin: 25, shortMin: 5, longMin: 15, roundsBeforeLong: 4 }

function newId(): string {
  return `preset-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** 复制出来的名字要放得进 12 个字 */
function copyName(name: string): string {
  const suffix = '副本'
  return `${name.slice(0, PRESET_LIMITS.nameMax - suffix.length)}${suffix}`
}

export function PresetManager({ presets, activeId, onPresets, onActivate, onNotice }: Props): React.JSX.Element {
  const [mode, setMode] = useState<EditorMode | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [draft, setDraft] = useState<PresetDraft>(EMPTY)
  const [error, setError] = useState('')

  const sorted = [...presets].sort((a, b) => a.order - b.order)

  const open = (m: EditorMode, preset?: Preset): void => {
    setError('')
    setMode(m)
    setSourceId(preset?.id ?? null)
    if (m === 'new') {
      setDraft(EMPTY)
    } else if (preset) {
      setDraft({
        name: m === 'copy' ? copyName(preset.name) : preset.name,
        focusMin: preset.focusMin,
        shortMin: preset.shortMin,
        longMin: preset.longMin,
        roundsBeforeLong: preset.roundsBeforeLong
      })
    }
  }

  const close = (): void => {
    setMode(null)
    setSourceId(null)
    setError('')
  }

  const save = (): void => {
    if (!mode) return
    const check = validatePreset(draft, presets, mode === 'edit' ? (sourceId ?? undefined) : undefined)
    if (!check.ok) {
      setError(check.error)
      onNotice(check.error)
      return
    }
    if (mode === 'edit' && sourceId) {
      onPresets(
        presets.map((p) =>
          p.id === sourceId
            ? { ...p, name: draft.name.trim(), focusMin: draft.focusMin, shortMin: draft.shortMin, longMin: draft.longMin, roundsBeforeLong: draft.roundsBeforeLong }
            : p
        )
      )
      onNotice('模板已更新')
    } else {
      const created = makePreset(draft, newId(), false, presets.length)
      onPresets([...presets, created])
      onActivate(created.id)
      onNotice(`已创建模板「${created.name}」并切过去`)
    }
    close()
  }

  const remove = (p: Preset): void => {
    if (p.builtin) return
    const rest = presets.filter((x) => x.id !== p.id)
    onPresets(rest)
    if (activeId === p.id) onActivate(DEFAULT_PRESET_ID)
    onNotice(`已删除模板「${p.name}」`)
  }

  const numField = (
    label: string,
    key: keyof Omit<PresetDraft, 'name'>,
    min: number,
    max: number,
    unit: string
  ): React.JSX.Element => (
    <div className="field">
      <label>{label}</label>
      <div className="field__num">
        <input
          type="number"
          min={min}
          max={max}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
        />
        <span>{unit}</span>
      </div>
    </div>
  )

  return (
    <section className="card">
      <h3 className="card__title">计时模板</h3>

      <div className="preset-list">
        {sorted.map((p) => (
          <div key={p.id} className={p.id === activeId ? 'preset-row preset-row--on' : 'preset-row'}>
            <button className="preset-row__name" onClick={() => onActivate(p.id)} title="设为当前模板">
              {p.name}
              {p.id === activeId ? <em>当前</em> : null}
            </button>
            <span className="preset-row__nums">
              {p.focusMin}/{p.shortMin}/{p.longMin} · {p.roundsBeforeLong}轮
            </span>
            <span className="preset-row__ops">
              {!p.builtin ? (
                <button onClick={() => open('edit', p)}>编辑</button>
              ) : null}
              <button onClick={() => open('copy', p)}>复制</button>
              {!p.builtin ? (
                <button onClick={() => remove(p)}>删除</button>
              ) : null}
            </span>
          </div>
        ))}
      </div>

      <button className="btn btn--ghost field__wide" onClick={() => open('new')}>
        新建模板
      </button>

      {mode ? (
        <div className="preset-editor">
          <div className="field">
            <label>名称</label>
            <input
              className="preset-editor__name"
              type="text"
              maxLength={PRESET_LIMITS.nameMax}
              value={draft.name}
              placeholder={mode === 'copy' ? '复制出来的名字' : '例如：写代码'}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          {numField('专注', 'focusMin', PRESET_LIMITS.focusMin.min, PRESET_LIMITS.focusMin.max, '分钟')}
          {numField('短休', 'shortMin', PRESET_LIMITS.shortMin.min, PRESET_LIMITS.shortMin.max, '分钟')}
          {numField('长休', 'longMin', PRESET_LIMITS.longMin.min, PRESET_LIMITS.longMin.max, '分钟')}
          {numField(
            '几轮后进长休',
            'roundsBeforeLong',
            PRESET_LIMITS.roundsBeforeLong.min,
            PRESET_LIMITS.roundsBeforeLong.max,
            '轮'
          )}
          {error ? <p className="preset-editor__error">{error}</p> : null}
          <div className="preset-editor__ops">
            <button className="btn btn--primary" onClick={save}>
              保存
            </button>
            <button className="btn btn--ghost" onClick={close}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      <p className="card__note">
        计时进行中切模板只影响下一段，当前这一段不变。
        内置模板不能删，但可以复制成自己的再改。
      </p>
    </section>
  )
}
