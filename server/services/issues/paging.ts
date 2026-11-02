/** 数据库分页的筛选条件：权限与超期结果必须和单条投影一致。 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { loadOffDays, loadThresholds } from '../alerts/config'
import { DAY_MS, shanghaiDay, type RuleThreshold } from '../alerts/rules'
import { deptIdsResolvingTo, loadDeptIndex } from '../auth/departments'
import { OPEN_STATUSES } from './constants'
import { judgeIssueOverdue } from './overdue'
import type { Actor, IssueFilter } from './types'

export function issueWhere(filter: IssueFilter, actor: Actor): Prisma.IssueWhereInput {
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
  return where
}

/** 反求单调判定的最后一个 true；毫秒边界使用已有规则计算，避免另写一套停工日算法。 */
function lastTrue(lo: number, hi: number, predicate: (n: number) => boolean) {
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2)
    if (predicate(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function overdueIssueWhere(now: Date, offDays: string[], threshold: RuleThreshold): Prisma.IssueWhereInput {
  const judged = (status: 'OPEN' | 'ACCEPTED', createdAt: Date, dueDate: Date | null) => judgeIssueOverdue({ status, createdAt, dueDate, now, offDays }, threshold).overdue
  // 停工日最多扣 offDays.length 天，向前这么多天足以得到已超期的左边界。
  const openStart = +now - (threshold.yellowDays + offDays.length + 1) * DAY_MS
  const openThrough = new Date(lastTrue(openStart, +now, (ms) => judged('OPEN', new Date(ms), null)))
  const today = +new Date(shanghaiDay(now)) / DAY_MS
  const dueThrough = new Date(lastTrue(today - offDays.length - 2, today, (day) => judged('ACCEPTED', now, new Date(day * DAY_MS))) * DAY_MS)
  return { OR: [
    { status: 'OPEN', ...(threshold.yellowDays > 0 ? { createdAt: { lte: openThrough } } : {}) },
    { status: { in: ['OPEN', 'ACCEPTED'] }, dueDate: { not: null, lt: new Date(+dueThrough + DAY_MS) } },
  ] }
}

/** 与 issuePermissions 的 accept / resolve / close 对照测试；这里只加载人员/工单元数据，不扫描异常。 */
export async function actionableIssueWhere(actor: Actor): Promise<Prisma.IssueWhereInput> {
  if (actor.isAdmin) return { status: { in: OPEN_STATUSES } }
  const [roles, managed, index] = await Promise.all([
    prisma.notifyRole.findMany({ where: { userId: actor.userId }, select: { role: true, department: true } }),
    prisma.workOrderExt.findMany({ where: { projectManagerId: actor.userId }, select: { workOrderNumber: true } }),
    loadDeptIndex(),
  ])
  const depts = roles.filter((r) => r.role === 'DEPT_HEAD' && r.department).flatMap((r) => deptIdsResolvingTo(r.department ?? '', index))
  return { OR: [
    { status: { in: ['OPEN', 'ACCEPTED'] }, OR: [{ responsibleUserId: actor.userId }, { responsibleDeptId: { in: depts } }] },
    { status: 'OPEN', responsibleUserId: null, reporterId: actor.userId },
    { status: 'RESOLVED', ...(roles.some((r) => r.role === 'PROJECT_DEPT_HEAD') ? {} : {
      OR: [{ reporterId: actor.userId }, { workOrderNumber: { in: managed.map((m) => m.workOrderNumber) } }],
    }) },
  ] }
}

/** 排序分桶：超期 → 其余未关闭 → 已关闭。每桶用数据库 count/skip/take，不在内存累积异常。 */
export async function issuePageBuckets(filter: IssueFilter, actor: Actor, now: Date): Promise<Prisma.IssueWhereInput[]> {
  const [thresholds, offDays, actionable] = await Promise.all([
    loadThresholds(), loadOffDays(), filter.mine === 'todo' ? actionableIssueWhere(actor) : undefined,
  ])
  const base = issueWhere(filter, actor)
  const overdue = overdueIssueWhere(now, offDays, thresholds.W4)
  const common = [base, ...(actionable ? [actionable] : [])]
  if (filter.overdue) return [{ AND: [...common, overdue] }]
  return [
    { AND: [...common, overdue] },
    { AND: [...common, { status: { not: 'CLOSED' } }, { NOT: overdue }] },
    { AND: [...common, { status: 'CLOSED' }] },
  ]
}
