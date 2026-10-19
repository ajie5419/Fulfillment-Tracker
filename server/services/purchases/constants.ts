/**
 * 关键物料与付款（R10）的常量与纯函数：文案、到货进度、W6 判定、进货检验匹配、付款排序、延误统计。
 * 不碰数据库，便于单测。
 */
import type { AlertLevel, DelayReason, PaymentStatus, PurchaseStatus, QmsInspection } from '@prisma/client'
import { type RuleThreshold, dateFieldDay, dayDiff, overdueDaysExcludingOffDays, shanghaiDay } from '../alerts/rules'
import { inspectionWorkOrders } from '../flow/inspection'
import { BUSINESS_DEPT_NAME } from '../../../shared/business-depts'

/** 默认责任部门：采购行没指定采购负责人时，派给这个部门的负责人（notify_role DEPT_HEAD + 部门名称）。与 QMS 进货检验的责任部门一致 */
export const PURCHASE_DEPT = BUSINESS_DEPT_NAME.PURCHASE

/** 待办：工件的关键物料全部到货，给第一道工序负责人发"可以开工"（refType = part，refId = 工件 ID） */
export const READY_TO_START = 'READY_TO_START'

export const PURCHASE_STATUS_TEXT: Record<PurchaseStatus, string> = { OPEN: '未到货', ARRIVED: '已到货', CANCELLED: '已取消' }
export const DELAY_REASON_TEXT: Record<DelayReason, string> = { PAYMENT: '付款', SUPPLIER: '供应商', DEMAND_CHANGE: '我方需求变化', OTHER: '其他' }
export const PAYMENT_STATUS_TEXT: Record<PaymentStatus, string> = { PENDING: '待付', PAID: '已付', ON_HOLD: '暂缓' }

/** 一次导入最多多少行；一张付款申请最多关联多少采购行 */
export const MAX_IMPORT_ROWS = 500
export const MAX_PAYMENT_LINES = 50

export const purchaseLink = (id: string) => `/purchases?id=${encodeURIComponent(id)}`
export const purchaseMobileLink = (id: string) => `/m/arrival?id=${encodeURIComponent(id)}`

/** 工厂时区今天（存为当天 UTC 零点，与日期字段同口径） */
export const todayDate = (now: Date) => new Date(`${shanghaiDay(now)}T00:00:00.000Z`)

// ───────────── 到货进度 ─────────────

export interface LineDates {
  status: PurchaseStatus
  needDate: Date
  promisedDate: Date | null
  arrivedDate: Date | null
}

export interface LineProgress {
  /** 列表上的状态文字 */
  text: string
  /** 延误：已到货的晚于需求日或承诺到货日；未到货的已过承诺到货日或需求日 */
  late: boolean
  /** 缺料：未到货且已到需求日（需求日 ≤ 今天） */
  shortage: boolean
  /** 晚了几天（自然日，按需求日和承诺日里更早超过的那个算）；没晚为 0 */
  lateDays: number
}

/**
 * 一行的进度。"今天"按工厂时区。
 *   已取消；已到货（晚于需求日或承诺日 = 延误到货）；
 *   未到货：已到需求日 = 缺料；已过承诺日 = 超承诺日；没有承诺日 = 无承诺日；否则 待到货。
 */
export function lineProgress(l: LineDates, now: Date): LineProgress {
  if (l.status === 'CANCELLED') return { text: '已取消', late: false, shortage: false, lateDays: 0 }
  const today = shanghaiDay(now)
  const need = dateFieldDay(l.needDate)
  const promised = l.promisedDate ? dateFieldDay(l.promisedDate) : null
  const ref = l.status === 'ARRIVED' && l.arrivedDate ? dateFieldDay(l.arrivedDate) : today
  // 已到货：到货日 > 需求日/承诺日 算晚；未到货：今天 > 需求日/承诺日 才算晚（当天到期不算）
  const lateDays = Math.max(0, dayDiff(need, ref), promised ? dayDiff(promised, ref) : 0)
  if (l.status === 'ARRIVED') return { text: lateDays > 0 ? '延误到货' : '已到货', late: lateDays > 0, shortage: false, lateDays }
  const shortage = need <= today
  const text = shortage ? '缺料' : promised && promised < today ? '超承诺日' : promised ? '待到货' : '无承诺日'
  return { text, late: lateDays > 0, shortage, lateDays }
}

// ───────────── W6 ─────────────

