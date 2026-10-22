/**
 * 看板（技术选型 6.2）：每个工单一行——红黄绿、外协在途数、超期数、未关闭异常数、项目经理、交期；
 * 顶部显示 QMS 最后同步时间：各类资源最后成功追平时间（sync_cursor.lastSyncedAt）的最小值，即最旧的那类；
 * 有资源从没同步成功过时为空（页面显示"未同步"）；有资源正在报错时附带错误（syncErrors）。
 *
 *   超期数 = 在外加工且已过承诺返回日的步骤 + 已过要求解决日的未关闭异常（待受理、处理中；待确认不算超期，与 W4 一致）
 *   红 = 有活动红色预警（含已转异常、但对象仍停在原状态的），或有超期 ≥ W4 红色阈值（默认 3 天）的异常
 *   黄 = 有活动黄色预警，或有超期的异常（含待受理超时）
 *   否则绿
 *   未签收发放（R9）= 该工单上还有人没签收的有效发放单份数（只显示，不参与红黄绿；超时没签收由 W5 预警计入红黄）
 *   缺料（R10）= 该工单上未到货、且已到需求日的关键物料项数（只显示；未到货的预警由 W6 计入红黄）
 *   设计逾期（R11）= 该工单上逾期的设计任务数（设计中已过计划完成日、或客户确认已过计划日；只显示，预警由 W7 计入红黄）
 *   未齐套节点（R12）= 该工单上已进入 W8 预警窗口（需求日前 N 天内，含已过）仍未齐套的装配节点数（只显示，预警由 W8 计入红黄）。
 *     远期节点还没齐是正常的，不计入，免得这一列永远是一大串数字没人看
 *   预计交期、拖期天数（R14）= 已发布总计划的最后一个节点的预计完成日、它比 QMS 交期晚几天（负数 = 提前；只显示，延误由 W9 计入红黄）；
 *     没有总计划或还是草稿时为空
 *   项目总览（前端改版第一轮）另加：hasPlan 是否有已发布总计划、planNodes 节点摘要（名称、状态、计划日 / 预计日）、
 *     stuck 当前卡点（最早的源头延误节点）、kitPercent 总装齐套率（装配节点名称含"总装"的，没有取需求日最晚的；清单为空为 null），
 *     以及顶部 sourceByDept（源头延误节点按责任部门计数）。原有字段含义不变
 */
import { prisma } from '../../utils/prisma'
import { loadOffDays, loadThresholds } from '../alerts/config'
import { judgeW4 } from '../alerts/rules'
import { overdueWhere } from '../drawings/drawings'
import { dueWindowWhere, incompleteWhere } from '../kitting/kitting'
import { todayDate } from '../purchases/constants'
import { overdueDays } from '../flow/dates'
import { loadNames } from '../flow/names'
import { syncOverview } from '../sync/status'
import { loadPlans } from '../plan/plan'
import { PLAN_NODE_ALERT_REFS, isPlanNodeAlert } from '../plan/constants'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import { NODE_LINKS, loadKitCounts } from '../kitting/kitting'
import { kitPercent } from '../kitting/constants'
import { dateFieldDay } from '../alerts/rules'
import { pickMainAssembly } from '../workorder/rules'
import { isClosedWorkOrder, nodeState, stuckNode } from '../../../shared/status'
import { ACTIVE_WO_WHERE } from '../workorder/active'
import { OPEN_STATUSES } from './constants'

export type BoardColor = 'RED' | 'YELLOW' | 'GREEN'

