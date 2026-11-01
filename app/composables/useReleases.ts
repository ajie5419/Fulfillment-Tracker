import type { ClientBodyArgs, ClientResponse, ClientFetch, ClientPath } from '../utils/transport'
import { RELEASE_TYPE_TEXT as SHARED_RELEASE_TYPE_TEXT, RECEIPT_STATUS_TEXT as SHARED_RECEIPT_STATUS_TEXT } from '#shared/releases'
/** 发放签收（R9）页面共用：文案、颜色、提交、上传附件。 */
import { MAX_ATTACHMENT_BYTES as SHARED_MAX_ATTACHMENT_BYTES, MAX_RELEASE_ATTACHMENTS } from '#shared/upload-policy'

export const RELEASE_TYPE_TEXT = SHARED_RELEASE_TYPE_TEXT
export const RELEASE_TYPE_COLOR = { DRAWING: 'blue', CHANGE: 'volcano', PROCESS: 'default' } as const
export const RECEIPT_STATUS_TEXT = SHARED_RECEIPT_STATUS_TEXT
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
export const MAX_ATTACHMENT_BYTES = SHARED_MAX_ATTACHMENT_BYTES
export const MAX_ATTACHMENTS = MAX_RELEASE_ATTACHMENTS

/** 发放写请求只接受既有端点及其输入类型。 */
export function releasePost<const P extends (`/api/releases${string}` | `/api/receipts${string}`) & ClientPath<'POST'>>(url: P, ...args: ClientBodyArgs<P, 'POST'>): Promise<ClientResponse<P, 'POST'>>
export function releasePost(url: string, body: unknown = {}) {
  return sendClientRequest(url, { method: 'POST', body })
}

/** 上传附件（PDF 或照片，multipart 字段 file），每次最多 3 个，分批传，返回 upload_file id */
export async function uploadAttachments(files: File[]): Promise<string[]> {
  const send = clientRequest
  const ids: string[] = []
  for (let i = 0; i < files.length; i += 3) {
    const form = new FormData()
    for (const f of files.slice(i, i + 3)) form.append('file', f, f.name || 'file')
    const saved = await send('/api/uploads?kind=attachment', { method: 'POST', body: form })
    ids.push(...saved.map((s) => s.id))
  }
  return ids
}

/** 上传图纸发放单要附的 BOM 表（.xlsx），返回 upload_file.id */
export async function uploadBomFile(file: File): Promise<string> {
  const send = clientRequest
  const form = new FormData()
  form.append('file', file, file.name || 'bom.xlsx')
  const [saved] = await send('/api/uploads?kind=bom', { method: 'POST', body: form })
  return saved!.id
}

export const isImage = (mime: string) => mime.startsWith('image/')
/** 工件名列表：附 BOM 的发放单 / 设计任务可能挂上百个工件，列表里只列前几个 */
export const partsText = (names: string[], max = 3) => (names.length > max ? `${names.slice(0, max).join('、')} 等 ${names.length} 个` : names.join('、'))

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
  /** 附的 BOM 表（Excel，下载）；parts 里是发放时按它建好、关联的工件 */
  bomFile: { id: string; mime: string; size: number; url: string } | null
  receipts: { id: string; userId: string; userName: string | null; department: string | null; status: ReceiptStatusKey; statusText: string; reason: string | null; actedAt: string | null }[]
  myReceipt: { id: string; status: ReceiptStatusKey; reason: string | null; actedAt: string | null } | null
  parts: {
    id: string
    name: string
    drawingNo: string | null
    revision: string | null
    quantity: number
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

export function fetchRelease(id: string, request?: ClientFetch) {
  return clientRequest(`/api/releases/${encodeURIComponent(id)}`, undefined, request)
}
