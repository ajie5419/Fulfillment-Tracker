/** 异常展示投影：名称、W4 判定、权限及详情时间线。 */
import type { Alert, Issue, Prisma } from '@prisma/client'
import type { NameMaps } from '../flow/names'
import { judgeW4 } from '../alerts/rules'
import { resolveDeptName } from '../auth/departments'
import { CATEGORY_TEXT, STATUS_TEXT } from './constants'
import { issuePermissions } from './calculation'
import type { loadIssueSources } from './loaders'

export function projectIssues(issues: Issue[], { ctx, thresholds, offDays, depts, deptIndex, steps, parts, alerts, names }: Awaited<ReturnType<typeof loadIssueSources>>, now: Date) {
  const deptName = new Map(depts.map((d) => [d.id, d.name]))
  const stepById = new Map(steps.map((s) => [s.id, s]))
  const partById = new Map(parts.map((p) => [p.id, p]))
  const w4 = new Map(alerts.map((a) => [a.refId, a.level]))
  return issues.map((i) => {
    const step = i.refType === 'STEP' && i.refId ? stepById.get(i.refId) : undefined
    const part = step?.part ?? (i.refType === 'PART' && i.refId ? partById.get(i.refId) : undefined)
    const judged = judgeW4({ status: i.status, createdAt: i.createdAt, dueDate: i.dueDate, now, offDays }, thresholds.W4)
    return {
      id: i.id,
      issueNo: i.issueNo,
      workOrderNumber: i.workOrderNumber,
      refType: i.refType,
      refId: i.refId,
      refText: step ? `${step.part.name} · ${names.process.get(step.processId) ?? step.processId}` : part ? part.name : null,
      partId: part?.id ?? null,
      stepId: step?.id ?? null,
      stepStatus: step?.status ?? null,
      category: i.category,
      categoryText: CATEGORY_TEXT[i.category],
      title: i.title,
      description: i.description,
      photoCount: Array.isArray(i.photos) ? i.photos.length : 0,
      source: i.source,
      reporterId: i.reporterId,
      reporterName: i.reporterId ? (names.user.get(i.reporterId) ?? i.reporterId) : null,
      responsibleDeptId: i.responsibleDeptId,
      responsibleDeptName: i.responsibleDeptId ? (deptName.get(i.responsibleDeptId) ?? i.responsibleDeptId) : null,
      /** 责任部门换算成的业务部门名称（风险页按部门汇总，与预警的责任部门同一口径）；换算不出时为 QMS 部门名称，没有责任部门为 null */
      deptGroup: resolveDeptName(i.responsibleDeptId, deptIndex),
      responsibleUserId: i.responsibleUserId,
      responsibleUserName: i.responsibleUserId ? (names.user.get(i.responsibleUserId) ?? i.responsibleUserId) : null,
      responsibleSupplierId: i.responsibleSupplierId,
      responsibleSupplierName: i.responsibleSupplierId ? (names.supplier.get(i.responsibleSupplierId) ?? i.responsibleSupplierId) : null,
      dueDate: i.dueDate,
      status: i.status,
      statusText: STATUS_TEXT[i.status],
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      /** 超期：待受理超阈值、或过要求解决日（待确认、已关闭不算） */
      overdue: !!judged.level,
      overdueDays: judged.overdueDays,
      /** 当前 W4 预警级别（扫描任务写入的） */
      alertLevel: w4.get(i.id) ?? null,
      can: issuePermissions(i, ctx),
    }
  })
}

export function projectIssueDetail(issue: Prisma.IssueGetPayload<{ include: { logs: true } }>, row: ReturnType<typeof projectIssues>[number] | undefined, names: NameMaps, photoIds: string[], converted: Pick<Alert, 'rule' | 'level'> | null) {
  return {
    ...row!,
    photos: photoIds.map((pid) => ({ id: pid, url: `/api/files/${pid}` })),
    fromAlert: converted,
    logs: issue.logs.map((l) => ({
      id: l.id,
      fromStatus: l.fromStatus,
      toStatus: l.toStatus,
      note: l.note,
      actorId: l.actorId,
      actorName: l.actorId ? (names.user.get(l.actorId) ?? l.actorId) : '系统',
      createdAt: l.createdAt,
    })),
  }
}
