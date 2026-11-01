import type { Issue, IssueCategory, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { CATEGORY_TEXT, DEFAULT_DEPT_NAME, OPEN_STATUSES, SUPPLIER_CATEGORIES } from './constants'
import type { Actor, IssueFilter } from './types'
import { decorate } from './loaders'
import { projectIssueDetail } from './projection'

const READ_BATCH_SIZE = 500

export type IssueRow = Awaited<ReturnType<typeof decorate>>[number]

export async function listIssues(filter: IssueFilter, actor: Actor, now = new Date()): Promise<IssueRow[]> {
  const where: Prisma.IssueWhereInput = {}
  if (filter.status === 'UNCLOSED') where.status = { in: OPEN_STATUSES }
  else if (filter.status) where.status = filter.status
  if (filter.category) where.category = filter.category
  const wo: Prisma.StringFilter = {}
  if (filter.visibleWorkOrders) wo.in = filter.visibleWorkOrders
  if (filter.workOrderNumber) wo.equals = filter.workOrderNumber
  if (Object.keys(wo).length) where.workOrderNumber = wo
  if (filter.deptIds) where.responsibleDeptId = { in: filter.deptIds }
  if (filter.mine === 'responsible') where.responsibleUserId = actor.userId
  if (filter.mine === 'reported') where.reporterId = actor.userId
  if (filter.mine === 'todo' && !where.status) where.status = { in: OPEN_STATUSES }
  const rows: IssueRow[] = []
  let after: Pick<Issue, 'createdAt' | 'id'> | undefined
  // Consumers use the complete array for totals and local paging. A read batch is not a result limit:
  // even an empty filtered batch may have actionable/overdue records behind it. ID breaks timestamp ties.
  for (;;) {
    const issues = await prisma.issue.findMany({
      where: after ? { AND: [where, { OR: [
        { createdAt: { lt: after.createdAt } },
        { createdAt: after.createdAt, id: { lt: after.id } },
      ] }] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: READ_BATCH_SIZE,
    })
    if (!issues.length) break
    let batch = await decorate(issues, actor, now)
    if (filter.mine === 'todo') batch = batch.filter((r) => r.can.accept || r.can.resolve || r.can.close)
    if (filter.overdue) batch = batch.filter((r) => r.overdue)
    rows.push(...batch)
    if (issues.length < READ_BATCH_SIZE) break
    const last = issues[issues.length - 1]!
    after = { createdAt: last.createdAt, id: last.id }
  }
  // 未关闭在前，其中超期在前
  const rank = (r: IssueRow) => (r.status === 'CLOSED' ? 2 : r.overdue ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b) || +b.createdAt - +a.createdAt)
}

/** 详情：附处理日志（时间线）、照片地址 */
export async function getIssue(id: string, actor: Actor, now = new Date()) {
  const issue = await prisma.issue.findUnique({ where: { id }, include: { logs: { orderBy: { createdAt: 'asc' } } } })
  if (!issue) throw new FlowError('异常不存在', 'NOT_FOUND')
  const [row] = await decorate([issue], actor, now)
  const names = await loadNames({ user: issue.logs.map((l) => l.actorId) })
  const photoIds = Array.isArray(issue.photos) ? (issue.photos as string[]) : []
  const converted = issue.source === 'ALERT' && issue.sourceKey ? await prisma.alert.findUnique({ where: { id: issue.sourceKey.slice('ALERT:'.length) }, select: { rule: true, level: true } }) : null
  return projectIssueDetail(issue, row, names, photoIds, converted)
}

/** 某步骤上未关闭的异常（工件页"有异常"跳转用） */
export async function openIssuesOfSteps(stepIds: string[]) {
  if (!stepIds.length) return new Map<string, { id: string; issueNo: string }[]>()
  const rows = await prisma.issue.findMany({
    where: { refType: 'STEP', refId: { in: stepIds }, status: { not: 'CLOSED' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, issueNo: true, refId: true },
  })
  const out = new Map<string, { id: string; issueNo: string }[]>()
  for (const r of rows) out.set(r.refId!, [...(out.get(r.refId!) ?? []), { id: r.id, issueNo: r.issueNo }])
  return out
}

/** 上报页、改派用的下拉：分类（带默认部门）、部门 */
export async function issueOptions() {
  const depts = await prisma.qmsDepartment.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' }, select: { id: true, name: true } })
  return {
    categories: (Object.keys(CATEGORY_TEXT) as IssueCategory[]).map((c) => ({
      value: c,
      label: CATEGORY_TEXT[c],
      deptName: DEFAULT_DEPT_NAME[c],
      supplier: SUPPLIER_CATEGORIES.includes(c),
    })),
    departments: depts,
  }
}
