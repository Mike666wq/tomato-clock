// CSV 导出。
//
// 关键点：带 UTF-8 BOM。不带 BOM 的话 Excel 打开中文全是乱码，
// 这条踩过才知道有多烦。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PHASE_LABEL, type InterruptKind, type Session } from '../shared/types'

const INTERRUPT_LABELS: Record<InterruptKind, string> = {
  none: '没被打断',
  internal: '内部打断',
  external: '外部打断'
}

const HEADERS = [
  '日期',
  '阶段',
  '开始',
  '结束',
  '计划秒',
  '实际秒',
  '暂停秒',
  '是否完成',
  '任务',
  '打断类型'
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function escapeCell(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

/** 生成 CSV 文本（带 BOM） */
export function buildCsv(sessions: Session[]): string {
  const rows: string[] = [HEADERS.join(',')]

  for (const s of sessions) {
    const started = new Date(s.startedAt)
    const ended = new Date(s.endedAt)
    const cells = [
      localDate(started),
      PHASE_LABEL[s.kind],
      localTime(started),
      localTime(ended),
      String(s.plannedSec),
      String(s.actualSec),
      String(s.pausedSec ?? 0),
      s.completed ? '是' : '否',
      s.task ?? '',
      INTERRUPT_LABELS[s.interrupt] ?? s.interrupt
    ]
    rows.push(cells.map(escapeCell).join(','))
  }

  // BOM：Excel 认它就知道是 UTF-8
  return `﻿${rows.join('\r\n')}\r\n`
}

export async function exportCsv(filePath: string, sessions: Session[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, buildCsv(sessions), 'utf-8')
}
