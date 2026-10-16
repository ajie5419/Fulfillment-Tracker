/** 异常页面共用：文案、颜色、操作按钮、上传照片。 */

export const ISSUE_STATUS_TEXT = { OPEN: '待受理', ACCEPTED: '处理中', RESOLVED: '待确认', CLOSED: '已关闭' } as const
export const ISSUE_STATUS_COLOR = { OPEN: 'orange', ACCEPTED: 'blue', RESOLVED: 'purple', CLOSED: 'default' } as const
/** Vant 标签类型 */
export const ISSUE_STATUS_TYPE = { OPEN: 'warning', ACCEPTED: 'primary', RESOLVED: 'success', CLOSED: 'default' } as const
export const ISSUE_SOURCE_TEXT = { MANUAL: '手工上报', ALERT: '预警转入', QMS_NONCONFORMING: 'QMS 不合格' } as const
export const ISSUE_CATEGORY_TEXT = {
  DESIGN: '设计',
  CHANGE: '变更',
  MATERIAL_PAYMENT: '物料-付款原因',
  MATERIAL_MGMT: '物料-管理原因',
  OUTSOURCE_SCHEDULE: '外协-进度',
  OUTSOURCE_QUALITY: '外协-质量',
  WORKSHOP: '车间',
  CUSTOMER: '客户',
  OTHER: '其他',
} as const

export type IssueStatusKey = keyof typeof ISSUE_STATUS_TEXT
export type IssueCategoryKey = keyof typeof ISSUE_CATEGORY_TEXT
export type IssueAction = 'accept' | 'reassign' | 'resolve' | 'close' | 'reject' | 'note'

export const ACTION_TEXT: Record<IssueAction, string> = {
  accept: '受理',
  reassign: '改派',
  resolve: '填处理结果',
  close: '确认关闭',
  reject: '退回',
  note: '加备注',
}

/** 这些操作必须填说明 */
export const NOTE_REQUIRED: IssueAction[] = ['resolve', 'reject', 'note']

export const BOARD_COLOR = { RED: '#f5222d', YELLOW: '#fa8c16', GREEN: '#52c41a' } as const
export const BOARD_TEXT = { RED: '红', YELLOW: '黄', GREEN: '绿' } as const

export function useIssueOptions() {
  return useFetch('/api/issues/options', { key: 'issue-options', default: () => ({ categories: [], departments: [] }) })
}

/** 提交异常操作；body 里 undefined 的字段不改 */
export function issueAction(id: string, action: IssueAction, body: Record<string, unknown>) {
  const send = $fetch as unknown as (url: string, opts: { method: 'POST'; body: object }) => Promise<unknown>
  return send(`/api/issues/${encodeURIComponent(id)}/${action}`, { method: 'POST', body })
}

/** 上传照片（multipart，字段 file），返回 upload_file id */
export async function uploadPhotos(files: File[]): Promise<string[]> {
  if (!files.length) return []
  const form = new FormData()
  for (const f of files) form.append('file', f, f.name || 'photo')
  const send = $fetch as unknown as (url: string, opts: { method: 'POST'; body: FormData }) => Promise<{ id: string }[]>
  const saved = await send('/api/uploads', { method: 'POST', body: form })
  return saved.map((s) => s.id)
}

/** 照片大小上限（与服务端一致），选择时先拦一道 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024
export const MAX_PHOTOS = 3
