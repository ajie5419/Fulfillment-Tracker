/**
 * 项目部总计划（R14，总计划设计.md）：每个工单一份，按模板倒推生成 → 项目经理调整 → 发布（锁基线、各部门确认）→
 * 部门记录挂节点 → 预计完成日沿前置节点顺延（10-22 起支持多条线并行，默认前置 = 上一个节点）→ 预计交期 / 拖期天数、余量、W9 预警。
 *
 *   发布前（草稿）：随便改日期、增删节点，不记调整记录；
 *   发布后：当时的计划日记为基线（不再变）；给每个节点的责任部门负责人发"确认总计划节点"待办（可确认、可退回写原因，退回提醒项目经理）；
 *     发布立即生效，不等各部门全部确认；改计划日、发布后加 / 删节点必须写原因，写进调整记录；
 *     改了日期或责任部门的节点重新请部门确认（原来的确认作废）。
 *   节点完成：挂靠任务全部完成时自动完成（现算，见 constants.ts）；也可以由责任部门的人、项目经理手动标记。
 *
 * 权限在接口层（utils/auth.ts + auth/permissions.ts）判断；这里只做业务规则。
 * 并发：同一工单的总计划操作先锁 work_order_plan 行（没有时建一行）再改节点，串行执行。
 */

export type { PlanData } from './types'
export { loadPlans, getPlan, planOptions, nodeTarget, describePlanTodos } from './queries'
export type { NodeInput } from './commands'
export { deptHeads, generateFromTemplate, createNode, updateNode, deleteNode, publishPlan, confirmNode, rejectNode, completeNode, undoCompleteNode } from './commands'
