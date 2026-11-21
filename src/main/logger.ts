// 主进程日志：既写控制台，也落盘到 userData/app.log。
// 全局快捷键注册失败、托盘创建失败这类"不能静默"的错误都走这里。

import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

let logFile: string | null = null

function file(): string | null {
  try {
    if (!logFile) {
      const dir = app.getPath('userData')
      mkdirSync(dir, { recursive: true })
      logFile = path.join(dir, 'app.log')
    }
    return logFile
  } catch {
    return null
  }
}

function write(level: string, msg: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${msg}`
  const target = file()
  if (target) {
    try {
      appendFileSync(target, `${line}\n`, 'utf-8')
    } catch {
      /* 落盘失败不再抛，避免日志把主进程搞崩 */
    }
  }
}

export const log = {
  info: (msg: string): void => {
    console.log(line('INFO', msg))
    write('INFO', msg)
  },
  warn: (msg: string): void => {
    console.warn(line('WARN', msg))
    write('WARN', msg)
  },
  error: (msg: string): void => {
    console.error(line('ERROR', msg))
    write('ERROR', msg)
  }
}

function line(level: string, msg: string): string {
  return `[pomodoro] ${level} ${msg}`
}