/** 活动预警 → 所属工单 */
async function alertWorkOrders(alerts: { id: string; refType: string; refId: string }[]) {
  const ids = (t: string) => alerts.filter((a) => a.refType === t).map((a) => a.refId)
  const planIds = alerts.filter((a) => isPlanNodeAlert(a.refType)).map((a) => a.refId)
  const [steps, inspections, issues, receipts, releases, purchases, drawings, nodes, planNodes] = await Promise.all([
    ids('step').length ? prisma.routeStep.findMany({ where: { id: { in: ids('step') } }, select: { id: true, part: { select: { workOrderNumber: true } } } }) : [],
    ids('unmatched').length ? prisma.qmsInspection.findMany({ where: { id: { in: ids('unmatched') } }, select: { id: true, workOrderNumber: true } }) : [],
    ids('issue').length ? prisma.issue.findMany({ where: { id: { in: ids('issue') } }, select: { id: true, workOrderNumber: true } }) : [],
    ids('receipt').length
      ? prisma.releaseReceipt.findMany({ where: { id: { in: ids('receipt') } }, select: { id: true, release: { select: { workOrderNumber: true } } } })
      : [],
    ids('release').length ? prisma.release.findMany({ where: { id: { in: ids('release') } }, select: { id: true, workOrderNumber: true } }) : [],
    ids('purchase').length ? prisma.purchaseLine.findMany({ where: { id: { in: ids('purchase') } }, select: { id: true, workOrderNumber: true } }) : [],
    ids('drawing').length ? prisma.drawingTask.findMany({ where: { id: { in: ids('drawing') } }, select: { id: true, workOrderNumber: true } }) : [],
    ids('node').length ? prisma.assemblyNode.findMany({ where: { id: { in: ids('node') } }, select: { id: true, workOrderNumber: true } }) : [],
    planIds.length ? prisma.planNode.findMany({ where: { id: { in: planIds } }, select: { id: true, workOrderNumber: true } }) : [],
  ])
  const wo = new Map<string, string>()
  for (const s of steps) wo.set(`step:${s.id}`, s.part.workOrderNumber)
  for (const i of inspections) wo.set(`unmatched:${i.id}`, i.workOrderNumber)
  for (const i of issues) wo.set(`issue:${i.id}`, i.workOrderNumber)
  for (const r of receipts) wo.set(`receipt:${r.id}`, r.release.workOrderNumber)
  for (const r of releases) wo.set(`release:${r.id}`, r.workOrderNumber)
  for (const p of purchases) wo.set(`purchase:${p.id}`, p.workOrderNumber)
  for (const d of drawings) wo.set(`drawing:${d.id}`, d.workOrderNumber)
  for (const n of nodes) wo.set(`node:${n.id}`, n.workOrderNumber)
  for (const n of planNodes) for (const t of PLAN_NODE_ALERT_REFS) wo.set(`${t}:${n.id}`, n.workOrderNumber)
  // W9 工单级（交期风险）：refId 就是工单号
  return new Map(alerts.map((a) => [a.id, a.refType === 'plan' ? a.refId : (wo.get(`${a.refType}:${a.refId}`) ?? null)]))
}

/** 源头延误节点按责任部门计数，多的在前 */
function sourceByDept(rows: { planNodes: { dept: keyof typeof BUSINESS_DEPT_NAME; state: string }[] }[]) {
  const m = new Map<keyof typeof BUSINESS_DEPT_NAME, number>()
  for (const r of rows) for (const n of r.planNodes) if (n.state === 'SOURCE') m.set(n.dept, (m.get(n.dept) ?? 0) + 1)
  return [...m.entries()].map(([dept, nodes]) => ({ dept, deptText: BUSINESS_DEPT_NAME[dept], nodes })).sort((a, b) => b.nodes - a.nodes)
}

/**
 * withClosed：另把已完工 / 已取消的工单也列出（项目总览"显示已完工"开关）。
 * 这些行 closed = true，不计入 summary、sourceByDept；默认（领导那一块、看板）只算在做的工单，见 workorder/active.ts。
 */
