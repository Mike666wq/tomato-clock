// 给人看的格式化。
//
// 主进程和渲染层都要用，所以放 shared。

/**
 * 把 Electron 的 accelerator 字符串变成人能读的写法。
 *   CommandOrControl+Alt+Space → Windows: "Ctrl + Alt + Space"；macOS: "⌘ + ⌥ + Space"
 */
export function formatAccelerator(accelerator: string, platform = 'win32'): string {
  const isMac = platform.toLowerCase().startsWith('mac')

  const parts = accelerator.split('+').map((raw) => {
    switch (raw) {
      case 'CommandOrControl':
      case 'CmdOrCtrl':
        return isMac ? '⌘' : 'Ctrl'
      case 'Command':
      case 'Cmd':
        return isMac ? '⌘' : 'Win'
      case 'Control':
      case 'Ctrl':
        return 'Ctrl'
      case 'Alt':
      case 'Option':
        return isMac ? '⌥' : 'Alt'
      case 'Shift':
        return isMac ? '⇧' : 'Shift'
      case 'Super':
      case 'Meta':
        return isMac ? '⌘' : 'Win'
      default:
        return raw.startsWith('Key') ? raw.slice(3) : raw
    }
  })

  return parts.join(' + ')
}

/** 当前平台是不是 macOS（渲染层用） */
export function isMacPlatform(): boolean {
  return navigator.platform.toLowerCase().startsWith('mac') || navigator.userAgent.includes('Mac')
}
