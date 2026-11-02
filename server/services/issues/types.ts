import type { IssueCategory, IssueSource, IssueStatus, NotifyRole, Prisma } from '@prisma/client'
import type { prisma } from '../../utils/prisma'
import type { IssueRefType } from './constants'

export type Tx = Prisma.TransactionClient

export type Db = Tx | typeof prisma

/** 操作人：QMS 用户 ID + 是否管理员（NUXT_ADMIN_USER_IDS，由接口层判断后传入） */
export interface Actor {
  userId: string
  isAdmin: boolean
}

// ───────────── 权限（唯一入口）─────────────

export interface PermContext {
  actor: Actor
  roles: NotifyRole[]
  deptName: Map<string, string>
  pmOf: Map<string, string | null>
}

export interface IssuePermissions {
  /** 受理（待受理 → 处理中）：责任人、责任部门负责人、管理员 */
  accept: boolean
  /** 填处理结果（处理中 → 待确认）：同受理 */
  resolve: boolean
  /** 改派责任部门/责任人/外协单位/要求解决日（待受理、处理中）：责任部门负责人、项目经理、项目部负责人、管理员 */
  reassign: boolean
  /** 确认关闭（待确认 → 已关闭）：上报人、项目经理、项目部负责人、管理员 */
  close: boolean
  /** 退回（待确认 → 处理中）：同确认关闭 */
  reject: boolean
  /** 加备注：能看到就能加 */
  note: boolean
}

// ───────────── 上报 ─────────────

export interface NewIssueInput {
  title?: string
  workOrderNumber: string
  partId?: string | null
  category: IssueCategory
  description: string
  photoIds?: string[]
  dueDate?: Date | null
  responsibleSupplierId?: string | null
}

export interface SystemIssueInput {
  sourceKey: string
  source: Exclude<IssueSource, 'MANUAL'>
  category: IssueCategory
  workOrderNumber: string
  refType: IssueRefType
  refId: string
  description: string
  /** 不给时用分类默认责任部门的负责人 */
  responsibleUserId?: string | null
  responsibleSupplierId?: string | null
  /** 上报人：系统生成的为空；手动把黄色预警转异常时是点按钮的人 */
  reporterId?: string | null
  /** 第一条日志的操作人，系统为空 */
  actorId?: string | null
  /** 第一条日志 */
  note: string
}

// ───────────── 受理、改派、处理、关闭、退回、备注 ─────────────

export interface AssignInput {
  responsibleDeptId?: string | null
  responsibleUserId?: string | null
  responsibleSupplierId?: string | null
  dueDate?: Date | null
}

// ───────────── 列表与详情 ─────────────

export interface IssueFilter {
  /** UNCLOSED = 未关闭（待受理、处理中、待确认） */
  status?: IssueStatus | 'UNCLOSED'
  category?: IssueCategory
  workOrderNumber?: string
  /** 本部门：责任部门在这些部门里 */
  deptIds?: string[]
  /** responsible = 我负责；reported = 我上报；todo = 等我操作（受理/处理/确认） */
  mine?: 'responsible' | 'reported' | 'todo'
  /** 只看超期（待受理满 W4 黄阈值，或已过要求解决日；待确认、已关闭不算） */
  overdue?: boolean
  /** 可见工单（undefined = 全部） */
  visibleWorkOrders?: string[]
}
