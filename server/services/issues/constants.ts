/** 异常模块的常量与纯函数：分类、默认责任部门（方案 6.4）、编号、默认要求解决日。不碰数据库，便于单测。 */
import type { IssueCategory, IssueSource, IssueStatus } from '@prisma/client'
import { DAY_MS, shanghaiDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME, type BusinessDeptCode } from '../../../shared/business-depts'

export const CATEGORY_TEXT: Record<IssueCategory, string> = {
  DESIGN: '设计',
  CHANGE: '变更',
  MATERIAL_PAYMENT: '物料-付款原因',
  MATERIAL_MGMT: '物料-管理原因',
  OUTSOURCE_SCHEDULE: '外协-进度',
  OUTSOURCE_QUALITY: '外协-质量',
  WORKSHOP: '车间',
  CUSTOMER: '客户',
  OTHER: '其他',
}

/** 按分类默认的责任部门（业务部门编码，方案 6.4） */
export const DEFAULT_DEPT: Record<IssueCategory, BusinessDeptCode> = {
  DESIGN: 'TECH',
  CHANGE: 'TECH',
  MATERIAL_PAYMENT: 'FINANCE',
  MATERIAL_MGMT: 'PURCHASE',
  OUTSOURCE_SCHEDULE: 'PRODUCTION',
  OUTSOURCE_QUALITY: 'QUALITY',
  WORKSHOP: 'PRODUCTION',
  CUSTOMER: 'PROJECT',
  OTHER: 'PROJECT',
}

/** 按分类默认的责任部门名称（按名称匹配 qms_department.name / 换算后的业务部门名） */
export const DEFAULT_DEPT_NAME = Object.fromEntries(
  Object.entries(DEFAULT_DEPT).map(([c, d]) => [c, BUSINESS_DEPT_NAME[d]]),
) as Record<IssueCategory, string>

/** 可以指定外协单位（责任方）的分类 */
export const SUPPLIER_CATEGORIES: IssueCategory[] = ['OUTSOURCE_SCHEDULE', 'OUTSOURCE_QUALITY']

export const STATUS_TEXT: Record<IssueStatus, string> = { OPEN: '待受理', ACCEPTED: '处理中', RESOLVED: '待确认', CLOSED: '已关闭' }
export const SOURCE_TEXT: Record<IssueSource, string> = { MANUAL: '手工上报', ALERT: '预警转入', QMS_NONCONFORMING: 'QMS 不合格', SCRAP: '完工报废' }

/** 未关闭的状态 */
export const OPEN_STATUSES: IssueStatus[] = ['OPEN', 'ACCEPTED', 'RESOLVED']

/** 异常关联对象类型（issue.refType） */
export type IssueRefType = 'PART' | 'STEP' | 'UNMATCHED'

/** 编号前缀：YC-YYMMDD-（工厂时区当天） */
export function issueNoPrefix(now: Date): string {
  return `YC-${shanghaiDay(now).slice(2).replaceAll('-', '')}-`
}

/** 当天第 seq 个编号，序号至少 3 位 */
export const formatIssueNo = (prefix: string, seq: number) => `${prefix}${String(seq).padStart(3, '0')}`

/** 已有的最大编号 → 下一个序号 */
export function nextSeq(prefix: string, maxIssueNo: string | null): number {
  if (!maxIssueNo?.startsWith(prefix)) return 1
  const n = Number.parseInt(maxIssueNo.slice(prefix.length), 10)
  return Number.isFinite(n) ? n + 1 : 1
}

/**
 * 受理时没有要求解决日的默认值：受理时刻（工厂时区）当天 + 3 天。
 * 要求解决日与其他日期字段一样只存"哪一天"（当天 UTC 零点），含义是"当天 24:00 前解决"，
 * 所以过了这一天（工厂时区）才算超期。
 */
export function defaultDueDate(now: Date): Date {
  return new Date(`${shanghaiDay(+now + 3 * DAY_MS)}T00:00:00.000Z`)
}
