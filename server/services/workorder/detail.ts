/**
 * 工单详情（前端改版第一轮，以工单为中心的页面）：一个工单的总计划、各部门挂在节点上的记录、齐套、预警、异常聚合在一起。
 * 只读，不另立统计口径：
 *   总计划、预计交期、拖期天数、挂靠记录、未挂节点数 —— 复用总计划页 getPlan（已发布 / 草稿都显示，草稿标出来）；
 *   总装齐套率、缺件原因 —— 复用齐套 loadKits；
 *   活动预警 —— 复用预警列表 listAlerts（同样按可见范围过滤）；
 *   未关闭异常 —— 复用异常列表 listIssues（超期按 W4 判定，与看板一致）。
 * 权限在接口层判断（能看到该工单才能看，看不到 403）。付款金额不在这里出现，采购记录只给"已付 / 付款未付"。
 * 所有日期都给 'YYYY-MM-DD' 字符串（工厂时区的"今天"也由服务端给），页面直接显示，不在浏览器按本地时区换算。
 */
import type { BusinessDept } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { dateFieldDay, dayDiff, shanghaiDay } from '../alerts/rules'
import { listAlerts, type Viewer } from '../alerts/reminders'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import type { RoleContext } from '../auth/permissions'
import { listIssues } from '../issues/issues'
import { NODE_LINKS, loadKits } from '../kitting/kitting'
import { getPlan } from '../plan/plan'
import { type NodeState, lagByDept, nodeState, sortActions, stuckNode } from '../../../shared/status'
import { paymentText, pickMainAssembly, reasonCounts, taskListLink, taskState } from './rules'

