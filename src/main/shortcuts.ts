// 全局快捷键：注册、改键、失败回报。
//
// 失败不能静默：既写日志，也要把提示推给界面（用户看不见日志）。

import { globalShortcut } from 'electron'
import { log } from './logger'
import { formatAccelerator } from '../shared/format'

export type ShortcutId = 'toggle' | 'show'

export type ShortcutDef = {
  id: ShortcutId
  accelerator: string
  label: string
}

const DEFAULTS: Record<ShortcutId, string> = {
  toggle: 'CommandOrControl+Alt+Space',
  show: 'CommandOrControl+Alt+P'
}

const LABELS: Record<ShortcutId, string> = {
  toggle: '开始 / 暂停',
  show: '显示窗口'
}

const current: Record<ShortcutId, string> = { ...DEFAULTS }
const handlers: Partial<Record<ShortcutId, () => void>> = {}

export function getShortcuts(): ShortcutDef[] {
  return (['toggle', 'show'] as ShortcutId[]).map((id) => ({
    id,
    accelerator: current[id],
    label: LABELS[id]
  }))
}

/** 给人看的写法（界面上不要出现 CommandOrControl 这种原始字符串） */
export function getShortcutLabels(): Array<ShortcutDef & { display: string }> {
  return getShortcuts().map((s) => ({ ...s, display: formatAccelerator(s.accelerator, process.platform) }))
}

export function registerShortcuts(h: Record<ShortcutId, () => void>): string[] {
  handlers.toggle = h.toggle
  handlers.show = h.show

  const failed: string[] = []
  for (const id of ['toggle', 'show'] as ShortcutId[]) {
    const acc = current[id]
    try {
      if (globalShortcut.register(acc, h[id])) {
        log.info(`全局快捷键已注册: ${acc}（${LABELS[id]}）`)
      } else {
        failed.push(acc)
        log.error(`全局快捷键注册失败（可能已被其他程序占用）: ${acc}`)
      }
    } catch (err) {
      failed.push(acc)
      log.error(`全局快捷键注册异常 ${acc}: ${(err as Error).message}`)
    }
  }
  return failed
}

/** 改键：先试新的，不行就把旧的装回去 */
export function replaceShortcut(id: ShortcutId, accelerator: string): { ok: boolean; error?: string } {
  const old = current[id]
  const handler = handlers[id]
  if (!handler) return { ok: false, error: '该快捷键还没有绑定处理函数' }
  const display = formatAccelerator(accelerator, process.platform)

  try {
    globalShortcut.unregister(old)
    if (globalShortcut.register(accelerator, handler)) {
      current[id] = accelerator
      log.info(`全局快捷键已改: ${LABELS[id]} → ${display}`)
      return { ok: true }
    }
    globalShortcut.register(old, handler)
    return { ok: false, error: `${display} 注册失败，可能被其他程序占用` }
  } catch (err) {
    globalShortcut.register(old, handler)
    return { ok: false, error: (err as Error).message }
  }
}
