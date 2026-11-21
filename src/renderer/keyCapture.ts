// 改键时的按键捕获。
//
// 单独放一个模块，是为了让计时页的空格键快捷键在"正在改键"时让路。

let capturing = false

export const keyCapture = {
  get active(): boolean {
    return capturing
  },
  start(): void {
    capturing = true
  },
  stop(): void {
    capturing = false
  },
  /** 把一次按键翻译成 Electron 加速键字符串；不合格返回 null */
  toAccelerator(e: KeyboardEvent): string | null {
    const parts: string[] = []
    if (e.ctrlKey) parts.push('CommandOrControl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Super')

    const code = e.code
    if (code.startsWith('Key')) parts.push(code.slice(3))
    else if (code.startsWith('Digit')) parts.push(code.slice(5))
    else if (code === 'Space') parts.push('Space')
    else if (code === 'Escape') parts.push('Escape')
    else if (/^F\d{1,2}$/.test(code)) parts.push(code)
    else return null

    // 至少要有一个修饰键，不然会跟普通打字冲突
    if (parts.length < 2) return null
    return parts.join('+')
  }
}
