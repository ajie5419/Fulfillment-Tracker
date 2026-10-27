/** 工艺模块（料单、工艺状态，10-27）页面共用：文案、状态色、接口调用。与 server/services/process/constants.ts 一致 */

export type MaterialStatusKey = 'NOT_STARTED' | 'DRAFTING' | 'REVISING' | 'ISSUED'
export type ProcessStatusKey = 'NONE' | 'DRAFTING' | 'ISSUED'
export type ProcessKind = 'MATERIAL' | 'PROCESS'
export type ProcessAction = 'start' | 'issue' | 'revise' | 'reset'

export const MATERIAL_STATUS_TEXT: Record<MaterialStatusKey, string> = { NOT_STARTED: '未开始', DRAFTING: '编制中', REVISING: '修改中', ISSUED: '已下发' }
export const PROCESS_STATUS_TEXT: Record<ProcessStatusKey, string> = { NONE: '无', DRAFTING: '编制中', ISSUED: '已下发' }

export const PROCESS_KIND_TEXT: Record<ProcessKind, string> = { MATERIAL: '料单', PROCESS: '工艺' }

type Tone = 'late' | 'risk' | 'done' | 'upstream' | 'none' | 'primary'
/** 状态胶囊的颜色：修改中 = 延误红（下发的料单作废待改），编制中 = 主色，已下发 = 完成绿，未开始 / 无 = 灰 */
export const MATERIAL_TONE: Record<MaterialStatusKey, Tone> = { NOT_STARTED: 'none', DRAFTING: 'primary', REVISING: 'late', ISSUED: 'done' }
export const PROCESS_TONE: Record<ProcessStatusKey, Tone> = { NONE: 'none', DRAFTING: 'primary', ISSUED: 'done' }

/** 按钮文字（料单 / 工艺各一套） */
export function actionLabel(kind: ProcessKind, a: ProcessAction) {
  const what = PROCESS_KIND_TEXT[kind]
  return { start: `开始编制`, issue: `下发${what}`, revise: `修改${what}`, reset: '撤回编制' }[a]
}

/** GET /api/process 的 rows */
export interface ProcessRow {
  id: string
  workOrderNumber: string
  componentName: string
  drawingStatus: DrawingStatusKey
  drawingStatusText: string
  drawingRelease: { id: string; releaseNo: string; at: string } | null
  partIds: string[]
  parts: { id: string; name: string }[]
  planNode: { id: string; seq: number; name: string } | null
  materialStatus: MaterialStatusKey
  materialStatusText: string
  materialAt: string | null
  materialByName: string | null
  processStatus: ProcessStatusKey
  processStatusText: string
  processAt: string | null
  processByName: string | null
  actions: { material: ProcessAction[]; process: ProcessAction[] }
}

export interface ProcessStats {
  waiting: number
  drafting: number
  revising: number
  materialIssued: number
  processDrafting: number
  processIssued: number
  total: number
}

export interface ProcessLog {
  id: string
  kind: ProcessKind
  kindText: string
  fromText: string
  toText: string
  note: string | null
  actorName: string
  release: { id: string; releaseNo: string | null } | null
  auto: boolean
  createdAt: string
}

/** 绕开 Nitro 路由类型推导（路由多了以后会"类型递归过深"） */
export function processAction(id: string, body: { kind: ProcessKind; action: ProcessAction; note?: string | null }) {
  const send = $fetch as unknown as (u: string, o: { method: string; body: object }) => Promise<{ id: string; status: string; statusText: string }>
  return send(`/api/process/${encodeURIComponent(id)}/action`, { method: 'POST', body })
}

export function fetchProcessLogs(id: string) {
  const get = $fetch as unknown as (u: string) => Promise<{ id: string; componentName: string; workOrderNumber: string; logs: ProcessLog[] }>
  return get(`/api/process/${encodeURIComponent(id)}/logs`)
}

/** 下发后顺手建发放单（工艺文件类型）让车间签收：预填工单、关联工件、说明 */
export function processReleasePrefill(r: ProcessRow, kind: ProcessKind): ReleasePrefill {
  const what = kind === 'MATERIAL' ? '料单' : '工艺文件'
  return {
    type: 'PROCESS',
    workOrderNumber: r.workOrderNumber,
    partIds: r.partIds,
    description: `${r.componentName} ${what}下发${r.parts.length ? `；工件：${r.parts.map((p) => p.name).join('、')}` : ''}`,
    label: `${PROCESS_KIND_TEXT[kind]}：${r.componentName}`,
  }
}
