/** 纯日期能力：UTC 日期字段、工厂自然日、实际经过时长各保留原口径。 */
export const FACTORY_TZ = 'Asia/Shanghai'
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
/** 预警沿用固定 UTC+8；与 Intl 的历史上海夏令时口径有意不同。 */
const TZ_OFFSET_MS = 8 * HOUR_MS
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 工厂时区的日期 'YYYY-MM-DD'；已是 'YYYY-MM-DD' 的原样返回 */
export function factoryDay(v: string | Date, tz = FACTORY_TZ): string {
  if (typeof v === 'string' && DAY_RE.test(v)) return v
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v))
}

/** 'YYYY-MM-DD' 往后 n 天（按日历日算，与时区无关） */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD' → 该日 UTC 零点 */
export function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** 工厂时区的今天，'YYYY-MM-DD' */
export function todayDay(now = new Date()): string {
  return factoryDay(now)
}

/** 承诺日已过去几天（当天到期算 0，未到期也是 0） */
export function overdueDays(promised: Date | null, now = new Date()): number {
  if (!promised) return 0
  const diff = Math.round((parseDay(todayDay(now)).getTime() - parseDay(promised.toISOString().slice(0, 10)).getTime()) / DAY_MS)
  return Math.max(diff, 0)
}

/** 固定 UTC+8 的上海自然日（预警 / 监控旧口径，不套用历史夏令时），'YYYY-MM-DD'。 */
export function shanghaiDay(t: Date | number): string {
  return new Date(+t + TZ_OFFSET_MS).toISOString().slice(0, 10)
}

/** 固定 UTC+8 的上海某天 00:00 的时刻（毫秒）。 */
export function shanghaiDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - TZ_OFFSET_MS
}

/** 日期字段（存为当天 UTC 零点）→ 'YYYY-MM-DD' */
export const dateFieldDay = (d: Date) => d.toISOString().slice(0, 10)

/** 两个 'YYYY-MM-DD' 相差几天（b - a） */
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)

/**
 * from → to 经过的毫秒数，停工日（工厂时区的整天）不计入。to ≤ from 时为 0。
 * offDays 为 'YYYY-MM-DD'。只遍历停工日，不逐日遍历区间。
 */
export function elapsedExcludingOffDays(from: Date | number, to: Date | number, offDays: Iterable<string>): number {
  const a = +from
  const b = +to
  if (!(b > a)) return 0
  let ms = b - a
  for (const day of new Set(offDays)) {
    const start = shanghaiDayStart(day)
    const overlap = Math.min(b, start + DAY_MS) - Math.max(a, start)
    if (overlap > 0) ms -= overlap
  }
  return ms
}

/** 从 now 经过 n × 24 小时后取运行环境本地日期（不是上海自然日；夏令时也不改为日历加天），'YYYY-MM-DD' */
export function localDayAfter(n: number, now = Date.now()) {
  const d = new Date(now + n * DAY_MS)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