export async function getWorkOrderDetail(workOrderNumber: string, ctx: RoleContext, viewer: Viewer, visibleWorkOrders: string[] | undefined, now = new Date()) {
  const wo = await prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber } })
  if (!wo) return null
  const today = shanghaiDay(now)
  const [plan, planRow, alerts, issues, assemblies] = await Promise.all([
    getPlan(workOrderNumber, ctx, now),
    prisma.workOrderPlan.findUnique({ where: { workOrderNumber }, select: { createdAt: true, publishedAt: true } }),
    listAlerts({ workOrderNumber, visibleWorkOrders, viewer }, now),
    listIssues({ status: 'UNCLOSED', workOrderNumber, visibleWorkOrders }, viewer, now),
    prisma.assemblyNode.findMany({ where: { workOrderNumber }, include: NODE_LINKS }),
  ])

  // 采购行的付款情况（只要状态）
  const purchaseIds = plan.nodes.flatMap((n) => n.tasks.filter((t) => t.kind === 'purchase').map((t) => t.id))
  const pays = purchaseIds.length
    ? await prisma.purchaseLine.findMany({ where: { id: { in: purchaseIds } }, select: { id: true, payments: { select: { payment: { select: { status: true } } } } } })
    : []
  const payOf = new Map(pays.map((p) => [p.id, paymentText(p.payments.map((x) => x.payment.status))]))

  const nodes = plan.nodes.map((n) => {
    const state: NodeState = nodeState(n)
    return {
      id: n.id,
      seq: n.seq,
      name: n.name,
      dept: n.dept as BusinessDept,
      deptText: n.deptText,
      planDate: n.planDate,
      baselineDate: n.baselineDate,
      expectedDate: n.expectedDate,
      actualDate: n.actualDate,
      done: n.done,
      state,
      delayDays: n.delayDays,
      selfDelayDays: n.selfDelayDays,
      confirmText: n.confirmText,
      taskCount: n.taskCount,
      doneCount: n.doneCount,
      overdueCount: n.overdueCount,
      alertLevel: n.alertLevel,
      tasks: n.tasks.map((t) => {
        const st = taskState(t)
        return {
          kind: t.kind,
          kindText: t.kindText,
          id: t.id,
          name: t.name,
          state: st,
          statusText: t.statusText,
          dateLabel: t.dateLabel,
          planDate: t.planDate,
          expectedDate: t.expectedDate,
          /** 自己的日期已过几天（没完成时） */
          overdueDays: st === 'OVERDUE' && t.planDate ? dayDiff(t.planDate, today) : 0,
          payment: t.kind === 'purchase' ? (payOf.get(t.id) ?? null) : null,
          link: taskListLink(t.kind, workOrderNumber, t.id),
        }
      }),
    }
  })

  // 总装齐套率 + 缺件原因
  const main = pickMainAssembly(assemblies.map((a) => ({ ...a, needDay: dateFieldDay(a.needDate) })))
  const kit = main ? (await loadKits([main], now)).get(main.id)! : null

  const stuck = stuckNode(nodes)
  const red = alerts.filter((a) => a.level === 'RED').length
  const yellow = alerts.filter((a) => a.level === 'YELLOW').length
  const oldestAlert = alerts.length ? alerts.map((a) => shanghaiDay(a.firstAt)).reduce((a, b) => (a < b ? a : b)) : null
  const overdueIssues = issues.filter((i) => i.overdue)
  const issueDept = new Map<string, number>()
  for (const i of issues) issueDept.set(i.responsibleDeptName ?? '未指定', (issueDept.get(i.responsibleDeptName ?? '未指定') ?? 0) + 1)

  const actions = sortActions([
    ...alerts.map((a) => ({
      kind: 'alert' as const,
      id: a.id,
      level: a.level,
      weight: Math.max(0, dayDiff(shanghaiDay(a.firstAt), today)),
      title: a.subject,
      detail: a.summary,
      rule: a.rule as string | null,
      tag: null as string | null,
      owners: a.owners.map((o) => o.name).join('、') || null,
      link: a.link,
      issueNo: a.issue?.issueNo ?? null,
    })),
    ...issues.map((i) => ({
      kind: 'issue' as const,
      id: i.id,
      level: (i.overdue ? 'RED' : 'YELLOW') as 'RED' | 'YELLOW',
      weight: i.overdueDays,
      title: i.description,
      detail: [i.categoryText, i.statusText, i.overdue ? (i.overdueDays ? `超期 ${i.overdueDays} 天` : '待受理超时') : ''].filter(Boolean).join(' · '),
      rule: null as string | null,
      tag: i.issueNo as string | null,
      owners: [i.responsibleDeptName, i.responsibleUserName].filter(Boolean).join(' · ') || null,
      link: `/issues?id=${encodeURIComponent(i.id)}`,
      issueNo: i.issueNo,
    })),
  ])

  const published = plan.plan?.status === 'PUBLISHED'
  const planStart = planRow ? [shanghaiDay(planRow.createdAt), ...(planRow.publishedAt ? [shanghaiDay(planRow.publishedAt)] : [])].reduce((a, b) => (a < b ? a : b)) : null

  return {
    today,
    workOrder: {
      workOrderNumber,
      projectName: wo.projectName,
      customerName: wo.customerName,
      division: wo.division,
      quantity: wo.quantity,
      status: wo.status,
      deliveryDate: dateFieldDay(wo.deliveryDate),
      projectManagerName: plan.workOrder.projectManagerName,
    },
    plan: plan.plan ? { status: plan.plan.status, templateName: plan.plan.templateName, publishedByName: plan.plan.publishedByName, startDate: planStart } : null,
    published,
    canEditPlan: plan.canEdit,
    /** 预计交期、拖期天数：只按已发布的总计划算（与看板一致）；草稿时为 null */
    expectedDelivery: published ? plan.expectedDelivery : null,
    delayDays: published ? plan.deliveryDelayDays : null,
    progress: {
      total: nodes.length,
      done: nodes.filter((n) => n.state === 'DONE').length,
      onTrack: nodes.filter((n) => n.state === 'ON_TRACK').length,
      source: nodes.filter((n) => n.state === 'SOURCE').length,
      upstream: nodes.filter((n) => n.state === 'UPSTREAM').length,
    },
    stuck: stuck ? { id: stuck.id, name: stuck.name, deptText: stuck.deptText, days: stuck.selfDelayDays } : null,
    nodes,
    kitting: {
      nodeCount: assemblies.length,
      main: main && kit ? { id: main.id, name: main.name, needDate: main.needDay, percent: kit.percent, total: kit.total, ready: kit.ready, shortageCount: kit.shortages.length, reasons: reasonCounts(kit.shortages) } : null,
    },
    alerts: { red, yellow, total: alerts.length, oldestDate: oldestAlert },
    issues: {
      open: issues.length,
      overdue: overdueIssues.length,
      byDept: [...issueDept.entries()].map(([dept, count]) => ({ dept, count })).sort((a, b) => b.count - a.count),
    },
    actions,
    /** 谁在拖：源头延误节点按责任部门汇总自身延误天数 */
    lagByDept: lagByDept(nodes).map((d) => ({ ...d, deptText: BUSINESS_DEPT_NAME[d.dept] })),
    unlinked: plan.unlinked,
  }
}

export type WorkOrderDetail = NonNullable<Awaited<ReturnType<typeof getWorkOrderDetail>>>
