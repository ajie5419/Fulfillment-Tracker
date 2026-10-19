/**
 * 领导总览（权限方案 R13 第四节）：一屏看全局。数据和看板同源（getBoard），不另立统计口径：
 *   顶部数字：红/黄/绿工单数（看板）、本周新增异常、本周关闭异常、超期异常（看板各工单"超期异常"之和）；
 *   卡在哪个环节：设计出图逾期、采购缺料、外协超期未返、未齐套节点、超期异常（都是看板对应列之和）；
 *   按部门：未关闭异常按责任部门（换算成业务部门）统计，超期按 W4 判定（与看板一致）；
 *   红色工单清单：工单号、项目、项目经理、交期、主要原因（由看板该行的各项数字拼成）。
 * "本周" = 工厂时区（北京时间）本周一 00:00 起。
 */
import { prisma } from '../../utils/prisma'
import { loadOffDays, loadThresholds } from '../alerts/config'
import { judgeW4, shanghaiDay, shanghaiDayStart } from '../alerts/rules'
import { resolveDeptNames } from '../auth/departments'
import { getBoard } from './board'
import { OPEN_STATUSES } from './constants'

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
    r.drawingOverdue ? `出图逾期 ${r.drawingOverdue} 项` : '',
    r.incompleteNodes ? `未齐套节点 ${r.incompleteNodes} 个` : '',
    r.unsignedReleases ? `未签收发放 ${r.unsignedReleases} 份` : '',
  ].filter(Boolean)
  return parts.join('；') || '—'
}

export async function getOverview(now = new Date()) {
  const since = weekStart(now)
  const [board, newIssues, closedLogs, openIssues, thresholds, offDays] = await Promise.all([
    getBoard(undefined, now),
    prisma.issue.count({ where: { createdAt: { gte: since } } }),
    prisma.issueLog.findMany({ where: { toStatus: 'CLOSED', createdAt: { gte: since } }, select: { issueId: true }, distinct: ['issueId'] }),
    prisma.issue.findMany({ where: { status: { in: OPEN_STATUSES } }, select: { status: true, createdAt: true, dueDate: true, responsibleDeptId: true } }),
    loadThresholds(),
    loadOffDays(),
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

  return {
    weekStart: since,
    summary: {
      ...board.summary,
      newIssues: newIssues,
      closedIssues: closedLogs.length,
      overdueIssues: sum('overdueIssues'),
    },
    stages: [
      { key: 'drawing', label: '设计出图逾期', count: sum('drawingOverdue'), link: '/drawings?view=overdue' },
      { key: 'shortage', label: '采购缺料', count: sum('shortage'), link: '/purchases?view=shortage' },
      { key: 'outsource', label: '外协超期未返', count: sum('overdueSteps'), link: '/alerts?rule=W3' },
      { key: 'kitting', label: '未齐套节点', count: sum('incompleteNodes'), link: '/kitting?incomplete=1' },
      { key: 'issue', label: '超期异常', count: sum('overdueIssues'), link: '/issues?overdue=1&dept=0' },
    ],
    byDept: [...byDept.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.dept.localeCompare(b.dept, 'zh-CN')),
    redWorkOrders: board.rows
      .filter((r) => r.color === 'RED')
      .map((r) => ({
        workOrderNumber: r.workOrderNumber,
        projectName: r.projectName ?? r.customerName,
        projectManagerName: r.projectManagerName,
        deliveryDate: r.deliveryDate,
        reason: redReason(r),
      })),
  }
}
