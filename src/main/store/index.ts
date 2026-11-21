// 仓储层接口。
//
// v0.1 用 JSON 文件实现（见 json-store.ts），以后要换 SQLite 只改这一层，
// 上层代码只认这里的 listSessions / addSession / getSettings / saveSettings。

import type { AppData, InterruptKind, Session, Settings } from '../../shared/types'

export interface Store {
  /** 读取全部数据；文件不存在时返回默认值 */
  read(): Promise<AppData>
  /** 整体覆盖写入（原子写） */
  write(data: AppData): Promise<void>
  /** 追加一条记录 */
  addSession(session: Session): Promise<void>
  /** 更新一条记录（补任务名、打断类型） */
  updateSession(id: string, patch: Partial<Pick<Session, 'task' | 'interrupt' | 'interruptNote'>>): Promise<void>
  /** 列出全部记录 */
  listSessions(): Promise<Session[]>
  /** 读取设置 */
  getSettings(): Promise<Settings>
  /** 保存设置 */
  saveSettings(settings: Settings): Promise<void>
}

export type { AppData, InterruptKind, Session, Settings }
