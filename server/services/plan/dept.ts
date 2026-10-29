/**
 * 部门计划页（10-23 zhao）：项目部发布项目计划后，各部门在这里看到本部门负责的节点 → 接收（或退回写原因）→ 分解任务、委派责任人、给计划日期。
 * 项目计划页只编排、只读看部门执行；接收、分解都在这里做。
 *
 *   部门：本人所在业务部门（含担任负责人的部门）；领导、项目部负责人、管理员可以切换看任一部门；
 *     手里有转交来的接收待办的人，也能看那个节点所在的部门。
 *   节点：已发布计划、在做工单里，责任部门是该部门的末级节点（汇总行由子节点算出，不用接收、不挂任务）。
 *   工单范围：当前用户可见的工单，加上手里有接收待办的工单（和项目计划页 assertCanSeePlan 一致）。
 *   每个节点的字段和项目计划页 getPlan 完全一致（同一份现算结果），另加上级节点名。
 */
import type { BusinessDept } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { shanghaiDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME, BUSINESS_DEPTS } from '../auth/departments'
import { type RoleContext, inDept, isLeaderLike } from '../auth/permissions'
import { ACTIVE_WO_WHERE } from '../workorder/active'
import { CONFIRM_PLAN_NODE, PLAN_REF, addDays, deptNodeTab } from './constants'
import { getPlan } from './plan'

export type DeptPlanTab = 'pending' | 'returned' | 'active' | 'done'

/** 当前用户能看哪些部门的部门计划 */
async function deptChoices(ctx: RoleContext): Promise<{ depts: BusinessDept[]; todoNodes: { id: string; workOrderNumber: string; dept: BusinessDept }[] }> {
  const todos = await prisma.todo.findMany({ where: { ownerId: ctx.userId, refType: PLAN_REF, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, select: { refId: true } })
  const todoNodes = todos.length
    ? await prisma.planNode.findMany({ where: { id: { in: todos.map((t) => t.refId) } }, select: { id: true, workOrderNumber: true, dept: true } })
    : []
  const all = isLeaderLike(ctx)
  const depts = BUSINESS_DEPTS.filter((d) => all || inDept(ctx, d) || todoNodes.some((n) => n.dept === d))
  return { depts, todoNodes }
}

export async function deptPlan(ctx: RoleContext, visible: string[] | undefined, opts: { dept?: BusinessDept; wo?: string; node?: string } = {}, now = new Date()) {
  const { depts, todoNodes } = await deptChoices(ctx)
  const focus = opts.node ? await prisma.planNode.findUnique({ where: { id: opts.node }, select: { id: true, dept: true, workOrderNumber: true } }) : null
  // 定位到某个节点时按它的部门看（能看的前提下）；否则按选的部门、本人部门、第一个可选部门
  const dept =
    (focus && depts.includes(focus.dept) ? focus.dept : null) ??
    (opts.dept && depts.includes(opts.dept) ? opts.dept : null) ??
    (ctx.businessDept && depts.includes(ctx.businessDept) ? ctx.businessDept : null) ??
    depts[0] ??
    null
  const deptOptions = depts.map((d) => ({ value: d, label: BUSINESS_DEPT_NAME[d] }))
  const empty = { dept, deptText: dept ? BUSINESS_DEPT_NAME[dept] : null, deptOptions, workOrderOptions: [] as { value: string; label: string }[], groups: [], summary: { pending: 0, returned: 0, unsplit: 0, overdueTasks: 0, dueSoonTasks: 0, active: 0, done: 0 }, focusNodeId: null }
  if (!dept) return empty

  // 已发布、在做、有本部门节点的工单（可见范围 ∪ 手里有接收待办的工单）
  const todoWos = new Set(todoNodes.map((n) => n.workOrderNumber))
  const published = await prisma.workOrderPlan.findMany({ where: { status: 'PUBLISHED' }, select: { workOrderNumber: true } })
  const wos = published.map((p) => p.workOrderNumber).filter((wo) => !visible || visible.includes(wo) || todoWos.has(wo))
  const withDept = await prisma.planNode.findMany({ where: { workOrderNumber: { in: wos }, dept }, distinct: ['workOrderNumber'], select: { workOrderNumber: true } })
  const workOrders = await prisma.qmsWorkOrder.findMany({
    where: { ...ACTIVE_WO_WHERE, workOrderNumber: { in: withDept.map((n) => n.workOrderNumber) } },
    orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
    select: { workOrderNumber: true, projectName: true },
  })
  const workOrderOptions = workOrders.map((w) => ({ value: w.workOrderNumber, label: w.projectName ? `${w.workOrderNumber} ${w.projectName}` : w.workOrderNumber }))
  const shown = opts.wo ? workOrders.filter((w) => w.workOrderNumber === opts.wo) : workOrders

  const today = shanghaiDay(now)
  const weekEnd = addDays(today, 7)
  const plans = await Promise.all(shown.map((w) => getPlan(w.workOrderNumber, ctx, now)))
  const groups = plans
    .map((p) => {
      const nameOf = new Map(p.nodes.map((n) => [n.id, `${n.code} ${n.name}`]))
      const nodes = p.nodes
        .filter((n) => n.dept === dept && n.childCount === 0)
        .map((n) => ({
          ...n,
          parentName: n.parentId ? (nameOf.get(n.parentId) ?? null) : null,
          /** 接收 / 退回日（上海时区，页面直接显示，避免服务端和浏览器时区不同） */
          confirmedDay: n.confirmedAt ? shanghaiDay(n.confirmedAt) : null,
          /** 待接收 / 已退回（等项目经理调整）/ 执行中 / 已完成 */
          tab: deptNodeTab(n),
        }))
      return {
        workOrder: p.workOrder,
        expectedDelivery: p.expectedDelivery,
        deliveryDelayDays: p.deliveryDelayDays,
        publishedDay: p.plan?.publishedAt ? shanghaiDay(p.plan.publishedAt) : null,
        publishedByName: p.plan?.publishedByName ?? null,
        canCreate: p.canCreate,
        nodes,
      }
    })
    .filter((g) => g.nodes.length)

  const nodes = groups.flatMap((g) => g.nodes)
  const openTasks = nodes.filter((n) => n.tab === 'active').flatMap((n) => n.tasks.filter((t) => !t.done && !t.excluded))
  return {
    ...empty,
    workOrderOptions,
    groups,
    summary: {
      pending: nodes.filter((n) => n.tab === 'pending').length,
      returned: nodes.filter((n) => n.tab === 'returned').length,
      /** 已接收、没完成、还没分解任何任务 */
      unsplit: nodes.filter((n) => n.tab === 'active' && n.unsplit).length,
      overdueTasks: openTasks.filter((t) => t.overdue).length,
      /** 7 天内到期（含今天）的未完成任务 */
      dueSoonTasks: openTasks.filter((t) => !t.overdue && t.planDate && t.planDate >= today && t.planDate <= weekEnd).length,
      active: nodes.filter((n) => n.tab === 'active').length,
      done: nodes.filter((n) => n.tab === 'done').length,
    },
    focusNodeId: focus && nodes.some((n) => n.id === focus.id) ? focus.id : null,
  }
}
