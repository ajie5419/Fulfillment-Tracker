import type { Prisma } from '@prisma/client'
import { logContext } from '../../observability/context'

interface AuditEntry {
  action: string
  entityType: string
  entityId: string
  actorId?: string | null
  metadata?: Prisma.InputJsonObject
}

/** Call with the business transaction, never a second connection or a best-effort catch. */
export async function recordAudit(tx: Prisma.TransactionClient, entry: AuditEntry) {
  const context = logContext.getStore()
  return tx.auditLog.create({ data: {
    ...entry, metadata: entry.metadata ?? {},
    actorId: entry.actorId === undefined ? context?.actorId ?? null : entry.actorId,
    requestId: context?.requestId ?? null,
  } })
}

export async function recordIssueLog(tx: Prisma.TransactionClient, args: { data: Prisma.IssueLogUncheckedCreateInput }) {
  const result = await tx.issueLog.create(args)
  const d = args.data
  await recordAudit(tx, { action: 'issue.log', entityType: 'Issue', entityId: d.issueId, actorId: d.actorId,
    metadata: { fromStatus: d.fromStatus ?? null, toStatus: d.toStatus ?? null } })
  return result
}

export async function recordPlanChange(tx: Prisma.TransactionClient, args: { data: Prisma.PlanChangeLogUncheckedCreateInput }) {
  const result = await tx.planChangeLog.create(args)
  const d = args.data
  await recordAudit(tx, { action: 'plan.change', entityType: 'PlanNode', entityId: d.nodeId ?? d.workOrderNumber, actorId: d.actorId,
    metadata: { kind: d.kind, oldDate: d.oldDate ? new Date(d.oldDate).toISOString() : null, newDate: d.newDate ? new Date(d.newDate).toISOString() : null } })
  return result
}

export async function recordProcessLog(tx: Prisma.TransactionClient, args: { data: Prisma.ProcessDocLogUncheckedCreateInput }) {
  const result = await tx.processDocLog.create(args)
  const d = args.data
  await recordAudit(tx, { action: 'process.change', entityType: 'DrawingTask', entityId: d.taskId, actorId: d.actorId,
    metadata: { kind: d.kind, fromStatus: d.fromStatus, toStatus: d.toStatus, releaseId: d.releaseId ?? null } })
  return result
}

export async function recordProcessLogs(tx: Prisma.TransactionClient, args: { data: Prisma.ProcessDocLogCreateManyInput[] }) {
  const result = await tx.processDocLog.createMany(args)
  for (const d of args.data) await recordAudit(tx, { action: 'process.change', entityType: 'DrawingTask', entityId: d.taskId, actorId: d.actorId,
    metadata: { kind: d.kind, fromStatus: d.fromStatus, toStatus: d.toStatus, releaseId: d.releaseId ?? null } })
  return result
}

export async function recordFlowEvent(tx: Prisma.TransactionClient, args: { data: Prisma.FlowEventUncheckedCreateInput }) {
  const result = await tx.flowEvent.create(args)
  const d = args.data
  await recordAudit(tx, { action: 'flow.event', entityType: 'RouteStep', entityId: d.stepId, actorId: d.actorId,
    metadata: { type: d.type, qty: d.qty, source: d.source } })
  return result
}
