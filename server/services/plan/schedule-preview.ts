import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { dateFieldDay } from '../../../shared/dates'
import { autoDone } from './node-estimates'
import { loadPlans } from './queries'
import { linkSchedule, type ScheduleNode } from './schedule'
import { FlowError } from '../flow/errors'

export interface ScheduleChange {
  id: string
  name: string
  oldStart: string | null
  oldFinish: string
  start: string | null
  finish: string
}
export interface SchedulePreview { token: string; changes: ScheduleChange[]; skipped: string[] }

/** Throwing out of the interactive transaction guarantees preview writes, including
 * validation/rollups, are rolled back together. Never catch inside the transaction.
 */
export class SchedulePreviewRollback extends Error {
  constructor(public readonly preview: SchedulePreview) { super('Schedule preview rollback') }
}

export async function scheduleSnapshot(tx: Prisma.TransactionClient, wo: string) {
  const data = (await loadPlans({ workOrderNumbers: [wo] }, new Date(), tx)).get(wo)
  if (!data) throw new FlowError('总计划不存在，请刷新后重试')
  const deps = await tx.planNodeDep.findMany({ where: { nodeId: { in: data.nodes.map((n) => n.id) } }, orderBy: [{ nodeId: 'asc' }, { predId: 'asc' }] })
  const nodes: ScheduleNode[] = data.nodes.map((n) => ({
    id: n.id, name: n.name, parent: n.parentId,
    preds: n.customDeps ? deps.filter((d) => d.nodeId === n.id).map((d) => d.predId) : null,
    start: n.startDate ? dateFieldDay(n.startDate) : null, finish: dateFieldDay(n.planDate),
    done: !!n.manualDoneAt || autoDone(data.tasks.filter((t) => t.nodeId === n.id).map((t) => t.facts), dateFieldDay(new Date())).done,
  }))
  return { nodes, version: { nodes: data.nodes, tasks: data.tasks, deps, status: data.status } }
}

export function schedulePreview(before: Awaited<ReturnType<typeof scheduleSnapshot>>, after: ScheduleNode[], id: string, input: unknown): SchedulePreview {
  const linked = linkSchedule(after, id)
  const changes = linked.nodes.flatMap((n) => {
    const old = before.nodes.find((p) => p.id === n.id)
    if (!old) throw new FlowError('计划节点已变化，请重新预览')
    return old.start === n.start && old.finish === n.finish ? [] : [{ id: n.id, name: n.name, oldStart: old.start, oldFinish: old.finish, start: n.start, finish: n.finish }]
  })
  const token = createHash('sha256').update(JSON.stringify({ version: before.version, input, changes })).digest('hex')
  return { token, changes, skipped: linked.skipped }
}
