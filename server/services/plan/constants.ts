/** 总计划常量、对象标识与链接；原算法入口保留兼容 re-export。 */
import type { PlanNodeConfirm } from '@prisma/client'
import { PLAN_CONFIRM_TEXT } from '../../../shared/plan'
import { alertKey } from '../alerts/rules'
export { TASK_KIND_TEXT } from '../../../shared/plan'
export type { BusinessDept } from '@prisma/client'
export { addDays } from '../../../shared/dates'
export * from './estimate-types'
export * from './task-estimates'
export * from './graph'
export * from './node-estimates'
export * from './forecast'
export * from './warnings'

/** 待办："确认总计划节点"（refType = planNode，refId = 节点 ID），发给节点责任部门负责人 */
export const CONFIRM_PLAN_NODE = 'CONFIRM_PLAN_NODE'

export const PLAN_REF = 'planNode'

/** 页面上叫"接收"（10-23 zhao：发布后各部门在"部门计划"页接收本部门的节点再分解）；库里仍是确认状态 */
export const CONFIRM_TEXT: Record<PlanNodeConfirm, string> = PLAN_CONFIRM_TEXT

/** 总计划页：选中工单并定位到节点 */
export const planLink = (workOrderNumber: string, nodeId?: string | null) =>
  `/plan?wo=${encodeURIComponent(workOrderNumber)}${nodeId ? `&node=${encodeURIComponent(nodeId)}` : ''}`

/** 部门计划页：定位到节点（接收、分解在这里做） */
export const deptPlanLink = (nodeId: string) => `/dept-plan?node=${encodeURIComponent(nodeId)}`

export const deptPlanMobileLink = (nodeId: string) => `/m/dept-plan?node=${encodeURIComponent(nodeId)}`

/** W9 节点延误预警 / 节点超时未确认（同一规则，不同对象类型；超时未确认按 W5 的阈值计时） */
export const w9Key = (nodeId: string) => alertKey('W9', 'planNode', nodeId)

export const w9ConfirmKey = (nodeId: string) => alertKey('W9', 'planConfirm', nodeId)

/** W9 工单级：预计交期晚于合同交期 */
export const w9PlanKey = (workOrderNumber: string) => alertKey('W9', 'plan', workOrderNumber)


/** 待办："完成部门任务"（refType = planTask，refId = 其他任务 ID），发给任务负责人，截止日 = 计划完成日 */
export const DO_PLAN_TASK = 'DO_PLAN_TASK'

export const PLAN_TASK_REF = 'planTask'

/** 以总计划节点为对象（refId = 节点 ID）的 W9 预警类型：节点延误、超时未确认、未分解。按节点找工单、跳转的地方都用这一份，加类型只改这里 */
export const PLAN_NODE_ALERT_REFS = ['planNode', 'planConfirm', 'planSplit'] as const

export const isPlanNodeAlert = (refType: string) => (PLAN_NODE_ALERT_REFS as readonly string[]).includes(refType)

/** 节点类预警跳哪：超时未接收、未分解 → 部门计划页（部门在那里处理）；节点延误 → 项目计划页 */
export const planNodeAlertLink = (refType: string, workOrderNumber: string, nodeId: string): { pc: string; mobile: string | null } =>
  refType === 'planConfirm' || refType === 'planSplit' ? { pc: deptPlanLink(nodeId), mobile: deptPlanMobileLink(nodeId) } : { pc: planLink(workOrderNumber, nodeId), mobile: null }

/** W9"节点未分解"提醒（对象类型 planSplit，refId = 节点 ID） */
export const w9SplitKey = (nodeId: string) => alertKey('W9', 'planSplit', nodeId)

/** Returned nodes await project-plan adjustment, not department acceptance. */
export function deptNodeTab(n: { done: boolean; confirmStatus: string | null }): 'pending' | 'returned' | 'active' | 'done' {
  return n.done ? 'done' : n.confirmStatus === 'REJECTED' ? 'returned' : n.confirmStatus === 'CONFIRMED' || !n.confirmStatus ? 'active' : 'pending'
}
