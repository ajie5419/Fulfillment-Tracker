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
 *   出图逾期（R11）= 该工单上逾期的出图任务数（待出图已过计划完成日、或客户确认已过计划日；只显示，预警由 W7 计入红黄）
 *   未齐套节点（R12）= 该工单上已进入 W8 预警窗口（需求日前 N 天内，含已过）仍未齐套的装配节点数（只显示，预警由 W8 计入红黄）。
 *     远期节点还没齐是正常的，不计入，免得这一列永远是一大串数字没人看
 *   预计交期、拖期天数（R14）= 已发布总计划的最后一个节点的预计完成日、它比 QMS 交期晚几天（负数 = 提前；只显示，延误由 W9 计入红黄）；
 *     没有总计划或还是草稿时为空
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
import { OPEN_STATUSES } from './constants'

export type BoardColor = 'RED' | 'YELLOW' | 'GREEN'

/** 活动预警 → 所属工单 */
async function alertWorkOrders(alerts: { id: string; refType: string; refId: string }[]) {
  const ids = (t: string) => alerts.filter((a) => a.refType === t).map((a) => a.refId)
  const planIds = alerts.filter((a) => a.refType === 'planNode' || a.refType === 'planConfirm').map((a) => a.refId)
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
  for (const n of planNodes) {
    wo.set(`planNode:${n.id}`, n.workOrderNumber)
    wo.set(`planConfirm:${n.id}`, n.workOrderNumber)
  }
  return new Map(alerts.map((a) => [a.id, wo.get(`${a.refType}:${a.refId}`) ?? null]))
}

export async function getBoard(visibleWorkOrders: string[] | undefined, now = new Date()) {
  const woWhere = visibleWorkOrders ? { in: visibleWorkOrders } : undefined
  const [workOrders, exts, outSteps, issues, alerts, sync, thresholds, offDays, unsigned, shortage, drawingOverdue] = await Promise.all([
    prisma.qmsWorkOrder.findMany({
      where: { isDeleted: false, ...(woWhere ? { workOrderNumber: woWhere } : {}) },
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
  const plans = await loadPlans({ workOrderNumbers: workOrders.map((w) => w.workOrderNumber), publishedOnly: true }, now)
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
    return {
      workOrderNumber: wo,
      projectName: w.projectName,
      customerName: w.customerName,
      deliveryDate: w.deliveryDate,
      status: w.status,
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
      /** 已发布总计划的预计交期（'YYYY-MM-DD'）、拖期天数（正数 = 晚于 QMS 交期）、延误节点数；没有已发布总计划为 null / 0 */
      expectedDelivery: plan?.forecast.expectedDelivery ?? null,
      delayDays: plan?.forecast.deliveryDelayDays ?? null,
      delayedPlanNodes: plan?.forecast.delayedNodes ?? 0,
    }
  })
  const rank = { RED: 0, YELLOW: 1, GREEN: 2 } as const
  rows.sort((a, b) => rank[a.color] - rank[b.color] || +a.deliveryDate - +b.deliveryDate)
  return {
    lastSyncAt: sync.lastSyncAt,
    syncOldest: sync.oldest,
    syncErrors: sync.errors,
    summary: { red: rows.filter((r) => r.color === 'RED').length, yellow: rows.filter((r) => r.color === 'YELLOW').length, green: rows.filter((r) => r.color === 'GREEN').length },
    rows,
  }
}
