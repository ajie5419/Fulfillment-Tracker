/** 设计任务（R11）页面共用：文案、颜色、接口调用。 */

export const DRAWING_STATUS_TEXT = { PENDING: '设计中', DRAWN: '设计完成', CUSTOMER_PENDING: '待客户确认', DONE: '已完成', CANCELLED: '已取消' } as const
export const DRAWING_STATUS_COLOR = { PENDING: 'blue', DRAWN: 'cyan', CUSTOMER_PENDING: 'purple', DONE: 'green', CANCELLED: 'default' } as const
/** Vant 标签类型 */
export const DRAWING_STATUS_TYPE = { PENDING: 'primary', DRAWN: 'success', CUSTOMER_PENDING: 'warning', DONE: 'success', CANCELLED: 'default' } as const

export type DrawingStatusKey = keyof typeof DRAWING_STATUS_TEXT

/** 设计任务（GET /api/drawings 的 rows、GET /api/drawings/:id） */
export interface DrawingRow {
  id: string
  workOrderNumber: string
  componentName: string
  ownerId: string | null
  ownerName: string | null
  ownerText: string
  planDate: string
  drawnDate: string | null
  drawnByName: string | null
  needsCustomerConfirm: boolean
  customerPlanDate: string | null
  customerConfirmedDate: string | null
  customerConfirmedByName: string | null
  status: DrawingStatusKey
  statusText: string
  /** 工艺模块：料单 / 工艺状态 */
  materialStatus: 'NOT_STARTED' | 'DRAFTING' | 'REVISING' | 'ISSUED'
  processStatus: 'NONE' | 'DRAFTING' | 'REVISING' | 'ISSUED'
  /** 料单未开始 · 工艺无 */
  processText: string
  note: string | null
  partIds: string[]
  parts: { id: string; name: string }[]
  /** 所属总计划节点（R14） */
  planNodeId: string | null
  /** 所属总计划节点的序号、名称（列表"总计划节点"列） */
  planNode: { id: string; seq: number; name: string } | null
  overdue: boolean
  releases: { id: string; releaseNo: string; typeText: string; status: 'ACTIVE' | 'VOID'; version: string | null }[]
  alertLevel: 'REMIND' | 'YELLOW' | 'RED' | null
  permissions: { markDrawn: boolean; undoDrawn: boolean; confirm: boolean; release: boolean }
}

export interface DrawingStats {
  pending: number
  drawn: number
  customerPending: number
  overdue: number
  dueThisWeek: number
}

export interface DrawingResult {
  id: string
  status: DrawingStatusKey
  readySent: number
}

/** 绕开 Nitro 路由类型推导（路由多了以后会"类型递归过深"） */
export function drawingSend<T = DrawingResult>(url: string, method: 'POST' | 'PATCH', body: object = {}): Promise<T> {
  const send = $fetch as unknown as (u: string, o: { method: string; body?: object }) => Promise<T>
  return send(url, { method, body })
}

export function fetchDrawing(id: string) {
  const get = $fetch as unknown as (u: string) => Promise<DrawingRow>
  return get(`/api/drawings/${encodeURIComponent(id)}`)
}

/** 操作结果提示：状态变成什么、有没有因此发"可以开工" */
export function drawingResultText(r: DrawingResult, done: string) {
  const ready = r.readySent ? `；${r.readySent} 个工件的物料和图纸已齐，已通知"可以开工"` : ''
  return `${done}，现在是"${DRAWING_STATUS_TEXT[r.status]}"${ready}`
}

/** 一键发放的预填：类型图纸、工单、关联工件、说明 */
export function releasePrefillOf(r: DrawingRow): ReleasePrefill {
  return {
    type: 'DRAWING',
    workOrderNumber: r.workOrderNumber,
    partIds: r.partIds,
    description: `${r.componentName} 图纸发放${r.drawnDate ? `（${dayText(r.drawnDate)} 设计完成）` : ''}${r.parts.length ? `；工件：${r.parts.map((p) => p.name).join('、')}` : ''}`,
    drawingTaskId: r.id,
    label: `设计任务：${r.componentName}`,
  }
}
