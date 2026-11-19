import { DELIVERY_HORIZON_DAYS, type DeliveryFilter } from '../../../shared/board-directory'
import { addDays, parseDay } from '../../../shared/dates'
import { MAX_PAGE_SIZE, paginationSchema, type PageInput, type PageResult } from '../../../shared/pagination'
import type { Prisma } from '@prisma/client'
import type { PlanListStatus } from '../../../shared/plan'
/**
 * 项目计划列表（zhao 10-22：总计划从工单详情里拿出来，单独成"项目计划"菜单页）。
 *   每个在做的工单一行：计划状态（未编制 / 草稿 / 已发布）、节点完成数、待确认 / 未分解 / 源头延误节点数、预计交期与拖期；
 *   顶部汇总按同一口径数。预计、延误都用 loadPlans 的现算结果，和工单详情、项目总览一致。
 * 只列在做的工单（已完工 / 已取消默认隐藏，withClosed 另列出），范围按当前用户可见工单。
 */
import { prisma } from '../../utils/prisma'
import { dateFieldDay, shanghaiDay } from '../alerts/rules'
import { canOperate, type RoleContext } from '../auth/permissions'
import { loadNames } from '../flow/names'
import { ACTIVE_WO_WHERE } from '../workorder/active'
import { isClosedWorkOrder } from '../../../shared/status'
import { loadPlans } from './plan'

export type { PlanListStatus } from '../../../shared/plan'

async function planRows(visibleWorkOrders: string[] | undefined, ctx: RoleContext, now = new Date(), opts: { withClosed?: boolean; where?: Prisma.QmsWorkOrderWhereInput; paging?: { skip: number; take: number } } = {}) {
  const workOrders = await prisma.qmsWorkOrder.findMany({
    where: opts.where ?? { ...(opts.withClosed ? { isDeleted: false } : ACTIVE_WO_WHERE), ...(visibleWorkOrders ? { workOrderNumber: { in: visibleWorkOrders } } : {}) },
    orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
    ...opts.paging,
    select: { workOrderNumber: true, projectName: true, customerName: true, deliveryDate: true, status: true },
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
      dateConflicts: plan?.forecast.dateConflicts ?? [],
      expectedDelivery: published ? (plan?.forecast.expectedDelivery ?? null) : null,
      delayDays: published ? (plan?.forecast.deliveryDelayDays ?? null) : null,
      publishedDay: published && plan?.publishedAt ? shanghaiDay(plan.publishedAt) : null,
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

/** 旧页面兼容及全范围汇总入口。loadPlans 的全图预测不可截断节点/挂靠任务。 */
export async function listPlans(visibleWorkOrders: string[] | undefined, ctx: RoleContext, now = new Date(), opts: { withClosed?: boolean } = {}) {
  return planRows(visibleWorkOrders, ctx, now, opts)
}

/** 明细数据库分页；全范围汇总继续由独立的 /api/plan/summary 提供。 */
export async function listPlansPage(visibleWorkOrders: string[] | undefined, ctx: RoleContext, now = new Date(), opts: PageInput & { withClosed?: boolean } = {}): Promise<PageResult<Awaited<ReturnType<typeof planRows>>['rows'][number]>> {
  const { page, pageSize } = paginationSchema.parse(opts)
  const where: Prisma.QmsWorkOrderWhereInput = { ...(opts.withClosed ? { isDeleted: false } : ACTIVE_WO_WHERE), ...(visibleWorkOrders ? { workOrderNumber: { in: visibleWorkOrders } } : {}) }
  const [current, total] = await Promise.all([
    planRows(visibleWorkOrders, ctx, now, { ...opts, paging: { skip: (page - 1) * pageSize, take: pageSize } }),
    prisma.qmsWorkOrder.count({ where }),
  ])
  return { rows: current.rows, total, page, pageSize }
}

export async function listBoardDirectory(scope: string[] | undefined, ctx: RoleContext, options: {
  page: number; pageSize: number; q: string; delivery: DeliveryFilter; mine: string
}, now = new Date()) {
  const { q, page, pageSize, delivery } = options
  const today = shanghaiDay(now)
  const until = addDays(today, DELIVERY_HORIZON_DAYS)
  const base = { ...ACTIVE_WO_WHERE, ...(scope && { workOrderNumber: { in: scope } }) }
  const where: Prisma.QmsWorkOrderWhereInput = {
    AND: [base,
      ...(options.mine === '1' ? [{ workOrderNumber: { in: [...ctx.pmOf] } }] : []),
      ...(q ? [{ OR: [{ workOrderNumber: { contains: q } }, { projectName: { contains: q } }, { customerName: { contains: q } }] }] : []),
      ...(delivery === 'soon' ? [{ deliveryDate: { gte: parseDay(today), lt: parseDay(addDays(until, 1)) } }] : []),
    ],
  }
  const slice = (skip: number, take: number) => planRows(scope, ctx, now, { where, paging: { skip, take } })
  const offset = (page - 1) * pageSize
  let total = 0
  let matches: Awaited<ReturnType<typeof planRows>>['rows'] = []
  const available = await prisma.qmsWorkOrder.count({ where: base })
  if (delivery === 'late') {
    // Forecasts depend on the whole plan. Filter completed forecasts before paginating matches.
    for (let skip = 0; ; skip += MAX_PAGE_SIZE) {
      const batch = await slice(skip, MAX_PAGE_SIZE)
      for (const row of batch.rows) {
        if ((row.delayDays ?? 0) <= 0) continue
        if (total >= offset && matches.length < pageSize) matches.push(row)
        total++
      }
      if (batch.rows.length < MAX_PAGE_SIZE) break
    }
  } else {
    const [result, count] = await Promise.all([slice(offset, pageSize),
      q || options.mine === '1' || delivery === 'soon' ? prisma.qmsWorkOrder.count({ where }) : available])
    total = count
    matches = result.rows
  }
  const rows = matches.map(({ workOrderNumber, projectName, customerName, deliveryDate, delayDays, expectedDelivery, dateConflicts, status }) => ({
    workOrderNumber, projectName, customerName, delayDays, expectedDelivery, status,
    review: status === 'PUBLISHED' && dateConflicts.length > 0,
    dueSoon: deliveryDate >= today && deliveryDate <= until,
  }))
  return { rows, page, pageSize, total, available }
}
