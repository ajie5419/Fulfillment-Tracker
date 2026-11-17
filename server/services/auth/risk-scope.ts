import type { Issue, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { deptIdsResolvingTo, loadDeptIndex } from './departments'
import type { Target } from '../alerts/types'

export interface RiskScope {
  userId: string
  all: boolean
  workOrders: string[]
  departmentKeys: string[]
  departmentIds: string[]
}

/** Risk access follows responsibility, not the broader collaborative work-order browsing scope. */
export async function resolveRiskScope(actor: { userId: string; isAdmin: boolean }): Promise<RiskScope> {
  const scope: RiskScope = { userId: actor.userId, all: actor.isAdmin, workOrders: [], departmentKeys: [], departmentIds: [] }
  if (scope.all) return scope
  const [roles, orders] = await Promise.all([
    prisma.notifyRole.findMany({ where: { userId: actor.userId }, select: { role: true, department: true } }),
    prisma.workOrderExt.findMany({ where: { projectManagerId: actor.userId }, select: { workOrderNumber: true } }),
  ])
  scope.all = roles.some(r => r.role === 'LEADER' || r.role === 'PROJECT_DEPT_HEAD')
  scope.workOrders = orders.map(o => o.workOrderNumber)
  scope.departmentKeys = [...new Set(roles.flatMap(r => r.role === 'DEPT_HEAD' && r.department ? [r.department] : []))]
  if (!scope.all && scope.departmentKeys.length) {
    const index = await loadDeptIndex()
    scope.departmentIds = [...new Set(scope.departmentKeys.flatMap(key => deptIdsResolvingTo(key, index)))]
  }
  return scope
}

/** SQL scope is composed with client filters using AND, so dept=0/mine/status can never widen access. */
export function riskIssueWhere(scope: RiskScope): Prisma.IssueWhereInput {
  if (scope.all) return {}
  return { OR: [
    { responsibleUserId: scope.userId },
    { reporterId: scope.userId },
    { workOrderNumber: { in: scope.workOrders } },
    { responsibleDeptId: { in: scope.departmentIds } },
  ] }
}

export function canReadRiskIssue(scope: RiskScope, issue: Pick<Issue, 'responsibleUserId' | 'reporterId' | 'workOrderNumber' | 'responsibleDeptId'>): boolean {
  return scope.all || issue.responsibleUserId === scope.userId || issue.reporterId === scope.userId
    || scope.workOrders.includes(issue.workOrderNumber)
    || (!!issue.responsibleDeptId && scope.departmentIds.includes(issue.responsibleDeptId))
}

/** Watchers can follow a handoff across departments without acquiring the recipient's write permission. */
export function canReadRiskTarget(scope: RiskScope, target: Pick<Target, 'ownerIds' | 'watcherIds' | 'departmentKeys' | 'workOrderNumber'>, ownerDepartments: ReadonlyMap<string, string>): boolean {
  return scope.all || target.ownerIds.includes(scope.userId) || !!target.watcherIds?.includes(scope.userId)
    || (!!target.workOrderNumber && scope.workOrders.includes(target.workOrderNumber))
    || (target.departmentKeys ?? target.ownerIds.flatMap(id => ownerDepartments.get(id) ?? [])).some(key => scope.departmentKeys.includes(key))
}
