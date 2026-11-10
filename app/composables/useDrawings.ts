import type { ClientBodyArgs, ClientMethod, ClientResponse } from '../utils/transport'
import { DRAWING_STATUS_TEXT as SHARED_DRAWING_STATUS_TEXT } from '#shared/drawing'
/** 设计任务（R11）页面共用：文案、颜色、接口调用。 */

export const DRAWING_STATUS_TEXT = SHARED_DRAWING_STATUS_TEXT
export const DRAWING_STATUS_COLOR = { PENDING: 'blue', DRAWN: 'orange', CUSTOMER_PENDING: 'purple', DONE: 'green', CANCELLED: 'default' } as const
/** Vant 标签类型 */
export const DRAWING_STATUS_TYPE = { PENDING: 'primary', DRAWN: 'success', CUSTOMER_PENDING: 'warning', DONE: 'success', CANCELLED: 'default' } as const

export type DrawingStatusKey = keyof typeof DRAWING_STATUS_TEXT

/** Derive JSON fields from the endpoint, including dates and confirmation details. */
export type DrawingList = ClientResponse<'/api/drawings', 'GET'>
export type DrawingRow = DrawingList['rows'][number]
export type DrawingStats = DrawingList['stats']
export type DrawingResult = ClientResponse<'/api/drawings/:id/drawn', 'POST'>

/** 端点契约来自原有 schema 与响应，调用者不能指定返回类型。 */
export function drawingSend<P extends `/api/drawings${string}`, M extends ClientMethod<P> & ('POST' | 'PATCH')>(url: P, method: M, ...args: ClientBodyArgs<P, M>): Promise<ClientResponse<P, M>>
export function drawingSend(url: string, method: 'POST' | 'PATCH', body: unknown = {}) {
  return sendClientRequest(url, { method, body })
}

export function fetchDrawing(id: string) {
  return clientRequest(`/api/drawings/${encodeURIComponent(id)}`)
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
