/** 总计划读服务：保留原查询、预测与投影调用时机。 */
import { prisma } from '../../utils/prisma'
import type { Prisma } from '@prisma/client'
import { dateFieldDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import type { RoleContext } from '../auth/permissions'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { treeOrder, w9PlanKey, w9Key, w9ConfirmKey, w9SplitKey, deptPlanLink, deptPlanMobileLink } from './constants'
import { loadPlanSources, myConfirmTodos, unlinkedCounts } from './loaders'
import { calculatePlans } from './calculation'
import { projectPlan } from './projection'
import type { PlanData } from './types'

const day = (d: Date) => dateFieldDay(d)

/**
 * 读一批工单的总计划并算预计（总计划页、看板、领导总览、每日汇总、W9 扫描共用，口径一致）。
 * publishedOnly：只要已发布的（预警、统计只看已发布的）。每类挂靠记录一次查询，不随节点数增加查询次数。
 */
export async function loadPlans(filter: { workOrderNumbers?: string[]; publishedOnly?: boolean }, now = new Date(), db: Prisma.TransactionClient = prisma): Promise<Map<string, PlanData>> {
  const sources = await loadPlanSources(filter, now, db)
  if (!sources) return new Map()
  return calculatePlans(sources)
}

/** 总计划页：工单信息、发布状态、节点（基线 / 当前 / 预计 / 实际、确认、挂靠任务）、预计交期、未挂节点数、调整记录、当前用户能做什么 */
export async function getPlan(workOrderNumber: string, ctx: RoleContext, now = new Date()) {
  const wo = await prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber } })
  if (!wo) throw new FlowError('工单不存在')
  const [data, plan, ext, logs, unlinked] = await Promise.all([
    loadPlans({ workOrderNumbers: [workOrderNumber] }, now).then((m) => m.get(workOrderNumber)!),
    prisma.workOrderPlan.findUnique({ where: { workOrderNumber } }),
    prisma.workOrderExt.findUnique({ where: { workOrderNumber } }),
    prisma.planChangeLog.findMany({ where: { workOrderNumber }, orderBy: { createdAt: 'desc' }, take: 200 }),
    unlinkedCounts(workOrderNumber),
  ])
  const nodeIds = data.nodes.map((n) => n.id)
  const [names, mine, alerts] = await Promise.all([
    loadNames({ user: [ext?.projectManagerId ?? null, plan?.publishedBy ?? null, ...data.nodes.flatMap((n) => [n.confirmedBy, n.manualDoneBy]), ...logs.map((l) => l.actorId)] }),
    myConfirmTodos(ctx.userId, nodeIds),
    prisma.alert.findMany({
      where: { activeKey: { in: [w9PlanKey(workOrderNumber), ...nodeIds.map(w9Key), ...nodeIds.map(w9ConfirmKey), ...nodeIds.map(w9SplitKey)] } },
      select: { activeKey: true, level: true },
    }),
  ])
  return projectPlan({ wo, data, plan, ext, logs, unlinked, names, mine, alerts }, workOrderNumber, ctx)
}

/** 部门记录弹窗的"所属总计划节点"下拉：只列同一工单的节点；published 时新建必选 */
export async function planOptions(workOrderNumber: string) {
  const [plan, nodes] = await Promise.all([
    prisma.workOrderPlan.findUnique({ where: { workOrderNumber }, select: { status: true } }),
    prisma.planNode.findMany({ where: { workOrderNumber }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }], select: { id: true, seq: true, name: true, dept: true, planDate: true, parentId: true } }),
  ])
  return {
    published: plan?.status === 'PUBLISHED',
    nodes: treeOrder(nodes.map((n) => ({ ...n, parent: n.parentId }))).map((n) => ({ id: n.id, seq: n.seq, name: n.name, dept: n.dept, deptText: BUSINESS_DEPT_NAME[n.dept], planDate: day(n.planDate) })),
  }
}

/** 节点所属工单和责任部门（接口层判断权限用） */
export async function nodeTarget(id: string) {
  return prisma.planNode.findUnique({ where: { id }, select: { workOrderNumber: true, dept: true } })
}

// ───────────── 我的待办 ─────────────

/** "确认总计划节点"待办的说明：节点名称、工单、计划日、责任部门；节点已删的返回不到 */
export async function describePlanTodos(nodeIds: string[]) {
  if (!nodeIds.length) return new Map<string, { workOrderNumber: string; name: string; planDate: string; deptText: string; link: string; mobileLink: string }>()
  const nodes = await prisma.planNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, workOrderNumber: true, name: true, planDate: true, dept: true } })
  return new Map(nodes.map((n) => [n.id, { workOrderNumber: n.workOrderNumber, name: n.name, planDate: day(n.planDate), deptText: BUSINESS_DEPT_NAME[n.dept], link: deptPlanLink(n.id), mobileLink: deptPlanMobileLink(n.id) }]))
}
