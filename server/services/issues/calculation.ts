import type { Issue } from '@prisma/client'
import type { PermContext, IssuePermissions } from './types'

export function issuePermissions(issue: Pick<Issue, 'status' | 'responsibleDeptId' | 'responsibleUserId' | 'reporterId' | 'workOrderNumber'>, ctx: PermContext): IssuePermissions {
  const uid = ctx.actor.userId
  const admin = ctx.actor.isAdmin
  const deptName = issue.responsibleDeptId ? ctx.deptName.get(issue.responsibleDeptId) : undefined
  const isDeptHead = !!deptName && ctx.roles.some((r) => r.role === 'DEPT_HEAD' && r.department === deptName)
  const isPM = ctx.pmOf.get(issue.workOrderNumber) === uid
  const isPDH = ctx.roles.some((r) => r.role === 'PROJECT_DEPT_HEAD')
  const isReporter = !!issue.reporterId && issue.reporterId === uid
  const handler = admin || issue.responsibleUserId === uid || isDeptHead
  const assigner = admin || isDeptHead || isPM || isPDH
  const confirmer = admin || isReporter || isPM || isPDH
  return {
    accept: issue.status === 'OPEN' && (handler || (!issue.responsibleUserId && isReporter)),
    resolve: issue.status === 'ACCEPTED' && handler,
    reassign: (issue.status === 'OPEN' || issue.status === 'ACCEPTED') && assigner,
    close: issue.status === 'RESOLVED' && confirmer,
    reject: issue.status === 'RESOLVED' && confirmer,
    note: true,
  }
}

export const joinNote = (parts: (string | null | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join('；') || null
