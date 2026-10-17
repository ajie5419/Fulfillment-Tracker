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
}

export interface KitStats {
  all: number
  incomplete: number
  /** 未齐套且已进入 W8 预警窗口（需求日前 windowDays 天内，含已过） */
  dueSoon: number
  windowDays: number
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
  DRAWING: 'magenta',
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

/** 绕开 Nitro 路由类型推导（路由多了以后会"类型递归过深"） */
export function kittingSend<T = { id: string }>(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: object): Promise<T> {
  const send = $fetch as unknown as (u: string, o: { method: string; body?: object }) => Promise<T>
  return send(url, { method, body })
}

export function fetchKitNode(id: string) {
  const get = $fetch as unknown as (u: string) => Promise<KitNode>
  return get(`/api/kitting/${encodeURIComponent(id)}`)
}
