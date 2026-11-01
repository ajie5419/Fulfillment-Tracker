import type { PlanNode } from '@prisma/client'
import type { PlanForecast, TaskFacts, TaskKind } from './constants'

export interface TaskRow {
  kind: TaskKind
  id: string
  nodeId: string
  name: string
  /** 部门日期叫什么（计划完成日 / 承诺到货日 / 需求日 / 承诺返回日 / 要求完成日） */
  dateLabel: string
  statusText: string
  link: string
  facts: TaskFacts
  /** 其他任务：负责人、备注（其余类型没有） */
  owner?: { id: string; name: string }
  note?: string | null
}

export interface PlanData {
  workOrderNumber: string
  status: 'DRAFT' | 'PUBLISHED' | null
  /** 发布时间（W9 未分解提醒从这里起计时） */
  publishedAt: Date | null
  deliveryDay: string | null
  nodes: PlanNode[]
  tasks: TaskRow[]
  forecast: PlanForecast
}
