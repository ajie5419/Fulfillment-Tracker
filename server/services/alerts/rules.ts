/**
 * 预警规则判定（方案 6.1），全部是纯函数，不碰数据库，便于单元测试。扫描、写库、通知在 scan.ts。
 *
 *   W1 待确认匹配超时：从进入"待确认匹配"起计时，提醒 4 小时 / 黄 1 天 / 红 3 天
 *   W2 转序停滞：从生成"安排发出/开工"待办起计时，黄 2 天 / 红 4 天
 *   W3 外协逾期未返：承诺返回日前 2 天提醒，超期 1 天黄、3 天红；要求完成日已过直接红
 *   W4 异常超期：待受理满 1 天黄；处理中/待受理过要求解决日 1 天黄、3 天红（待确认、已关闭不算）
 *   W5 发放未签收（R9）：从发放起计时，提醒 4 小时 / 黄 1 天 / 红 2 天
 *
 * 计时按自然日/小时，停工日（off_day）整天不计入；"哪一天"一律按工厂时区 Asia/Shanghai 判定。
 * 级别只升不降：阈值调大后，已经是黄的预警也不退回提醒。
 */
import type { AlertLevel } from '@prisma/client'

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
/** Asia/Shanghai 固定 UTC+8（1991 年起不用夏令时），按偏移直接算日界，比逐日调 Intl 简单 */
const TZ_OFFSET_MS = 8 * HOUR_MS

export type ScanRule = 'W1' | 'W2' | 'W3' | 'W4' | 'W5'

export interface RuleThreshold {
  /** W1、W5：提醒小时数；W3：承诺返回日前多少小时提醒（48 = 前 2 天）；W2、W4 为空（不提醒） */
  remindHours: number | null
  yellowDays: number
  redDays: number
}
export type Thresholds = Record<ScanRule, RuleThreshold>

export const DEFAULT_THRESHOLDS: Thresholds = {
  W1: { remindHours: 4, yellowDays: 1, redDays: 3 },
  W2: { remindHours: null, yellowDays: 2, redDays: 4 },
  W3: { remindHours: 48, yellowDays: 1, redDays: 3 },
  W4: { remindHours: null, yellowDays: 1, redDays: 3 },
  W5: { remindHours: 4, yellowDays: 1, redDays: 2 },
}

/** 红色时自动转为异常的规则（W4 本身就是异常，不再转；W5 未签收只升级通知，不转异常） */
export const CONVERTIBLE_RULES: ScanRule[] = ['W1', 'W2', 'W3']

/** 活动预警的唯一键（alert.activeKey），消除后置 null */
export const alertKey = (rule: ScanRule, refType: string, refId: string) => `${rule}:${refType}:${refId}`

const RANK: Record<AlertLevel, number> = { REMIND: 1, YELLOW: 2, RED: 3 }

/** 只升不降：取两者中更高的级别 */
export function maxLevel(a: AlertLevel | null, b: AlertLevel | null): AlertLevel | null {
  if (!a) return b
  if (!b) return a
  return RANK[a] >= RANK[b] ? a : b
}

export const isHigher = (next: AlertLevel, prev: AlertLevel) => RANK[next] > RANK[prev]

// ───────────── 日期与计时 ─────────────

/** 工厂时区里 t 所在的那一天，'YYYY-MM-DD' */
export function shanghaiDay(t: Date | number): string {
  return new Date(+t + TZ_OFFSET_MS).toISOString().slice(0, 10)
}

/** 工厂时区某天 00:00 的时刻（毫秒） */
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

// ───────────── 判定 ─────────────

/** W1、W2、W5：按已持续时长定级别；没到任何阈值返回 null */
export function levelByElapsed(elapsedMs: number, t: RuleThreshold): AlertLevel | null {
  if (elapsedMs >= t.redDays * DAY_MS) return 'RED'
  if (elapsedMs >= t.yellowDays * DAY_MS) return 'YELLOW'
  if (t.remindHours != null && elapsedMs >= t.remindHours * HOUR_MS) return 'REMIND'
  return null
}

export interface W3Input {
  promisedReturnDate: Date
  dueDate: Date | null
  now: Date
  offDays: Iterable<string>
}

export interface W3Result {
  level: AlertLevel | null
  /** 超出承诺返回日的天数（不含停工日） */
  overdueDays: number
  /** 距承诺返回日还有几天（自然日，已到期为 0 或负数） */
  daysLeft: number
  /** 要求完成日已过 */
  dueDatePassed: boolean
}

