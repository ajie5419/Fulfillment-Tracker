/**
 * 日期字段（要求完成日、承诺返回日）只关心"哪一天"：存为该日 UTC 零点，展示时取 ISO 前 10 位。
 * "今天"按工厂所在时区算，避免服务器在 UTC 时差 8 小时导致超期天数算错。
 */
const FACTORY_TZ = 'Asia/Shanghai'
const DAY_MS = 86_400_000

/** 'YYYY-MM-DD' → 该日 UTC 零点 */
export function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** 工厂时区的今天，'YYYY-MM-DD' */
export function todayDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FACTORY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** 承诺日已过去几天（当天到期算 0，未到期也是 0） */
export function overdueDays(promised: Date | null, now = new Date()): number {
  if (!promised) return 0
  const diff = Math.round((parseDay(todayDay(now)).getTime() - parseDay(promised.toISOString().slice(0, 10)).getTime()) / DAY_MS)
  return Math.max(diff, 0)
}
