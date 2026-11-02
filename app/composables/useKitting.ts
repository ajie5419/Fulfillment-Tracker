import type { ClientBodyArgs, ClientMethod, ClientResponse } from '../utils/transport'
/** 齐套（R12）页面共用：类型、文案、接口调用。 */

/** 缺件（GET /api/kitting 的 rows[].shortages） */
export interface KitShortage {
  kind: 'part' | 'purchase'
  id: string
  name: string
  /** 工件：当前工序名；物料：采购状态（缺料 / 超承诺日 / 待到货 / 无承诺日） */
  stage: string | null
  /** 卡在哪一步 */
  reason: string
  reasonCode: string
  detail: string | null
  needDate?: string
  promisedDate?: string | null
  overdue?: boolean
  lateForNode?: boolean
}

/** 装配节点（GET /api/kitting 的 rows、GET /api/kitting/:id） */
export interface KitNode {
  id: string
  workOrderNumber: string
  name: string
  needDate: string
  ownerId: string | null
  ownerName: string | null
  ownerText: string
  note: string | null
  sortOrder: number
  partIds: string[]
  purchaseIds: string[]
  /** 距需求日还有几天（工厂时区自然日，已过为负） */
  daysLeft: number
  total: number
  ready: number
  /** 齐套率（0–100，向下取整）；清单为空为 null */
  percent: number | null
  incomplete: boolean
  shortages: KitShortage[]
  readyItems: string[]
  excluded: string[]
  alertLevel: 'REMIND' | 'YELLOW' | 'RED' | null
  canEdit: boolean
  /** 所属总计划节点（R14） */
  planNodeId: string | null
  /** 所属总计划节点的序号、名称（列表"总计划节点"列） */
  planNode: { id: string; seq: number; name: string } | null
}

export interface KitStats {
  all: number
  incomplete: number
  /** 未齐套且已进入 W8 预警窗口（需求日前 windowDays 天内，含已过） */
  dueSoon: number
  windowDays: number
  /** W8 阈值：需求日前几天黄 / 红（设置页可改） */
  yellowDays: number
  redDays: number
}

export interface KitList {
  rows: KitNode[]
  total: number
  stats: KitStats | null
  canCreate: boolean
}

/** 缺件原因的颜色（AntDV tag） */
export const BLOCKER_COLOR: Record<string, string> = {
  NO_ROUTE: 'default',
  HOLD: 'purple',
  DRAWING: 'volcano',
  MATERIAL: 'orange',
  BLOCKED: 'red',
  OUT: 'cyan',
  IN_PROGRESS: 'blue',
  PENDING: 'default',
  STEPS_DONE: 'green',
  NOT_ARRIVED: 'orange',
}

/** 需求日还剩几天的文字 */
export function daysLeftText(n: number) {
  return n > 0 ? `还剩 ${n} 天` : n === 0 ? '就是今天' : `已过 ${-n} 天`
}

/** 进度条状态：齐了 success，红色预警 exception，其余 normal */
export function kitProgressStatus(n: Pick<KitNode, 'incomplete' | 'alertLevel' | 'percent'>) {
  if (n.percent === 100 && !n.incomplete) return 'success' as const
  if (n.alertLevel === 'RED') return 'exception' as const
  return 'normal' as const
}

/** 端点契约来自原有 schema 与响应，调用者不能指定返回类型。 */
export function kittingSend<P extends `/api/kitting${string}`, M extends ClientMethod<P> & ('POST' | 'PATCH' | 'DELETE')>(url: P, method: M, ...args: ClientBodyArgs<P, M>): Promise<ClientResponse<P, M>>
export function kittingSend(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  return sendClientRequest(url, { method, body })
}

export function fetchKitNode(id: string) {
  return clientRequest(`/api/kitting/${encodeURIComponent(id)}`)
}
