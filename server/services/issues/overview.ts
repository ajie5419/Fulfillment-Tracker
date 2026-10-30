/**
 * 领导总览（权限方案 R13 第四节）：一屏看全局。数据和看板同源（getBoard），不另立统计口径：
 *   顶部数字：红/黄/绿工单数（看板）、本周新增异常、本周关闭异常、超期异常（看板各工单"超期异常"之和）；
 *   卡在哪个环节：设计逾期、采购缺料、外协超期未返、未齐套节点、超期异常（都是看板对应列之和）；
 *   按部门：未关闭异常按责任部门（换算成业务部门）统计，超期按 W4 判定（与看板一致）；
 *   红色工单清单：工单号、项目、项目经理、交期、主要原因（由看板该行的各项数字拼成）；
 *   预计拖期工单（R14）：已发布总计划、预计交期晚于 QMS 交期的工单（看板"拖期天数"> 0），附最先延误的节点；
 *   按部门延误节点数（R14）：已发布总计划里没完成、预计晚于计划日的节点，按节点责任部门统计。
 * "本周" = 工厂时区（北京时间）本周一 00:00 起。
 */
import { prisma } from '../../utils/prisma'
import { loadOffDays, loadThresholds } from '../alerts/config'
import { judgeW4, shanghaiDay, shanghaiDayStart } from '../alerts/rules'
import { BUSINESS_DEPTS, BUSINESS_DEPT_NAME, resolveDeptNames } from '../auth/departments'
import { loadPlans } from '../plan/plan'
import { getBoard } from './board'
import { OPEN_STATUSES } from './constants'
import { redWorkOrderStages } from '../../../shared/board-cockpit'

/** 工厂时区本周一 00:00（周一算一周的第一天） */
export function weekStart(now: Date): Date {
  const day = shanghaiDay(now)
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay() // 0 = 周日
  const back = (dow + 6) % 7
  const monday = new Date(Date.parse(`${day}T00:00:00.000Z`) - back * 86_400_000).toISOString().slice(0, 10)
  return new Date(shanghaiDayStart(monday))
}

type BoardRow = Awaited<ReturnType<typeof getBoard>>['rows'][number]

/** 红色工单的主要原因：看板该行非零的几项，按严重程度排 */
export function redReason(r: Pick<BoardRow, 'redAlerts' | 'overdueIssues' | 'overdueSteps' | 'shortage' | 'drawingOverdue' | 'incompleteNodes' | 'unsignedReleases'>): string {
  const parts = [
    r.redAlerts ? `红色预警 ${r.redAlerts} 项` : '',
    r.overdueIssues ? `超期异常 ${r.overdueIssues} 项` : '',
    r.overdueSteps ? `外协超期未返 ${r.overdueSteps} 项` : '',
    r.shortage ? `缺料 ${r.shortage} 项` : '',
    r.drawingOverdue ? `设计逾期 ${r.drawingOverdue} 项` : '',
    r.incompleteNodes ? `未齐套节点 ${r.incompleteNodes} 个` : '',
    r.unsignedReleases ? `未签收发放 ${r.unsignedReleases} 份` : '',
  ].filter(Boolean)
  return parts.join('；') || '—'
}