export async function getBoard(visibleWorkOrders: string[] | undefined, now = new Date(), opts: { withClosed?: boolean } = {}) {
  const woWhere = visibleWorkOrders ? { in: visibleWorkOrders } : undefined
  const [workOrders, exts, outSteps, issues, alerts, sync, thresholds, offDays, unsigned, shortage, drawingOverdue] = await Promise.all([
    prisma.qmsWorkOrder.findMany({
      where: { ...(opts.withClosed ? { isDeleted: false } : ACTIVE_WO_WHERE), ...(woWhere ? { workOrderNumber: woWhere } : {}) },
      orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
    }),
    prisma.workOrderExt.findMany(),
    prisma.routeStep.findMany({
      where: { status: 'OUT', ...(woWhere ? { part: { workOrderNumber: woWhere } } : {}) },
      select: { promisedReturnDate: true, part: { select: { workOrderNumber: true } } },
    }),
    prisma.issue.findMany({ where: { status: { in: OPEN_STATUSES }, ...(woWhere ? { workOrderNumber: woWhere } : {}) } }),
    // 已转异常的预警 activeKey 还在 = 对象仍停在原状态，问题没解决，照样算
    prisma.alert.findMany({
      where: { activeKey: { not: null }, status: { in: ['ACTIVE', 'CONVERTED'] }, level: { in: ['RED', 'YELLOW'] } },
      select: { id: true, refType: true, refId: true, level: true },
    }),
    syncOverview(),
    loadThresholds(),
    loadOffDays(),
    prisma.release.groupBy({
      by: ['workOrderNumber'],
      where: { status: 'ACTIVE', receipts: { some: { status: 'PENDING' } }, ...(woWhere ? { workOrderNumber: woWhere } : {}) },
      _count: { _all: true },
    }),
    prisma.purchaseLine.groupBy({
      by: ['workOrderNumber'],
      where: { status: 'OPEN', needDate: { lte: todayDate(now) }, ...(woWhere ? { workOrderNumber: woWhere } : {}) },
      _count: { _all: true },
    }),
    prisma.drawingTask.groupBy({
      by: ['workOrderNumber'],
      where: { AND: [overdueWhere(todayDate(now)), ...(woWhere ? [{ workOrderNumber: woWhere }] : [])] },
      _count: { _all: true },
    }),
  ])
  const incompleteNodes = await prisma.assemblyNode.groupBy({
    by: ['workOrderNumber'],
    where: { AND: [incompleteWhere(), dueWindowWhere(now, thresholds.W8), ...(woWhere ? [{ workOrderNumber: woWhere }] : [])] },
    _count: { _all: true },
  })
  const [plans, assemblies] = await Promise.all([
    loadPlans({ workOrderNumbers: workOrders.map((w) => w.workOrderNumber), publishedOnly: true }, now),
    prisma.assemblyNode.findMany({ where: { workOrderNumber: { in: workOrders.map((w) => w.workOrderNumber) } }, include: NODE_LINKS }),
  ])
  // 总装齐套率：每个工单一个主装配节点
  const mains = new Map<string, (typeof assemblies)[number]>()
  for (const wo of new Set(assemblies.map((a) => a.workOrderNumber))) {
    const main = pickMainAssembly(assemblies.filter((a) => a.workOrderNumber === wo).map((a) => ({ ...a, needDay: dateFieldDay(a.needDate) })))
    if (main) mains.set(wo, main)
  }
  const kits = await loadKitCounts([...mains.values()])
  const incompleteNodesOf = new Map(incompleteNodes.map((n) => [n.workOrderNumber, n._count._all]))
  const drawingOverdueOf = new Map(drawingOverdue.map((d) => [d.workOrderNumber, d._count._all]))
  const shortageOf = new Map(shortage.map((s) => [s.workOrderNumber, s._count._all]))
  const unsignedOf = new Map(unsigned.map((u) => [u.workOrderNumber, u._count._all]))
  const alertWo = await alertWorkOrders(alerts)
  const pmOf = new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId]))
  const names = await loadNames({ user: workOrders.map((w) => pmOf.get(w.workOrderNumber) ?? null) })

  const rows = workOrders.map((w) => {
    const wo = w.workOrderNumber
    const out = outSteps.filter((s) => s.part.workOrderNumber === wo)
    const overdueSteps = out.filter((s) => overdueDays(s.promisedReturnDate, now) > 0).length
    const open = issues.filter((i) => i.workOrderNumber === wo)
    const judged = open.map((i) => judgeW4({ status: i.status, createdAt: i.createdAt, dueDate: i.dueDate, now, offDays }, thresholds.W4))
    const overdueIssues = judged.filter((j) => j.overdueDays > 0).length
    const issueRed = judged.some((j) => j.overdueDays >= thresholds.W4.redDays)
    const issueYellow = judged.some((j) => !!j.level || j.overdueDays > 0)
    const mine = alerts.filter((a) => alertWo.get(a.id) === wo)
    const red = mine.filter((a) => a.level === 'RED').length
    const yellow = mine.length - red
    const color: BoardColor = red || issueRed ? 'RED' : yellow || issueYellow ? 'YELLOW' : 'GREEN'
    const pm = pmOf.get(wo) ?? null
    const plan = plans.get(wo)
    const est = new Map((plan?.forecast.nodes ?? []).map((e) => [e.id, e]))
    const planNodes = (plan?.nodes ?? []).map((n) => {
      const e = est.get(n.id)!
      return { id: n.id, seq: n.seq, name: n.name, dept: n.dept, deptText: BUSINESS_DEPT_NAME[n.dept], state: nodeState(e), planDate: dateFieldDay(n.planDate), expectedDate: e.expectedDay, selfDelayDays: e.selfDelayDays }
    })
    const stuck = stuckNode(planNodes)
    const main = mains.get(wo)
    const kit = main ? kits.get(main.id) : undefined
    return {
      workOrderNumber: wo,
      projectName: w.projectName,
      customerName: w.customerName,
      deliveryDate: w.deliveryDate,
      status: w.status,
      /** 已完工 / 已取消（只在 withClosed 时出现）；不进分组和汇总 */
      closed: isClosedWorkOrder(w.status),
      projectManagerId: pm,
      projectManagerName: pm ? (names.user.get(pm) ?? pm) : null,
      color,
      redAlerts: red,
      yellowAlerts: yellow,
      outCount: out.length,
      overdueCount: overdueSteps + overdueIssues,
      overdueSteps,
      overdueIssues,
      openIssues: open.length,
      unsignedReleases: unsignedOf.get(wo) ?? 0,
      shortage: shortageOf.get(wo) ?? 0,
      drawingOverdue: drawingOverdueOf.get(wo) ?? 0,
      incompleteNodes: incompleteNodesOf.get(wo) ?? 0,
      /** 已发布总计划的预计交期（'YYYY-MM-DD'）、拖期天数（正数 = 晚于 QMS 交期）、源头延误节点数（不含只因上游顺延的）；没有已发布总计划为 null / 0 */
      expectedDelivery: plan?.forecast.expectedDelivery ?? null,
      delayDays: plan?.forecast.deliveryDelayDays ?? null,
      delayedPlanNodes: plan?.forecast.sourceNodes ?? 0,
      /** 有已发布的总计划 */
      hasPlan: !!plan,
      /** 已发布总计划的节点摘要（按主线顺序）；state 见 shared/status.ts nodeState */
      planNodes,
      /** 当前卡点：最早的源头延误节点（名称、责任部门、自身晚几天） */
      stuck: stuck ? { id: stuck.id, name: stuck.name, deptText: stuck.deptText, days: stuck.selfDelayDays } : null,
      /** 总装齐套率（0–100）；没有装配节点或清单为空为 null */
      kitPercent: kit ? kitPercent(kit) : null,
    }
  })
  const rank = { RED: 0, YELLOW: 1, GREEN: 2 } as const
  rows.sort((a, b) => rank[a.color] - rank[b.color] || +a.deliveryDate - +b.deliveryDate)
  const active = rows.filter((r) => !r.closed)
  return {
    lastSyncAt: sync.lastSyncAt,
    syncOldest: sync.oldest,
    syncErrors: sync.errors,
    /** 源头延误节点按责任部门计数（项目总览"源头延误在哪个部门"） */
    sourceByDept: sourceByDept(active),
    summary: { red: active.filter((r) => r.color === 'RED').length, yellow: active.filter((r) => r.color === 'YELLOW').length, green: active.filter((r) => r.color === 'GREEN').length },
    rows,
  }
}
