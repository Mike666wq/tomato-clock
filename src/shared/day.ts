// 「今天」的口径只有这一处实现。
//
// 为什么单独拎出来：以前主界面按**结束时间**算今天、统计页按**开始时间**算今天，
// 跨零点的那一条番茄，两边给出两个数（v0.6 缺陷 D3）。
// 现在两边都调这里的函数，口径不会再走偏 ——
// "两处各算一遍"就是那次 bug 的根源。
//
// 规则：**按开始时间算今天**（规格第四节：今日归属按开始时间算）。

/** 本地日期 → YYYY-MM-DD（不是 UTC，跨时区不会错） */
export function localDateKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 一条记录属于哪一天：按开始时间 */
export function sessionDayKey(startedAt: string): string {
  return localDateKey(new Date(startedAt))
}

/** 这条记录算不算"今天"（相对 now） */
export function isToday(startedAt: string, now: Date): boolean {
  return sessionDayKey(startedAt) === localDateKey(now)
}

/**
 * 距离下一个本地零点还有多少毫秒。
 *
 * 用来安排"到了零点重算一次今天"的定时器：
 * 比轮询省电（一个自用工具不该每 5 秒醒一次），
 * 也不会因为程序开了一整夜而显示昨天的数字。
 */
export function msUntilNextMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  // 最少给 1 秒：setTimeout(0) 会变成死循环式的立即触发
  return Math.max(1000, next.getTime() - now.getTime())
}
