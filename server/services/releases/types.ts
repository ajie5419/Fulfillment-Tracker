import type { ReceiptStatus, ReleaseType } from '@prisma/client'
import type { RawBomRow } from '../bom/excel'
import type { RecipientGroup } from './constants'

export interface Actor {
  userId: string
  isAdmin: boolean
}

// ───────────── 新建 ─────────────

export interface NewReleaseInput {
  type: ReleaseType
  workOrderNumber: string
  partIds?: string[]
  version?: string | null
  description: string
  attachmentIds?: string[]
  userIds?: string[]
  groups?: RecipientGroup[]
  /** 从设计任务一键发放（R11） */
  drawingTaskId?: string | null
  /** 图纸发放单附的 BOM 表：已上传的文件（upload_file.id，接口层已读出行） */
  bom?: { fileId: string; rows: RawBomRow[] } | null
}

export interface ChangeImpact {
  /** 已在加工 / 在外协的工序数（> 0 时发了"确认变更影响"待办） */
  started: number
  /** 标了"等变更"的未开工工序数 */
  held: number
  /** 收到"确认变更影响"待办的人 */
  confirmers: string[]
}

export interface ReleaseFilter {
  workOrderNumber?: string
  type?: ReleaseType
  /** PENDING = 有人未签收；REJECTED = 有人拒收；VOID = 已作废；MINE_PENDING = 待我签收（前端改版第二轮统计卡） */
  progress?: ReleaseProgress
  /** issued = 我发出的；received = 发给我的 */
  mine?: 'issued' | 'received'
  /** 可见工单（undefined = 全部）。发给我的发放单不受可见范围限制 */
  visibleWorkOrders?: string[]
}

export type ReleaseProgress = 'PENDING' | 'REJECTED' | 'VOID' | 'MINE_PENDING'

// ───────────── 查询 ─────────────

export type Counts = Record<ReceiptStatus, number>