/**
 * W3：超期天数 = 承诺返回日之后、到今天为止（含今天）的非停工日天数。承诺日当天不算超期。
 * 提醒是"到达"类（承诺日前 N 天），按自然日，不受停工日影响（方案 6.1 注）。
 */
export function judgeW3(input: W3Input, t: RuleThreshold): W3Result {
  const today = shanghaiDay(input.now)
  const promised = dateFieldDay(input.promisedReturnDate)
  const daysLeft = dayDiff(today, promised)
  const overdueDays = overdueDaysExcludingOffDays(input.promisedReturnDate, input.now, input.offDays)
  const dueDatePassed = !!input.dueDate && dateFieldDay(input.dueDate) < today

  let level: AlertLevel | null = null
  if (dueDatePassed || overdueDays >= t.redDays) level = 'RED'
  else if (overdueDays >= t.yellowDays) level = 'YELLOW'
  else if (t.remindHours != null && daysLeft * 24 <= t.remindHours) level = 'REMIND'
  return { level, overdueDays, daysLeft, dueDatePassed }
}

/**
 * 日期字段 due（当天 UTC 零点）之后、到今天为止（含今天）的非停工日天数。当天到期算 0。W3、W4 共用。
 */
export function overdueDaysExcludingOffDays(due: Date, now: Date, offDays: Iterable<string>): number {
  const today = shanghaiDay(now)
  const d = dateFieldDay(due)
  if (dayDiff(today, d) >= 0) return 0
  return Math.round(elapsedExcludingOffDays(shanghaiDayStart(d) + DAY_MS, shanghaiDayStart(today) + DAY_MS, offDays) / DAY_MS)
}

export interface W4Input {
  status: 'OPEN' | 'ACCEPTED' | 'RESOLVED' | 'CLOSED'
  createdAt: Date
  dueDate: Date | null
  now: Date
  offDays: Iterable<string>
}

export interface W4Result {
  /** 不在 W4 关注范围（待确认、已关闭）时为 null，同时 watched = false */
  level: AlertLevel | null
  watched: boolean
  /** 待受理已持续的毫秒数（不含停工日），非待受理为 0 */
  openMs: number
  /** 超出要求解决日的天数（不含停工日），没有要求解决日为 0 */
  overdueDays: number
}

/**
 * W4 异常超期（方案 6.1）：
 *   待受理（OPEN）自创建起满 yellowDays 天（不含停工日）→ 黄；
 *   待受理/处理中（OPEN/ACCEPTED）超过要求解决日 yellowDays 天 → 黄，redDays 天 → 红；
 *   待确认（RESOLVED）、已关闭（CLOSED）不关注（待确认等的是上报人确认，不算超期）。
 */
export function judgeW4(input: W4Input, t: RuleThreshold): W4Result {
  if (input.status !== 'OPEN' && input.status !== 'ACCEPTED') return { level: null, watched: false, openMs: 0, overdueDays: 0 }
  const openMs = input.status === 'OPEN' ? elapsedExcludingOffDays(input.createdAt, input.now, input.offDays) : 0
  const overdueDays = input.dueDate ? overdueDaysExcludingOffDays(input.dueDate, input.now, input.offDays) : 0
  let level: AlertLevel | null = null
  if (overdueDays >= t.redDays) level = 'RED'
  else if (overdueDays >= t.yellowDays || openMs >= t.yellowDays * DAY_MS) level = 'YELLOW'
  return { level, watched: true, openMs, overdueDays }
}

// ───────────── 文案 ─────────────

export const LEVEL_TAG: Record<AlertLevel, string> = { REMIND: '提醒', YELLOW: '黄', RED: '红' }

/** 时长文案：不足 1 天按小时，否则按天（向下取整） */
export function durationText(ms: number): string {
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} 小时`
  return `${Math.floor(ms / DAY_MS)} 天`
}

/** 提醒标题：【黄】主梁结构件 · 涂装：组焊返厂 2 天仍未发出（DEMO-WO-001） */
export function reminderTitle(level: AlertLevel, subject: string, summary: string, workOrderNumber: string | null) {
  const title = `【${LEVEL_TAG[level]}】${subject}：${summary}${workOrderNumber ? `（${workOrderNumber}）` : ''}`
  return title.length > 190 ? `${title.slice(0, 189)}…` : title
}
