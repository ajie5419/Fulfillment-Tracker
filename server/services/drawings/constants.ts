/**
 * 设计任务（R11）的常量与纯函数：文案、状态推导、W7 判定、逾期口径。不碰数据库，便于单测。
 */
import type { AlertLevel, DrawingTaskStatus } from '@prisma/client'
import { DAY_MS, type RuleThreshold, dateFieldDay, dayDiff, overdueDaysExcludingOffDays, shanghaiDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME } from '../../../shared/business-depts'

/** 默认责任部门：设计任务没指定设计负责人时派给这个部门的负责人（notify_role DEPT_HEAD + 部门名称）；W7 黄色起通知它的负责人 */
export const TECH_DEPT = BUSINESS_DEPT_NAME.TECH

export const DRAWING_STATUS_TEXT: Record<DrawingTaskStatus, string> = {
  PENDING: '设计中',
  DRAWN: '设计完成',
  CUSTOMER_PENDING: '待客户确认',
  DONE: '已完成',
  CANCELLED: '已取消',
}

/** 还在跟踪（未完成、未取消）的状态：挂在工件上时不发"可以开工" */
export const OPEN_DRAWING_STATUSES: DrawingTaskStatus[] = ['PENDING', 'DRAWN', 'CUSTOMER_PENDING']

export const drawingLink = (id: string) => `/drawings?id=${encodeURIComponent(id)}`
/** 手机端：带 id 时页面单独定位并展示这条任务（被升级通知的部门负责人 / PM 也能看到，不受"我的"过滤） */
export const drawingMobileLink = (id: string) => `/m/drawings?id=${encodeURIComponent(id)}`

// ───────────── 状态 ─────────────

export interface DrawingFacts {
  cancelled: boolean
  drawnDate: Date | null
  needsCustomerConfirm: boolean
  customerConfirmedDate: Date | null
  /** 有关联的、不是作废状态的发放单 */
  released: boolean
}

/**
 * 状态由事实推出（不单独维护，免得几个动作各改各的对不上）：
 *   已取消；没完成设计 = 设计中；设计完成了但图纸还没发放 = 设计完成；已发放、需要客户确认但还没确认 = 待客户确认；否则 已完成。
 * 客户确认可以在发放之前录（先给客户看、确认后再发车间），这时发放后直接 已完成。
 */
export function deriveStatus(f: DrawingFacts): DrawingTaskStatus {
  if (f.cancelled) return 'CANCELLED'
  if (!f.drawnDate) return 'PENDING'
  if (!f.released) return 'DRAWN'
  if (f.needsCustomerConfirm && !f.customerConfirmedDate) return 'CUSTOMER_PENDING'
  return 'DONE'
}

/** 能从这个任务一键发放（设计完成之后，含已完成的再发一版） */
export const canReleaseFrom = (status: DrawingTaskStatus) => status === 'DRAWN' || status === 'CUSTOMER_PENDING' || status === 'DONE'

// ───────────── W7 ─────────────

export interface W7Input {
  status: DrawingTaskStatus
  planDate: Date
  drawnDate: Date | null
  needsCustomerConfirm: boolean
  customerPlanDate: Date | null
  customerConfirmedDate: Date | null
  now: Date
  offDays: Iterable<string>
}

export interface W7Result {
  level: AlertLevel | null
  /**
   * DRAW_DUE = 计划完成日前 N 天内仍未完成设计；DRAW_OVERDUE = 已过计划完成日仍未完成设计；
   * CONFIRM_OVERDUE = 设计完成、需要客户确认，超过客户确认计划日仍未确认；null = 不在关注范围
   */
  trigger: 'DRAW_DUE' | 'DRAW_OVERDUE' | 'CONFIRM_OVERDUE' | null
  /** 超出计划日（设计或客户确认）的天数，不含停工日 */
  overdueDays: number
  /** 距计划完成日还有几天（自然日，已过为负）；客户确认时是距客户确认计划日 */
  daysLeft: number
}

const NONE = (daysLeft = 0): W7Result => ({ level: null, trigger: null, overdueDays: 0, daysLeft })

