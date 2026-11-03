/** 批量读取总计划来源；查询口径与加载顺序保持原样。 */
import { prisma } from '../../utils/prisma'
import type { Prisma } from '@prisma/client'
import { shanghaiDay } from '../alerts/rules'
import { loadNames } from '../flow/names'
import { NODE_LINKS, type NodeWithLinks, loadKitCounts } from '../kitting/kitting'
import { CONFIRM_PLAN_NODE, PLAN_REF } from './constants'

export async function loadPlanSources(filter: { workOrderNumbers?: string[]; publishedOnly?: boolean }, now: Date, db: Prisma.TransactionClient = prisma) {
  const plans = await db.workOrderPlan.findMany({
    where: { ...(filter.workOrderNumbers ? { workOrderNumber: { in: filter.workOrderNumbers } } : {}), ...(filter.publishedOnly ? { status: 'PUBLISHED' } : {}) },
  })
  const wos = filter.publishedOnly ? plans.map((p) => p.workOrderNumber) : (filter.workOrderNumbers ?? plans.map((p) => p.workOrderNumber))
  if (!wos.length) return null
  const nodes = await db.planNode.findMany({ where: { workOrderNumber: { in: wos } }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  const nodeIds = nodes.map((n) => n.id)
  const linked = { planNodeId: { in: nodeIds } }
  const [workOrders, drawings, purchases, steps, assemblies, others, deps] = await Promise.all([
    db.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: wos } }, select: { workOrderNumber: true, deliveryDate: true } }),
    nodeIds.length ? db.drawingTask.findMany({ where: linked, orderBy: { planDate: 'asc' }, select: {
      id: true, planNodeId: true, componentName: true, status: true, planDate: true, drawnDate: true,
      needsCustomerConfirm: true, customerPlanDate: true, customerConfirmedDate: true, materialStatus: true, processStatus: true,
    } }) : [],
    nodeIds.length ? db.purchaseLine.findMany({ where: linked, orderBy: { needDate: 'asc' }, select: {
      id: true, planNodeId: true, materialName: true, spec: true, status: true, needDate: true, promisedDate: true, arrivedDate: true,
    } }) : [],
    nodeIds.length ? db.routeStep.findMany({ where: linked, include: { part: { select: { name: true } } }, orderBy: [{ partId: 'asc' }, { seq: 'asc' }] }) : [],
    nodeIds.length ? db.assemblyNode.findMany({ where: linked, include: NODE_LINKS, orderBy: { needDate: 'asc' } }) : [],
    nodeIds.length ? db.planTask.findMany({ where: linked, orderBy: [{ planDate: 'asc' }, { createdAt: 'asc' }] }) : [],
    nodeIds.length ? db.planNodeDep.findMany({ where: { nodeId: { in: nodeIds } } }) : [],
  ])
  const today = shanghaiDay(now)
  const [kits, names] = await Promise.all([
    loadKitCounts(assemblies as NodeWithLinks[], db),
    loadNames({ process: steps.map((s) => s.processId), user: others.map((t) => t.ownerId) }),
  ])
  return { plans, wos, nodes, workOrders, drawings, purchases, steps, assemblies, others, deps, today, kits, names }
}

export type PlanSources = NonNullable<Awaited<ReturnType<typeof loadPlanSources>>>

export async function myConfirmTodos(userId: string, nodeIds: string[]) {
  if (!nodeIds.length) return new Set<string>()
  const todos = await prisma.todo.findMany({ where: { ownerId: userId, refType: PLAN_REF, refId: { in: nodeIds }, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, select: { refId: true } })
  return new Set(todos.map((t) => t.refId))
}

/** 没挂节点的部门记录条数（老数据；已取消的设计任务、采购行不算） */
export async function unlinkedCounts(wo: string) {
  const [drawing, purchase, step, assembly] = await Promise.all([
    prisma.drawingTask.count({ where: { workOrderNumber: wo, planNodeId: null, status: { not: 'CANCELLED' } } }),
    prisma.purchaseLine.count({ where: { workOrderNumber: wo, planNodeId: null, status: { not: 'CANCELLED' } } }),
    prisma.routeStep.count({ where: { part: { workOrderNumber: wo }, planNodeId: null } }),
    prisma.assemblyNode.count({ where: { workOrderNumber: wo, planNodeId: null } }),
  ])
  return { drawing, purchase, step, assembly, total: drawing + purchase + step + assembly }
}
