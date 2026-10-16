/**
 * 看板（技术选型 6.2）：每个工单一行——红黄绿、外协在途数、超期数、未关闭异常数、项目经理、交期；
 * 顶部显示 QMS 最后同步时间（sync_cursor 最新的 lastRunAt，没有则"未同步（演示数据）"）。
 *
 *   超期数 = 在外加工且已过承诺返回日的步骤 + 已过要求解决日的未关闭异常（待受理、处理中；待确认不算超期，与 W4 一致）
 *   红 = 有活动红色预警（含已转异常、但对象仍停在原状态的），或有超期 ≥ W4 红色阈值（默认 3 天）的异常
 *   黄 = 有活动黄色预警，或有超期的异常（含待受理超时）
 *   否则绿
 */
import { prisma } from '../../utils/prisma'
import { loadOffDays, loadThresholds } from '../alerts/config'
import { judgeW4 } from '../alerts/rules'
import { overdueDays } from '../flow/dates'
import { loadNames } from '../flow/names'
import { OPEN_STATUSES } from './constants'

export type BoardColor = 'RED' | 'YELLOW' | 'GREEN'

/** 活动预警 → 所属工单 */
async function alertWorkOrders(alerts: { id: string; refType: string; refId: string }[]) {
  const ids = (t: string) => alerts.filter((a) => a.refType === t).map((a) => a.refId)
  const [steps, inspections, issues] = await Promise.all([
    ids('step').length ? prisma.routeStep.findMany({ where: { id: { in: ids('step') } }, select: { id: true, part: { select: { workOrderNumber: true } } } }) : [],
    ids('unmatched').length ? prisma.qmsInspection.findMany({ where: { id: { in: ids('unmatched') } }, select: { id: true, workOrderNumber: true } }) : [],
    ids('issue').length ? prisma.issue.findMany({ where: { id: { in: ids('issue') } }, select: { id: true, workOrderNumber: true } }) : [],
  ])
  const wo = new Map<string, string>()
  for (const s of steps) wo.set(`step:${s.id}`, s.part.workOrderNumber)
  for (const i of inspections) wo.set(`unmatched:${i.id}`, i.workOrderNumber)
  for (const i of issues) wo.set(`issue:${i.id}`, i.workOrderNumber)
  return new Map(alerts.map((a) => [a.id, wo.get(`${a.refType}:${a.refId}`) ?? null]))
}

export async function getBoard(visibleWorkOrders: string[] | undefined, now = new Date()) {
  const woWhere = visibleWorkOrders ? { in: visibleWorkOrders } : undefined
  const [workOrders, exts, outSteps, issues, alerts, cursors, thresholds, offDays] = await Promise.all([
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
    prisma.syncCursor.findMany({ where: { lastRunAt: { not: null } }, orderBy: { lastRunAt: 'desc' }, take: 1 }),
    loadThresholds(),
    loadOffDays(),
  ])
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
    }
  })
  const rank = { RED: 0, YELLOW: 1, GREEN: 2 } as const
  rows.sort((a, b) => rank[a.color] - rank[b.color] || +a.deliveryDate - +b.deliveryDate)
  return {
    lastSyncAt: cursors[0]?.lastRunAt ?? null,
    summary: { red: rows.filter((r) => r.color === 'RED').length, yellow: rows.filter((r) => r.color === 'YELLOW').length, green: rows.filter((r) => r.color === 'GREEN').length },
    rows,
  }
}
