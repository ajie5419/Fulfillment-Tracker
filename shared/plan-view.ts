/**
 * 项目计划 / 部门计划页面共用的类型（对应 GET /api/plan、GET /api/plan/dept 的返回；前端用 import type 从 #shared/plan-view 引用）。
 */
export interface PlanTask {
  kind: string
  kindText: string
  id: string
  name: string
  dateLabel: string
  planDate: string | null
  expectedDate: string | null
  doneDate: string | null
  done: boolean
  excluded: boolean
  overdue: boolean
  lateForNode: boolean
  statusText: string
  link: string
  /** 其他任务：负责人、备注、能否改 / 删、能否标完成（其余类型为空 / false） */
  ownerId: string | null
  ownerName: string | null
  note: string | null
  canEdit: boolean
  canDone: boolean
}
export interface PlanNodeRow {
  id: string
  seq: number
  /** 大纲编号：阶段.节点.子节点（没用阶段时 节点.子节点） */
  code: string
  name: string
  dept: string
  deptText: string
  note: string | null
  /** 上级节点（子节点，只有一层）；子节点数 */
  parentId: string | null
  childCount: number
  /** 阶段（分组显示；子节点跟上级）、计划开始日（可选） */
  phase: string | null
  startDate: string | null
  planDate: string
  /** 前置节点：customDeps = false 时是默认的"上一个节点" */
  customDeps: boolean
  preds: { id: string; seq: number; code: string; name: string }[]
  /** 被哪个前置节点推后（child = 被自己的子节点推后） */
  pushedBy: { seq: number; code: string; name: string; child: boolean } | null
  /** 影响范围：本节点晚了会推后的节点 */
  affects: { seq: number; code: string; name: string }[]
  /** 余量（天）：≤ 0 = 关键节点；null = 不显示（一条主线、已完成、或后面没节点接着） */
  slackDays: number | null
  critical: boolean
  baselineDate: string | null
  expectedDate: string
  actualDate: string | null
  done: boolean
  doneBy: 'MANUAL' | 'AUTO' | null
  manualDoneByName: string | null
  delayDays: number
  driver: string
  /** 不计上游顺延的自身预计日 / 自身延误天数；source = 源头延误节点（W9 只报它），upstream = 受上游影响 */
  selfExpectedDate: string
  selfDelayDays: number
  source: boolean
  upstream: boolean
  confirmStatus: 'PENDING' | 'CONFIRMED' | 'REJECTED' | null
  confirmText: string | null
  confirmedByName: string | null
  confirmedAt: string | null
  rejectReason: string | null
  taskCount: number
  doneCount: number
  overdueCount: number
  lateCount: number
  alertLevel: 'YELLOW' | 'RED' | null
  confirmAlertLevel: 'REMIND' | 'YELLOW' | 'RED' | null
  tasks: PlanTask[]
  /** 未分解：节点下还没有任何部门任务；splitAlertLevel = W9 未分解提醒 */
  unsplit: boolean
  splitAlertLevel: 'REMIND' | null
  canSplit: boolean
  canConfirm: boolean
  canComplete: boolean
}
export interface PlanView {
  workOrder: { workOrderNumber: string; projectName: string | null; customerName: string | null; deliveryDate: string | null; projectManagerName: string | null }
  plan: { status: 'DRAFT' | 'PUBLISHED'; templateName: string | null; publishedAt: string | null; publishedByName: string | null } | null
  expectedDelivery: string | null
  deliveryDelayDays: number | null
  delayedNodes: number
  sourceNodes: number
  planAlertLevel: 'YELLOW' | 'RED' | null
  unlinked: { drawing: number; purchase: number; step: number; assembly: number; total: number }
  /** 用了前置节点或开始日（多条线并行） */
  network: boolean
  /** 没有后续节点接着的节点（最后一个除外） */
  dangling: { id: string; seq: number; code: string; name: string }[]
  /** 对应交期的节点（最后一个一级节点） */
  lastNodeId: string | null
  phases: string[]
  canEdit: boolean
  canCreate: { drawing: boolean; purchase: boolean; route: boolean; kitting: boolean }
  nodes: PlanNodeRow[]
  changeLogs: { id: string; nodeName: string; kind: 'DATE' | 'ADD' | 'DELETE'; oldDate: string | null; newDate: string | null; reason: string; actorName: string | null; createdAt: string }[]
}

export type CanCreate = PlanView['canCreate']

/** 部门计划页的节点：项目计划的节点字段 + 上级节点名 + 页签（待接收 / 执行中 / 已完成） */
export interface DeptPlanNode extends PlanNodeRow {
  parentName: string | null
  confirmedDay: string | null
  tab: 'pending' | 'active' | 'done'
}
export interface DeptPlanGroup {
  workOrder: PlanView['workOrder']
  expectedDelivery: string | null
  deliveryDelayDays: number | null
  publishedDay: string | null
  publishedByName: string | null
  canCreate: CanCreate
  nodes: DeptPlanNode[]
}
export interface DeptPlanView {
  dept: string | null
  deptText: string | null
  deptOptions: { value: string; label: string }[]
  workOrderOptions: { value: string; label: string }[]
  groups: DeptPlanGroup[]
  summary: { pending: number; unsplit: number; overdueTasks: number; dueSoonTasks: number; active: number; done: number }
  focusNodeId: string | null
}
