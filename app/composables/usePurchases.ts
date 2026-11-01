import { PURCHASE_STATUS_TEXT as SHARED_PURCHASE_STATUS_TEXT, DELAY_REASON_TEXT as SHARED_DELAY_REASON_TEXT, PAYMENT_STATUS_TEXT as SHARED_PAYMENT_STATUS_TEXT } from '#shared/purchases'
/** 关键物料与付款（R10）页面共用：文案、颜色、接口调用。 */

export const PURCHASE_STATUS_TEXT = SHARED_PURCHASE_STATUS_TEXT
export const DELAY_REASON_TEXT = SHARED_DELAY_REASON_TEXT
export const DELAY_REASON_OPTIONS = Object.entries(DELAY_REASON_TEXT).map(([value, label]) => ({ value, label }))
export const PAYMENT_STATUS_TEXT = SHARED_PAYMENT_STATUS_TEXT
export const PAYMENT_STATUS_COLOR = { PENDING: 'orange', PAID: 'green', ON_HOLD: 'default' } as const
/** 列表进度文字（服务端 lineProgress）的颜色 */
export const PURCHASE_PROGRESS_COLOR: Record<string, string> = {
  缺料: 'red',
  超承诺日: 'red',
  无承诺日: 'orange',
  待到货: 'blue',
  已到货: 'green',
  延误到货: 'gold',
  已取消: 'default',
}
/** Vant 标签类型 */
export const PURCHASE_PROGRESS_TYPE: Record<string, 'danger' | 'warning' | 'primary' | 'success' | 'default'> = {
  缺料: 'danger',
  超承诺日: 'danger',
  无承诺日: 'warning',
  待到货: 'primary',
  已到货: 'success',
  延误到货: 'warning',
  已取消: 'default',
}

export type DelayReasonKey = keyof typeof DELAY_REASON_TEXT
export type PaymentStatusKey = keyof typeof PAYMENT_STATUS_TEXT

/** 采购行（GET /api/purchases 的 rows、GET /api/purchases/:id） */
export interface PurchaseRow {
  id: string
  workOrderNumber: string
  partId: string | null
  partName: string | null
  materialName: string
  spec: string | null
  quantity: number
  unit: string | null
  supplierId: string | null
  supplierName: string | null
  needDate: string
  promisedDate: string | null
  arrivedDate: string | null
  status: keyof typeof PURCHASE_STATUS_TEXT
  buyerId: string | null
  buyerName: string | null
  ownerText: string
  delayReason: DelayReasonKey | null
  delayReasonText: string | null
  delayNote: string | null
  note: string | null
  arrivalSource: 'MOBILE' | 'PC' | 'QMS_INSPECTION' | null
  arrivedByName: string | null
  arrivedAt: string | null
  qmsInspectionId: string | null
  progressText: string
  late: boolean
  shortage: boolean
  lateDays: number
  payments: { id: string; status: PaymentStatusKey; statusText: string; blocksDelivery: boolean; amount: number | null }[]
  blockedByPayment: boolean
  alertLevel: 'REMIND' | 'YELLOW' | 'RED' | null
  /** 所属总计划节点（R14） */
  planNodeId: string | null
  /** 所属总计划节点的序号、名称（列表"总计划节点"列） */
  planNode: { id: string; seq: number; name: string } | null
  projectName?: string | null
  customerName?: string | null
}

export interface PurchasePage {
  rows: PurchaseRow[]
  total: number
  page: number
  pageSize: number
  stats: PurchaseStats
  groups: Record<string, { done: number; total: number; count: number }>
}

export interface PurchaseOption {
  id: string
  workOrderNumber: string
  materialName: string
  spec: string | null
  supplierName: string | null
  needDate: string
}

export interface PurchaseStats {
  open: number
  shortage: number
  noPromise: number
  arrived: number
  blockedByPayment: number
  delay: { late: number; payment: number; management: number; byReason: Record<DelayReasonKey, number>; unfilled: number }
}

/** 绕开 Nitro 路由类型推导（路由多了以后会"类型递归过深"） */
export function purchaseSend<T = unknown>(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: object): Promise<T> {
  const send = $fetch as unknown as (u: string, o: { method: string; body?: object }) => Promise<T>
  return send(url, { method, body })
}

export function fetchPurchase(id: string) {
  const get = $fetch as unknown as (u: string) => Promise<PurchaseRow>
  return get(`/api/purchases/${encodeURIComponent(id)}`)
}

/** 金额：千分位，两位小数 */
/** 金额；null = 无权查看（接口按权限去掉了，权限方案 R13），显示"—" */
export const moneyText = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
/** 金额带单位；无权查看时只显示"—" */
export const moneyWithUnit = (n: number | null | undefined) => (n == null ? '—' : `${moneyText(n)} 元`)
/** 数量 + 单位 */
export const qtyText = (r: { quantity: number | null; unit: string | null }) => `${r.quantity ?? ''}${r.unit ? ` ${r.unit}` : ''}`