export interface W6Input {
  needDate: Date
  promisedDate: Date | null
  now: Date
  offDays: Iterable<string>
}

export interface W6Result {
  level: AlertLevel | null
  /**
   * OVERDUE = 承诺到货日已过仍未到货；NO_PROMISE = 需求日前 N 天内仍无承诺日；
   * NEED_PASSED = 承诺日还没到、但需求日已过（承诺日晚于需求日，已经缺料）；null = 不在关注范围
   */
  trigger: 'OVERDUE' | 'NO_PROMISE' | 'NEED_PASSED' | null
  /** 超出承诺到货日的天数（不含停工日） */
  overdueDays: number
  /** 距需求日还有几天（自然日，已过为负） */
  daysLeft: number
  needPassed: boolean
}

/**
 * W6 关键物料未到货（只看未到货的采购行）：
 *   有承诺到货日：过了承诺日（超期天数不含停工日）≥ 1 天提醒、≥ 黄阈值黄、≥ 红阈值红；需求日也已过直接红。
 *   没有承诺日：距需求日 ≤ N 天（remindHours / 24，按自然日）→ 黄；需求日已过仍无承诺日 → 红。
 *   承诺日还没到：需求日也没到不预警；需求日已过（承诺日晚于需求日，已经缺料）→ 红。
 */
export function judgeW6(input: W6Input, t: RuleThreshold): W6Result {
  const today = shanghaiDay(input.now)
  const need = dateFieldDay(input.needDate)
  const daysLeft = dayDiff(today, need)
  const needPassed = daysLeft < 0
  if (input.promisedDate) {
    const overdueDays = overdueDaysExcludingOffDays(input.promisedDate, input.now, input.offDays)
    if (overdueDays <= 0) {
      // 承诺日已过但中间全是停工日：仍算"已过承诺日"，只是还不计超期天数
      const passed = dateFieldDay(input.promisedDate) < today
      if (passed) return { level: needPassed ? 'RED' : 'REMIND', trigger: 'OVERDUE', overdueDays: 0, daysLeft, needPassed }
      return needPassed
        ? { level: 'RED', trigger: 'NEED_PASSED', overdueDays: 0, daysLeft, needPassed }
        : { level: null, trigger: null, overdueDays: 0, daysLeft, needPassed }
    }
    const level: AlertLevel = needPassed || overdueDays >= t.redDays ? 'RED' : overdueDays >= t.yellowDays ? 'YELLOW' : 'REMIND'
    return { level, trigger: 'OVERDUE', overdueDays, daysLeft, needPassed }
  }
  const windowDays = (t.remindHours ?? 0) / 24
  if (daysLeft > windowDays) return { level: null, trigger: null, overdueDays: 0, daysLeft, needPassed }
  return { level: needPassed ? 'RED' : 'YELLOW', trigger: 'NO_PROMISE', overdueDays: 0, daysLeft, needPassed }
}

/** W6 提醒标题里冒号后面的部分 */
export function w6Summary(r: W6Result, l: { needDate: Date; promisedDate: Date | null; supplierName: string | null }): string {
  const need = dateFieldDay(l.needDate)
  const who = l.supplierName || '供应商'
  if (r.trigger === 'OVERDUE') {
    const late = r.overdueDays > 0 ? `已超 ${r.overdueDays} 天未到` : '已过承诺日未到'
    return `${who}承诺 ${dateFieldDay(l.promisedDate!)} 到货，${late}${r.needPassed ? `（需求日 ${need} 已过）` : ''}`
  }
  if (r.trigger === 'NEED_PASSED') return `需求日 ${need} 已过 ${-r.daysLeft} 天，${who}承诺 ${dateFieldDay(l.promisedDate!)} 才到`
  if (r.daysLeft > 0) return `需求日 ${need}（还剩 ${r.daysLeft} 天）仍无承诺到货日`
  if (r.daysLeft === 0) return `需求日就是今天（${need}），仍无承诺到货日`
  return `需求日 ${need} 已过 ${-r.daysLeft} 天，仍无承诺到货日`
}

// ───────────── QMS 进货检验自动到货 ─────────────

/** 与 QMS 的判断一致（isIncomingInspectionRequestCategory）：有分类按分类 = INCOMING；没有分类时工序名是"进货检验" */
export function isIncomingInspection(ins: { category?: string | null; processName?: string | null }): boolean {
  const category = (ins.category ?? '').trim().toUpperCase()
  if (category) return category === 'INCOMING'
  return (ins.processName ?? '').trim() === '进货检验'
}

