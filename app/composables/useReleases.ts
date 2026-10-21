/** 发放签收（R9）页面共用：文案、颜色、提交、上传附件。 */

export const RELEASE_TYPE_TEXT = { DRAWING: '图纸', CHANGE: '设计变更', PROCESS: '工艺文件' } as const
export const RELEASE_TYPE_COLOR = { DRAWING: 'blue', CHANGE: 'volcano', PROCESS: 'cyan' } as const
export const RECEIPT_STATUS_TEXT = { PENDING: '待签收', SIGNED: '已签收', REJECTED: '已拒收', CANCELLED: '已作废' } as const
export const RECEIPT_STATUS_COLOR = { PENDING: 'orange', SIGNED: 'green', REJECTED: 'red', CANCELLED: 'default' } as const
/** Vant 标签类型 */
export const RECEIPT_STATUS_TYPE = { PENDING: 'warning', SIGNED: 'success', REJECTED: 'danger', CANCELLED: 'default' } as const
/** 列表状态（progressText）的颜色 */
export const PROGRESS_COLOR: Record<string, string> = { 签收中: 'orange', 有拒收: 'red', 已全部签收: 'green', 已作废: 'default' }
/** 按"部门 + 角色"选人时的角色（与设置页"人员与角色"一致）；空 = 该部门全部人员 */
export const RECIPIENT_ROLE_OPTIONS = [
  { value: '', label: '全部人员' },
  { value: 'DEPT_HEAD', label: '部门负责人' },
  { value: 'OUTSOURCE_COORDINATOR', label: '外协专员' },
  { value: 'PROJECT_DEPT_HEAD', label: '项目部负责人' },
  { value: 'LEADER', label: '分管领导' },
] as const

export type ReleaseTypeKey = keyof typeof RELEASE_TYPE_TEXT

/** 新建发放单弹窗的预填（R11 设计任务一键发放） */
export interface ReleasePrefill {
  type?: ReleaseTypeKey
  workOrderNumber: string
  partIds?: string[]
  description?: string
  drawingTaskId?: string
  /** 弹窗标题里的说明，如"设计任务：主梁总图" */
  label?: string
}

export type ReceiptStatusKey = keyof typeof RECEIPT_STATUS_TEXT

/** 附件上限（与服务端一致），选择时先拦一道 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENTS = 5

/** POST 发放相关接口；绕开 Nitro 路由类型推导（路由多了以后会"类型递归过深"） */
export function releasePost<T = unknown>(url: string, body: object = {}): Promise<T> {
  const send = $fetch as unknown as (u: string, o: { method: 'POST'; body: object }) => Promise<T>
  return send(url, { method: 'POST', body })
}

/** 上传附件（PDF 或照片，multipart 字段 file），每次最多 3 个，分批传，返回 upload_file id */
export async function uploadAttachments(files: File[]): Promise<string[]> {
  const send = $fetch as unknown as (url: string, opts: { method: 'POST'; body: FormData }) => Promise<{ id: string }[]>
  const ids: string[] = []
  for (let i = 0; i < files.length; i += 3) {
    const form = new FormData()
    for (const f of files.slice(i, i + 3)) form.append('file', f, f.name || 'file')
    const saved = await send('/api/uploads?kind=attachment', { method: 'POST', body: form })
    ids.push(...saved.map((s) => s.id))
  }
  return ids
}

export const isImage = (mime: string) => mime.startsWith('image/')
export const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** 发放单详情（GET /api/releases/:id 的返回） */
export interface ReleaseDetail {
  id: string
  releaseNo: string
  type: ReleaseTypeKey
  typeText: string
  workOrderNumber: string
  projectName: string | null
  customerName: string | null
  version: string | null
  description: string
  status: 'ACTIVE' | 'VOID'
  issuerId: string
  issuerName: string | null
  createdAt: string
  counts: Record<ReceiptStatusKey, number>
  progressText: string
  attachments: { id: string; mime: string; size: number; url: string }[]
  receipts: { id: string; userId: string; userName: string | null; department: string | null; status: ReceiptStatusKey; statusText: string; reason: string | null; actedAt: string | null }[]
  myReceipt: { id: string; status: ReceiptStatusKey; reason: string | null; actedAt: string | null } | null
  parts: {
    id: string
    name: string
    drawingNo: string | null
    steps: { id: string; seq: number; processName: string; supplierName: string | null; mode: string; status: string; statusText: string; held: boolean; heldByOther: boolean }[]
  }[]
  missingParts: number
  change: {
    heldSteps: number
    confirmers: { userId: string; userName: string | null; status: string }[]
    confirmedAt: string | null
    confirmedByName: string | null
    confirmNote: string | null
    needsConfirm: boolean
  } | null
  permissions: { sign: boolean; void: boolean; confirmChange: boolean }
}

export function fetchRelease(id: string) {
  const get = $fetch as unknown as (u: string) => Promise<ReleaseDetail>
  return get(`/api/releases/${encodeURIComponent(id)}`)
}