export async function getOverview(now = new Date()) {
  const since = weekStart(now)
  const [board, newIssues, closedLogs, openIssues, thresholds, offDays, plans] = await Promise.all([
    getBoard(undefined, now),
    prisma.issue.count({ where: { createdAt: { gte: since } } }),
    prisma.issueLog.findMany({ where: { toStatus: 'CLOSED', createdAt: { gte: since } }, select: { issueId: true }, distinct: ['issueId'] }),
    prisma.issue.findMany({ where: { status: { in: OPEN_STATUSES } }, select: { status: true, createdAt: true, dueDate: true, responsibleDeptId: true } }),
    loadThresholds(),
    loadOffDays(),
    loadPlans({ publishedOnly: true }, now),
  ])
  const sum = (k: keyof Pick<BoardRow, 'overdueIssues' | 'overdueSteps' | 'shortage' | 'drawingOverdue' | 'incompleteNodes'>) => board.rows.reduce((n, r) => n + r[k], 0)

  // 按责任部门：QMS 部门换成业务部门名称（没对照时用部门名称本身），没写责任部门的归"未指定"
  const deptName = await resolveDeptNames(openIssues.map((i) => i.responsibleDeptId))
  const byDept = new Map<string, { dept: string; open: number; overdue: number }>()
  for (const i of openIssues) {
    const dept = (i.responsibleDeptId && (deptName.get(i.responsibleDeptId) ?? i.responsibleDeptId)) || '未指定'
    const row = byDept.get(dept) ?? { dept, open: 0, overdue: 0 }
    row.open++
    if (judgeW4({ status: i.status, createdAt: i.createdAt, dueDate: i.dueDate, now, offDays }, thresholds.W4).overdueDays > 0) row.overdue++
    byDept.set(dept, row)
  }

  // 总计划（R14）：只算看板上有的工单（QMS 里还在、没完工 / 取消的）
  const onBoard = new Set(board.rows.map((r) => r.workOrderNumber))
  const deptDelayed = new Map(BUSINESS_DEPTS.map((d) => [d, { dept: d, deptText: BUSINESS_DEPT_NAME[d], delayed: 0, open: 0 }]))
  for (const p of plans.values()) {
    if (!onBoard.has(p.workOrderNumber)) continue
    for (const n of p.nodes) {
      const e = p.forecast.nodes.find((x) => x.id === n.id)!
      if (e.done) continue
      const row = deptDelayed.get(n.dept)!
      row.open++
      if (e.source) row.delayed++ // 源头延误节点（只因上游顺延的不算）
    }
  }
  const firstDelayed = (wo: string) => {
    const p = plans.get(wo)
    const e = p?.forecast.nodes.find((x) => x.source)
    const n = e && p!.nodes.find((x) => x.id === e.id)
    return n ? `${n.name}（${BUSINESS_DEPT_NAME[n.dept]}）自身晚 ${e!.selfDelayDays} 天` : '—'
  }

  return {
    weekStart: since,
    summary: {
      ...board.summary,
      newIssues: newIssues,
      closedIssues: closedLogs.length,
      overdueIssues: sum('overdueIssues'),
    },
    stages: [
      { key: 'drawing', label: '设计逾期', count: sum('drawingOverdue'), link: '/drawings?view=overdue' },
      { key: 'shortage', label: '采购缺料', count: sum('shortage'), link: '/purchases?view=shortage' },
      { key: 'outsource', label: '外协超期未返', count: sum('overdueSteps'), link: '/alerts?rule=W3' },
      { key: 'kitting', label: '未齐套节点', count: sum('incompleteNodes'), link: '/kitting?incomplete=1' },
      { key: 'issue', label: '超期异常', count: sum('overdueIssues'), link: '/issues?overdue=1&dept=0' },
    ],
    byDept: [...byDept.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.dept.localeCompare(b.dept, 'zh-CN')),
    redStages: redWorkOrderStages(board.rows),
    redWorkOrders: board.rows
      .filter((r) => r.color === 'RED')
      .map((r) => ({
        workOrderNumber: r.workOrderNumber,
        projectName: r.projectName ?? r.customerName,
        projectManagerName: r.projectManagerName,
        deliveryDate: r.deliveryDate,
        reason: redReason(r),
        delayDays: r.delayDays,
        shortage: r.shortage,
        purchasePending: r.purchasePending,
        drawingOverdue: r.drawingOverdue,
        overdueIssues: r.overdueIssues,
        overdueSteps: r.overdueSteps,
        incompleteNodes: r.incompleteNodes,
        unsignedReleases: r.unsignedReleases,
        stagnationRedDays: r.stagnationRedDays,
        stagnationYellowDays: r.stagnationYellowDays,
      })),
    planDelays: board.rows
      .filter((r) => (r.delayDays ?? 0) > 0)
      .sort((a, b) => b.delayDays! - a.delayDays! || +a.deliveryDate - +b.deliveryDate)
      .map((r) => ({
        workOrderNumber: r.workOrderNumber,
        projectName: r.projectName ?? r.customerName,
        projectManagerName: r.projectManagerName,
        deliveryDate: r.deliveryDate,
        expectedDelivery: r.expectedDelivery,
        delayDays: r.delayDays,
        delayedNodes: r.delayedPlanNodes,
        cause: firstDelayed(r.workOrderNumber),
      })),
    planByDept: [...deptDelayed.values()].filter((d) => d.open > 0).sort((a, b) => b.delayed - a.delayed || b.open - a.open),
  }
}