/** 物料名称比较用：全角转半角（NFKC）、去掉所有空白、不分大小写 */
export const normalizeName = (s: string | null | undefined) => (s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()

export interface MatchableLine {
  id: string
  workOrderNumber: string
  materialName: string
  supplierId: string | null
  status: PurchaseStatus
  qmsInspectionId: string | null
  createdAt: Date
}

export type IncomingKey = Pick<QmsInspection, 'workOrderNumber' | 'partName' | 'supplierId' | 'submittedAt'> & Partial<Pick<QmsInspection, 'workOrderNumbers'>>

/**
 * 进货检验对得上的采购行（匹配规则）：
 *   未到货、没被自动到货用过（撤销过自动到货的只能手工确认）；
 *   工单：报检的任一工单（主工单 + 关联工单）；
 *   物料：报检的物料名称（partName）与采购行的物料名称相同（normalizeName 后比较）；
 *   供应商：两边都有 QMS 供应商 ID 时必须相同（手填的供应商名称不参与比较）；
 *   时间：报检提交日不早于采购行登记日（工厂时区），登记前的历史报检不算。
 * 恰好一条才自动确认到货，零条或多条留给手工确认。
 */
export function findPurchaseCandidates<T extends MatchableLine>(ins: IncomingKey, lines: T[]): T[] {
  const name = normalizeName(ins.partName)
  if (!name) return []
  const wos = inspectionWorkOrders(ins)
  const submitted = shanghaiDay(ins.submittedAt)
  return lines.filter(
    (l) =>
      l.status === 'OPEN' &&
      !l.qmsInspectionId &&
      wos.includes(l.workOrderNumber) &&
      normalizeName(l.materialName) === name &&
      !(l.supplierId && ins.supplierId && l.supplierId !== ins.supplierId) &&
      shanghaiDay(l.createdAt) <= submitted,
  )
}

// ───────────── 付款申请排序 ─────────────

export interface PaymentSortKey {
  status: PaymentStatus
  blocksDelivery: boolean
  /** 关联采购行里未到货的最近需求日；都到了（或都取消了）为 null */
  nearestNeedDate: Date | null
  requestDate: Date
  createdAt: Date
}

/**
 * 付款申请按影响排序：没付的（待付、暂缓）在前 → 卡交期的在前 → 离需求日最近的在前（没有未到货物料的排后）→ 申请日早的在前。
 */
export function comparePayments(a: PaymentSortKey, b: PaymentSortKey): number {
  const paid = (x: PaymentSortKey) => Number(x.status === 'PAID')
  const need = (x: PaymentSortKey) => (x.nearestNeedDate ? +x.nearestNeedDate : Number.POSITIVE_INFINITY)
  return (
    paid(a) - paid(b) ||
    Number(b.blocksDelivery) - Number(a.blocksDelivery) ||
    (need(a) === need(b) ? 0 : need(a) < need(b) ? -1 : 1) ||
    +a.requestDate - +b.requestDate ||
    +a.createdAt - +b.createdAt
  )
}

// ───────────── 延误统计 ─────────────

export interface DelayStats {
  /** 延误的行数（已到货晚了 + 未到货已过承诺日/需求日） */
  late: number
  /** 付款原因 */
  payment: number
  /** 管理原因 = 供应商 + 我方需求变化 + 其他 */
  management: number
  byReason: Record<DelayReason, number>
  /** 延误了但还没填原因 */
  unfilled: number
}

/** 付款原因和管理原因分开统计（延误原因 = 付款 → 付款原因；其余 → 管理原因） */
export function delayStats(rows: { late: boolean; delayReason: DelayReason | null }[]): DelayStats {
  const byReason: Record<DelayReason, number> = { PAYMENT: 0, SUPPLIER: 0, DEMAND_CHANGE: 0, OTHER: 0 }
  let late = 0
  let unfilled = 0
  for (const r of rows) {
    if (!r.late) continue
    late++
    if (r.delayReason) byReason[r.delayReason]++
    else unfilled++
  }
  return { late, payment: byReason.PAYMENT, management: byReason.SUPPLIER + byReason.DEMAND_CHANGE + byReason.OTHER, byReason, unfilled }
}

/** 数量、金额：Prisma Decimal → number（展示用） */
export const num = (d: { toString(): string } | number | null | undefined) => (d == null ? null : Number(d.toString()))