/**
 * W7 设计逾期（只看未完成、未取消的任务）：
 *   没完成设计：距计划完成日 ≤ N 天（remindHours / 24，自然日，当天也算）→ 黄；已过计划完成日 → 红
 *     （与 W6 一致，超期天数不含停工日；已过但中间全是停工日时还不计超期，先保持黄）。
 *   设计完成、需要客户确认、还没确认、有客户确认计划日：超过计划日（不含停工日）≥ 黄阈值 → 黄，≥ 红阈值 → 红。
 * 不转异常。
 */
export function judgeW7(input: W7Input, t: RuleThreshold): W7Result {
  if (input.status === 'DONE' || input.status === 'CANCELLED') return NONE()
  const today = shanghaiDay(input.now)
  if (!input.drawnDate) {
    const daysLeft = dayDiff(today, dateFieldDay(input.planDate))
    if (daysLeft < 0) {
      const overdueDays = overdueDaysExcludingOffDays(input.planDate, input.now, input.offDays)
      return { level: overdueDays >= 1 ? 'RED' : 'YELLOW', trigger: 'DRAW_OVERDUE', overdueDays, daysLeft }
    }
    const windowDays = (t.remindHours ?? 0) / 24
    if (daysLeft <= windowDays) return { level: 'YELLOW', trigger: 'DRAW_DUE', overdueDays: 0, daysLeft }
    return NONE(daysLeft)
  }
  if (!input.needsCustomerConfirm || input.customerConfirmedDate || !input.customerPlanDate) return NONE()
  const daysLeft = dayDiff(today, dateFieldDay(input.customerPlanDate))
  const overdueDays = overdueDaysExcludingOffDays(input.customerPlanDate, input.now, input.offDays)
  const level: AlertLevel | null = overdueDays >= t.redDays ? 'RED' : overdueDays >= t.yellowDays ? 'YELLOW' : null
  return level ? { level, trigger: 'CONFIRM_OVERDUE', overdueDays, daysLeft } : NONE(daysLeft)
}

/** W7 提醒标题里冒号后面的部分 */
export function w7Summary(r: W7Result, task: { planDate: Date; customerPlanDate: Date | null }, ownerName: string): string {
  const plan = dateFieldDay(task.planDate)
  if (r.trigger === 'DRAW_OVERDUE') return `计划 ${plan} 完成，${r.overdueDays > 0 ? `已超 ${r.overdueDays} 天` : '已过计划日'}仍未完成设计（${ownerName}）`
  if (r.trigger === 'DRAW_DUE') return `计划 ${plan} 完成，${r.daysLeft > 0 ? `还剩 ${r.daysLeft} 天` : '就是今天'}，仍未完成设计（${ownerName}）`
  if (r.trigger === 'CONFIRM_OVERDUE') return `客户确认计划 ${dateFieldDay(task.customerPlanDate!)}，已超 ${r.overdueDays} 天仍未确认（${ownerName}）`
  return ''
}

// ───────────── 逾期口径（列表筛选、设计负荷、看板、每日汇总共用）─────────────

export interface OverdueFacts {
  status: DrawingTaskStatus
  planDate: Date
  needsCustomerConfirm: boolean
  customerPlanDate: Date | null
  customerConfirmedDate: Date | null
}

/**
 * 设计逾期：设计中且已过计划完成日；或设计完成、需要客户确认、还没确认且已过客户确认计划日（自然日，当天到期不算）。
 * 与数据库筛选 services/drawings/drawings.ts overdueWhere 一致。
 */
export function isOverdue(t: OverdueFacts, now: Date): boolean {
  const today = shanghaiDay(now)
  if (t.status === 'PENDING') return dateFieldDay(t.planDate) < today
  if (t.status === 'DRAWN' || t.status === 'CUSTOMER_PENDING') {
    return t.needsCustomerConfirm && !t.customerConfirmedDate && !!t.customerPlanDate && dateFieldDay(t.customerPlanDate) < today
  }
  return false
}

/** 工厂时区本周一、本周日（存为当天 UTC 零点，与日期字段同口径） */
export function thisWeek(now: Date): { monday: Date; sunday: Date } {
  const today = Date.parse(`${shanghaiDay(now)}T00:00:00.000Z`)
  const dow = (new Date(today).getUTCDay() + 6) % 7 // 周一 = 0
  return { monday: new Date(today - dow * DAY_MS), sunday: new Date(today + (6 - dow) * DAY_MS) }
}
