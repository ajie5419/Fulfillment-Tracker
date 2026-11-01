import type { AlertLevel, BusinessDept, PlanStatus } from '@prisma/client'
import type { NodeState } from './status'
import type { TaskKind } from './plan'

/** 挂靠记录的状态：保持工单详情原有的判定与展示口径。 */
export type TaskState = 'DONE' | 'OVERDUE' | 'LATE' | 'EXCLUDED' | 'NORMAL'

/** 工单详情 DTO；字段及可空性对应原 getWorkOrderDetail 推导结果。 */
export interface WorkOrderDetail {
  today: string
  workOrder: {
    workOrderNumber: string
    projectName: string | null
    customerName: string
    division: string | null
    quantity: number
    status: string
    deliveryDate: string
    projectManagerName: string | null
    edit: {
      customerNameId: string | null
      divisionId: string | null
      version: number | null
      projectManagerId: string | null
      productLine: string | null
      isPilot: boolean
    }
  }
  plan: { status: PlanStatus; templateName: string | null; publishedByName: string | null; startDate: string | null } | null
  published: boolean
  canEditPlan: boolean
  expectedDelivery: string | null
  delayDays: number | null
  progress: { total: number; done: number; onTrack: number; source: number; upstream: number }
  stuck: { id: string; name: string; deptText: string; days: number } | null
  nodes: {
    id: string
    seq: number
    name: string
    dept: BusinessDept
    deptText: string
    planDate: string
    baselineDate: string | null
    expectedDate: string
    actualDate: string | null
    done: boolean
    state: NodeState
    delayDays: number
    selfDelayDays: number
    confirmText: string | null
    taskCount: number
    doneCount: number
    overdueCount: number
    alertLevel: AlertLevel | null
    tasks: {
      kind: TaskKind
      kindText: string
      id: string
      name: string
      state: TaskState
      statusText: string
      dateLabel: string
      planDate: string | null
      expectedDate: string | null
      overdueDays: number
      payment: string | null
      link: string
    }[]
  }[]
  kitting: {
    nodeCount: number
    main: { id: string; name: string; needDate: string; percent: number | null; total: number; ready: number; shortageCount: number; reasons: { reason: string; count: number }[] } | null
  }
  alerts: { red: number; yellow: number; total: number; oldestDate: string | null }
  issues: { open: number; overdue: number; byDept: { dept: string; count: number }[] }
  actions: ({
    kind: 'alert'
    id: string
    level: AlertLevel
    weight: number
    title: string
    detail: string
    rule: string | null
    tag: string | null
    owners: string | null
    link: string | null
    issueNo: string | null
  } | {
    kind: 'issue'
    id: string
    level: 'YELLOW' | 'RED'
    weight: number
    title: string
    detail: string
    rule: string | null
    tag: string | null
    owners: string | null
    link: string
    issueNo: string
  })[]
  lagByDept: { deptText: string; dept: BusinessDept; days: number; nodes: number }[]
  unlinked: { drawing: number; purchase: number; step: number; assembly: number; total: number }
}
