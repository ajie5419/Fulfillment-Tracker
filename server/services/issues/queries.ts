import type { Issue, IssueCategory } from '@prisma/client'
import { paginationSchema, type PageInput, type PageResult } from '../../../shared/pagination'
import { issueWhere, issuePageBuckets } from './paging'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { CATEGORY_TEXT, DEFAULT_DEPT_NAME, SUPPLIER_CATEGORIES } from './constants'
import type { Actor, IssueFilter } from './types'
import { decorate } from './loaders'
import { projectIssueDetail } from './projection'

const READ_BATCH_SIZE = 500

export type IssueRow = Awaited<ReturnType<typeof decorate>>[number]

export async function listIssues(filter: IssueFilter, actor: Actor, now = new Date()): Promise<IssueRow[]> {
  const where = issueWhere(filter, actor)
  const rows: IssueRow[] = []
  let after: Pick<Issue, 'createdAt' | 'id'> | undefined
  // 内部工单详情和兼容旧风险页 / 驾驶舱需要全量；明细分页另走 listIssuesPage。
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
  return rows.sort((a, b) => rank(a) - rank(b) || +b.createdAt - +a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** 规范分页入口：完整计算仅用于内部统计和旧客户端兼容的 listIssues。 */
export async function listIssuesPage(filter: IssueFilter, actor: Actor, now = new Date(), input: PageInput = {}): Promise<PageResult<IssueRow>> {
  const { page, pageSize } = paginationSchema.parse(input)
  const buckets = await issuePageBuckets(filter, actor, now)
  const counts = await Promise.all(buckets.map((where) => prisma.issue.count({ where })))
  let skip = (page - 1) * pageSize
  let remaining = pageSize
  const rows: Issue[] = []
  for (const [i, where] of buckets.entries()) {
    const count = counts[i] ?? 0
    if (skip >= count) { skip -= count; continue }
    const batch = await prisma.issue.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: remaining })
    rows.push(...batch)
    remaining -= batch.length
    skip = 0
    if (!remaining) break
  }
  return { rows: await decorate(rows, actor, now), total: counts.reduce((a, b) => a + b, 0), page, pageSize }
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
