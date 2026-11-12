import { recordProcessLog } from '../audit/record'
import { Prisma } from '@prisma/client'
import { FlowError } from '../flow/errors'
import { lockParts, refreshPartReady } from '../purchases/purchases'
import { processTaskWhere } from './eligibility'
import { processRevisionTitle } from './constants'

type Tx = Prisma.TransactionClient
type RequirementWork = { taskIds: string[]; partIds: string[] }

/**
 * Policy edits and node removal must use READ COMMITTED and lock parts before tasks and nodes.
 * Foreign-key writes serialize on the node lock. If links changed while locks were acquired,
 * roll back instead of acquiring additional part locks out of order or missing their reminders.
 */
export async function lockProcessRequirementWork(tx: Tx, nodeIds: string[], changedNodeIds = nodeIds): Promise<RequirementWork> {
  if (!nodeIds.length) return { taskIds: [], partIds: [] }
  const where = { planNodeId: { in: nodeIds } }
  const select = { id: true, planNodeId: true, parts: { select: { partId: true } } } as const
  const initial = await tx.drawingTask.findMany({ where, select })
  const taskIds = initial.map(t => t.id).sort()
  const partIds = [...new Set(initial.flatMap(t => t.parts.map(p => p.partId)))].sort()
  await lockParts(tx, partIds)
  if (taskIds.length) await tx.$queryRaw`SELECT id FROM drawing_task WHERE id IN (${Prisma.join(taskIds)}) ORDER BY id FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM plan_node WHERE id IN (${Prisma.join(nodeIds)}) ORDER BY id FOR UPDATE`
  const current = await tx.drawingTask.findMany({ where, select })
  if (current.some(t => !taskIds.includes(t.id) || t.parts.some(p => !partIds.includes(p.partId)))) {
    throw new FlowError('节点关联任务已变化，请刷新后重试')
  }
  const affected = current.filter(t => t.planNodeId && changedNodeIds.includes(t.planNodeId))
  return { taskIds: affected.map(t => t.id), partIds: [...new Set(affected.flatMap(t => t.parts.map(p => p.partId)))].sort() }
}

/** A policy can hide design changes, so previously issued documents require review when re-enabled. */
async function requireDocumentReview(tx: Tx, taskIds: string[], actorId: string, now: Date) {
  if (!taskIds.length) return
  const tasks = await tx.drawingTask.findMany({
    where: { id: { in: taskIds }, status: { not: 'CANCELLED' }, OR: [{ materialStatus: 'ISSUED' }, { processStatus: 'ISSUED' }] },
    select: { id: true, materialStatus: true, processStatus: true },
  })
  for (const task of tasks) {
    for (const kind of ['MATERIAL', 'PROCESS'] as const) {
      if ((kind === 'MATERIAL' ? task.materialStatus : task.processStatus) !== 'ISSUED') continue
      await tx.drawingTask.update({ where: { id: task.id }, data: kind === 'MATERIAL'
        ? { materialStatus: 'REVISING', materialAt: now, materialBy: actorId }
        : { processStatus: 'REVISING', processAt: now, processBy: actorId } })
      await recordProcessLog(tx, { data: {
        taskId: task.id, kind, fromStatus: 'ISSUED', toStatus: 'REVISING',
        note: '重新启用工艺处理，原已下发文档需复核', actorId, createdAt: now,
      } })
    }
  }
}

/** Only the latest material-state transition owns the active revision; older release reminders stay retired. */
async function syncProcessReminders(tx: Tx, taskIds: string[], reopen: boolean, now: Date) {
  if (!taskIds.length) return
  const logs = await tx.processDocLog.findMany({ where: { taskId: { in: taskIds }, kind: 'MATERIAL', toStatus: 'REVISING', releaseId: { not: null } }, select: { releaseId: true }, distinct: ['releaseId'] })
  const releaseIds = logs.flatMap(log => log.releaseId ? [log.releaseId] : [])
  if (!releaseIds.length) return
  const tasks = await tx.drawingTask.findMany({
    where: { AND: [processTaskWhere], status: { not: 'CANCELLED' }, materialStatus: 'REVISING', processLogs: { some: { kind: 'MATERIAL', releaseId: { in: releaseIds } } } },
    select: { componentName: true, processLogs: { where: { kind: 'MATERIAL' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { releaseId: true, toStatus: true } } },
  })
  for (const releaseId of releaseIds) {
    const release = await tx.release.findUnique({ where: { id: releaseId }, select: { id: true, releaseNo: true, workOrderNumber: true } })
    if (!release) continue
    const relevant = tasks.filter(task => task.processLogs[0]?.toStatus === 'REVISING' && task.processLogs[0].releaseId === release.id)
    const where = { kind: 'PROCESS', dedupeKey: { startsWith: `PROCESS_REVISE:${release.id}:` } }
    if (!relevant.length) await tx.reminder.updateMany({ where: { ...where, readAt: null }, data: { readAt: now } })
    else await tx.reminder.updateMany({ where, data: { title: processRevisionTitle(release, relevant.map(task => task.componentName)), ...(reopen ? { readAt: null } : {}) } })
  }
}

/** Reconcile after the policy/FK change, in the same transaction as the edit. */
export async function settleProcessRequirementWork(tx: Tx, work: RequirementWork, actorId: string, reopen = false): Promise<number> {
  const now = new Date()
  if (reopen) await requireDocumentReview(tx, work.taskIds, actorId, now)
  let readySent = 0
  for (const partId of work.partIds) if (await refreshPartReady(tx, partId, true) === 'sent') readySent++
  await syncProcessReminders(tx, work.taskIds, reopen, now)
  return readySent
}
