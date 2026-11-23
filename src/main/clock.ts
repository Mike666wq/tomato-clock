// 主进程用的"现在"。
//
// 为什么要注入点：跨零点这件事没法在测试里真的等到零点。
// 注入一个偏移量，就能把"现在"推到第二天，验证"跨零点时界面确实重算"。
//
// 只有"今天是哪天"用这里的时钟；
// **计时器用真实时间**（它要的是秒级准确，不能被测试偏移带走）。

let offsetMs = 0

/** 当前时刻（毫秒） */
export function nowMs(): number {
  return Date.now() + offsetMs
}

/** 当前时刻（Date） */
export function nowDate(): Date {
  return new Date(nowMs())
}

/**
 * 把"现在"往前/往后推（毫秒）。
 *
 * 只有开发期的测试口子在用；打包产物里没有调用它的地方。
 */
export function setClockOffset(ms: number): void {
  offsetMs = Number.isFinite(ms) ? ms : 0
}

/** 当前偏移量 */
export function getClockOffset(): number {
  return offsetMs
}
