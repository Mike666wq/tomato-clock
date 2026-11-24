// 灵动岛（屏幕顶端中央的悬浮胶囊）的尺寸常量。
//
// 主进程要按它算窗口大小与贴顶位置，渲染层要按它画胶囊，
// 两边共用一份，免得改尺寸时对不上。

export const ISLAND = {
  /** 收起态胶囊尺寸（DIP） */
  collapsedW: 172,
  collapsedH: 34,
  /** 展开态胶囊尺寸（DIP）。两层：信息行 + 当前值/选项行 */
  expandedW: 344,
  expandedH: 92,
  /** 展开态且显示了音乐控制那一行时的高度（多一行 42px） */
  expandedHMusic: 134,
  /** 窗口左右各留的透明余量（给阴影） */
  sidePad: 8,
  /** 窗口底部留的透明余量（给阴影） */
  bottomPad: 14,
  /**
   * 主题列表（v0.3.10）跟胶囊之间的缝。
   *
   * 岛贴屏幕顶端，列表只能**向下**展开，所以窗口要临时加高。
   * 这个数同时被两边用：主进程拿它算窗口高度，渲染层拿它定位列表。
   */
  menuGap: 6
} as const

export type IslandMode = 'collapsed' | 'expanded'
