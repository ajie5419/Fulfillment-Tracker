import type { PlanListStatus } from '../../../shared/plan'
/**
 * 项目计划列表（zhao 10-22：总计划从工单详情里拿出来，单独成"项目计划"菜单页）。
 *   每个在做的工单一行：计划状态（未编制 / 草稿 / 已发布）、节点完成数、待确认 / 未分解 / 源头延误节点数、预计交期与拖期；
 *   顶部汇总按同一口径数。预计、延误都用 loadPlans 的现算结果，和工单详情、项目总览一致。
 * 只列在做的工单（已完工 / 已取消默认隐藏，withClosed 另列出），范围按当前用户可见工单。
 */
import { prisma } from '../../utils/prisma'
import { dateFieldDay } from '../alerts/rules'
import { canOperate, type RoleContext } from '../auth/permissions'
import { loadNames } from '../flow/names'
import { ACTIVE_WO_WHERE } from '../workorder/active'
import { isClosedWorkOrder } from '../../../shared/status'
import { loadPlans } from './plan'

export type { PlanListStatus } from '../../../shared/plan'

export async function listPlans(visibleWorkOrders: string[] | undefined, ctx: RoleContext, now = new Date(), opts: { withClosed?: boolean } = {}) {
  const workOrders = await prisma.qmsWorkOrder.findMany({
    where: { ...(opts.withClosed ? { isDeleted: false } : ACTIVE_WO_WHERE), ...(visibleWorkOrders ? { workOrderNumber: { in: visibleWorkOrders } } : {}) },
    orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
  })
  const wos = workOrders.map((w) => w.workOrderNumber)
  const [plans, exts, meta] = await Promise.all([
    loadPlans({ workOrderNumbers: wos }, now),
    prisma.workOrderExt.findMany({ where: { workOrderNumber: { in: wos } }, select: { workOrderNumber: true, projectManagerId: true } }),
    prisma.workOrderPlan.findMany({ where: { workOrderNumber: { in: wos } }, select: { workOrderNumber: true, publishedBy: true } }),
  ])
  const pmOf = new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId]))
  const metaOf = new Map(meta.map((m) => [m.workOrderNumber, m]))
  const names = await loadNames({ user: [...exts.map((e) => e.projectManagerId), ...meta.map((m) => m.publishedBy)] })
  const user = (id: string | null | undefined) => (id ? (names.user.get(id) ?? id) : null)

  const rows = workOrders.map((w) => {
    const wo = w.workOrderNumber
    const plan = plans.get(wo)
    const nodes = plan?.nodes ?? []
    const est = plan?.forecast.nodes ?? []
    const status: PlanListStatus = !plan?.status || !nodes.length ? 'NONE' : plan.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT'
    const published = status === 'PUBLISHED'
    const m = metaOf.get(wo)
    return {
      workOrderNumber: wo,
      projectName: w.projectName,
      customerName: w.customerName,
      deliveryDate: dateFieldDay(w.deliveryDate),
      closed: isClosedWorkOrder(w.status),
      projectManagerName: user(pmOf.get(wo)),
      status,
      nodeCount: nodes.length,
      doneNodes: est.filter((e) => e.done).length,
      /** 已发布：等责任部门负责人确认的节点 */
      pendingConfirm: published ? nodes.filter((n) => n.confirmStatus === 'PENDING').length : 0,
      /** 已发布：没完成、还没有任何部门任务的节点 */
      unsplit: published ? est.filter((e) => !e.done && e.taskCount === 0).length : 0,
      /** 已发布：源头延误节点（自身就已延误） */
      sourceNodes: published ? (plan?.forecast.sourceNodes ?? 0) : 0,
      expectedDelivery: published ? (plan?.forecast.expectedDelivery ?? null) : null,
      delayDays: published ? (plan?.forecast.deliveryDelayDays ?? null) : null,
      publishedDay: published && plan?.publishedAt ? dateFieldDay(plan.publishedAt) : null,
      publishedByName: published ? user(m?.publishedBy) : null,
      /** 能编制 / 发布 / 调整（该工单项目经理、项目部、管理员） */
      canEdit: canOperate(ctx, 'plan', { workOrderNumber: wo }),
    }
  })
  const active = rows.filter((r) => !r.closed)
  return {
    rows,
    summary: {
      total: active.length,
      published: active.filter((r) => r.status === 'PUBLISHED').length,
      draft: active.filter((r) => r.status === 'DRAFT').length,
      none: active.filter((r) => r.status === 'NONE').length,
      /** 已发布且拖期或有源头延误节点的工单 */
      late: active.filter((r) => (r.delayDays ?? 0) > 0 || r.sourceNodes > 0).length,
      /** 已发布、还有未分解节点的工单 */
      unsplit: active.filter((r) => r.unsplit > 0).length,
    },
  }
}
