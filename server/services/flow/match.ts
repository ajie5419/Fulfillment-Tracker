/**
 * QMS 返厂报检 → 工件步骤 匹配（方案第 2 节匹配键）。
 *
 * 候选：报检的任一工单（主工单 + 关联工单 workOrderNumbers）下、状态为 在外加工/加工中 的外协步骤（厂内外协、厂外外协）。
 * 匹配键：有物料 ID 时用 物料 ID；没有时用 物料名称（去首尾空格）+ 工序（ID，或 ID 为空时比工序名称）。
 * 报检带外协单位时，步骤的外协单位也必须相同：优先 supplierId；没有 supplierId 而有 teamId（厂内外协班组）时
 * 用 teamId（qms_supplier 里 kind = TEAM 的同一 id）。
 * 恰好一个候选 → 自动记返厂；零个或多个 → 进入"待确认匹配"，人工点一下关联。
 * 幂等：flow_event.qmsInspectionId 唯一，同一报检重复同步、重复匹配不会重复记返厂和生成待办。
 */
import type { Prisma, QmsInspection, StepMode, StepStatus } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { alertKey } from '../alerts/rules'
import { FlowError } from './errors'
import { inspectionSupplierId, inspectionWorkOrders } from './inspection'
import { recordReturn } from './flow'
import { loadNames } from './names'

export { inspectionSupplierId, inspectionWorkOrders }

const OUTSOURCE_MODES: StepMode[] = ['IN_PLANT_OUTSOURCE', 'EXTERNAL_OUTSOURCE']
const ACTIVE_STATUSES: StepStatus[] = ['OUT', 'IN_PROGRESS']

export type InspectionKey = Pick<QmsInspection, 'workOrderNumber' | 'partId' | 'partName' | 'processId' | 'processName' | 'supplierId'> &
  Partial<Pick<QmsInspection, 'workOrderNumbers' | 'teamId'>>

export interface CandidateStep {
  id: string
  status: StepStatus
  mode: StepMode
  processId: string
  supplierId: string | null
  /** qms_process.name */
  processName: string
  part: { workOrderNumber: string; name: string; qmsPartId: string | null }
}

/** 纯函数：从给定步骤里挑出与报检对得上的 */
export function findCandidates<T extends CandidateStep>(inspection: InspectionKey, steps: T[]): T[] {
  const partName = inspection.partName.trim()
  const processName = inspection.processName.trim()
  const workOrders = inspectionWorkOrders(inspection)
  const supplierId = inspectionSupplierId(inspection)
  return steps.filter((s) => {
    if (!workOrders.includes(s.part.workOrderNumber)) return false
    if (!ACTIVE_STATUSES.includes(s.status) || !OUTSOURCE_MODES.includes(s.mode)) return false
    if (inspection.partId) {
      if (s.part.qmsPartId !== inspection.partId) return false
    } else {
      if (s.part.name.trim() !== partName) return false
      if (inspection.processId ? s.processId !== inspection.processId : s.processName.trim() !== processName) return false
    }
    if (supplierId && s.supplierId !== supplierId) return false
    return true
  })
}

/** 存进 unmatched_inspection.candidates，供人工选择 */
export interface CandidateView {
  stepId: string
  workOrderNumber: string
  seq: number
  partId: string
  partName: string
  processName: string
  supplierId: string | null
  supplierName: string | null
  status: StepStatus
}

/** 这些工单下所有在外加工/加工中的外协步骤，带名称 */
async function activeOutsourceSteps(tx: Prisma.TransactionClient | typeof prisma, workOrderNumbers: string[]) {
  const steps = await tx.routeStep.findMany({
    where: { status: { in: ACTIVE_STATUSES }, mode: { in: OUTSOURCE_MODES }, part: { workOrderNumber: { in: workOrderNumbers } } },
    include: { part: { select: { id: true, workOrderNumber: true, name: true, qmsPartId: true } } },
    orderBy: [{ part: { workOrderNumber: 'asc' } }, { partId: 'asc' }, { seq: 'asc' }],
  })
  const names = await loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId) })
  return steps.map((s) => ({
    ...s,
    processName: names.process.get(s.processId) ?? '',
    supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
  }))
}

const toView = (s: Awaited<ReturnType<typeof activeOutsourceSteps>>[number]): CandidateView => ({
  stepId: s.id,
  workOrderNumber: s.part.workOrderNumber,
  seq: s.seq,
  partId: s.part.id,
  partName: s.part.name,
  processName: s.processName,
  supplierId: s.supplierId,
  supplierName: s.supplierName,
  status: s.status,
})

export type MatchResult =
  | { inspectionId: string; status: 'matched'; stepId: string; stepDone: boolean; todoCreated: boolean }
  | { inspectionId: string; status: 'unmatched'; reason: 'NO_CANDIDATE' | 'MULTIPLE' | 'CANCELLED_AFTER_MATCH' }
  | { inspectionId: string; status: 'skipped' | 'ignored' | 'duplicate' }

/** 并发下两边同时写同一条报检：唯一约束冲突当作"已处理"*/
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002'

export async function matchInspection(inspectionId: string): Promise<MatchResult> {
  try {
    return await prisma.$transaction(async (tx): Promise<MatchResult> => {
      const ins = await tx.qmsInspection.findUnique({ where: { id: inspectionId } })
      if (!ins || ins.isDeleted) return { inspectionId, status: 'ignored' }
      const unmatched = await tx.unmatchedInspection.findUnique({ where: { qmsInspectionId: inspectionId } })
      const matched = await tx.flowEvent.findUnique({ where: { qmsInspectionId: inspectionId }, select: { id: true } })

      if (ins.status === 'CANCELLED') {
        // 匹配后又撤销：记下来让人看一眼，不回退步骤；没匹配过的直接忽略
        if (!matched) return { inspectionId, status: unmatched ? 'skipped' : 'ignored' }
        if (unmatched?.reason === 'CANCELLED_AFTER_MATCH') return { inspectionId, status: 'skipped' }
        // 人工关联过的（待确认记录已是 RESOLVED）同样要重新提示
        // createdAt 重置为重新进入待确认的时间，W1 从这里重新计时
        const data = { reason: 'CANCELLED_AFTER_MATCH', status: 'PENDING' as const, resolvedBy: null, resolvedAt: null, createdAt: new Date() }
        if (unmatched) await tx.unmatchedInspection.update({ where: { qmsInspectionId: inspectionId }, data })
        else await tx.unmatchedInspection.create({ data: { qmsInspectionId: inspectionId, ...data } })
        return { inspectionId, status: 'unmatched', reason: 'CANCELLED_AFTER_MATCH' }
      }
      if (unmatched) return { inspectionId, status: 'skipped' }
      if (matched) return { inspectionId, status: 'skipped' }

      const steps = await activeOutsourceSteps(tx, inspectionWorkOrders(ins))
      const hits = findCandidates(ins, steps)
      if (hits.length === 1) {
        const r = await recordReturn(tx, {
          stepId: hits[0]!.id,
          qty: ins.quantity,
          source: 'QMS_INSPECTION',
          qmsInspectionId: ins.id,
          actorId: ins.reporterId,
          occurredAt: ins.submittedAt,
        })
        if (r.duplicate) return { inspectionId, status: 'duplicate' }
        return { inspectionId, status: 'matched', stepId: hits[0]!.id, stepDone: r.stepDone, todoCreated: r.todoCreated }
      }
      const reason = hits.length === 0 ? 'NO_CANDIDATE' : 'MULTIPLE'
      const candidates = steps.map(toView)
      await tx.unmatchedInspection.create({ data: { qmsInspectionId: inspectionId, reason, candidates: candidates as unknown as Prisma.InputJsonValue } })
      return { inspectionId, status: 'unmatched', reason }
    })
  } catch (err) {
    if (isUniqueViolation(err)) return { inspectionId, status: 'duplicate' }
    throw err
  }
}

/**
 * 处理所有还没处理的报检：既没记过返厂、也不在待确认列表里的；外加"已匹配但后来被撤销"的。
 * 同步任务（sync-qms）每轮同步完调用一次，演示工具也调用。
 *
 * 只看履约在跟踪的工单（任一工单下已建了工件）上的报检：QMS 全量同步过来的其他工单的报检
 * 不进"待确认匹配"（否则上线首次同步会把历史报检全堆进去）；之后该工单建了工件，下一轮自然会处理。
 * 并且只看工件登记之后提交的报检：登记前的历史报检不可能是这次外协的返厂，避免误匹配到正在外协的步骤。
 */
export async function matchPendingInspections(): Promise<MatchResult[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM qms_inspection i
    LEFT JOIN unmatched_inspection u ON u.qmsInspectionId = i.id
    LEFT JOIN flow_event f ON f.qmsInspectionId = i.id
    WHERE i.isDeleted = false
      AND ((u.qmsInspectionId IS NULL AND (f.id IS NULL OR i.status = 'CANCELLED'))
        OR (i.status = 'CANCELLED' AND f.id IS NOT NULL AND u.reason <> 'CANCELLED_AFTER_MATCH'))
      AND (f.id IS NOT NULL OR EXISTS (
        SELECT 1 FROM part p
        WHERE (p.workOrderNumber = i.workOrderNumber
          OR (i.workOrderNumbers IS NOT NULL AND JSON_CONTAINS(i.workOrderNumbers, JSON_QUOTE(p.workOrderNumber))))
          AND p.createdAt <= i.submittedAt))
    ORDER BY i.submittedAt, i.id`
  const results: MatchResult[] = []
  for (const { id } of rows) results.push(await matchInspection(id))
  return results
}

// ───────────── 待确认匹配 ─────────────

/** visibleWorkOrders：可见工单（undefined = 全部） */
export async function listUnmatched(visibleWorkOrders?: string[]) {
  let rows = await prisma.unmatchedInspection.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } })
  let inspections = await prisma.qmsInspection.findMany({ where: { id: { in: rows.map((r) => r.qmsInspectionId) } } })
  // 多工单报检：任一工单可见即可见
  if (visibleWorkOrders) {
    const visible = new Set(visibleWorkOrders)
    inspections = inspections.filter((i) => inspectionWorkOrders(i).some((wo) => visible.has(wo)))
    rows = rows.filter((r) => inspections.some((i) => i.id === r.qmsInspectionId))
  }
  const byId = new Map(inspections.map((i) => [i.id, i]))
  // 撤销的那条要显示当初匹配到哪个步骤
  const events = await prisma.flowEvent.findMany({
    where: { qmsInspectionId: { in: rows.map((r) => r.qmsInspectionId) } },
    select: { qmsInspectionId: true, stepId: true },
  })
  const matchedStep = new Map(events.map((e) => [e.qmsInspectionId, e.stepId]))
  // 候选在匹配时存了一份；之后才补登发出的步骤也要能选，所以再合并当前在外的步骤
  const live = new Map<string, CandidateView[]>()
  for (const wo of new Set(inspections.flatMap((i) => inspectionWorkOrders(i)))) {
    live.set(wo, (await activeOutsourceSteps(prisma, [wo])).map(toView))
  }
  return rows.map((r) => {
    const inspection = byId.get(r.qmsInspectionId) ?? null
    const stored = (r.candidates ?? []) as unknown as CandidateView[]
    const current = r.reason === 'CANCELLED_AFTER_MATCH' || !inspection ? [] : inspectionWorkOrders(inspection).flatMap((wo) => live.get(wo) ?? [])
    const seen = new Set(current.map((c) => c.stepId))
    return {
      ...r,
      candidates: [...current, ...stored.filter((c) => !seen.has(c.stepId))],
      inspection,
      matchedStepId: matchedStep.get(r.qmsInspectionId) ?? null,
    }
  })
}

async function lockPendingUnmatched(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT qmsInspectionId FROM unmatched_inspection WHERE qmsInspectionId = ${id} FOR UPDATE`
  const row = await tx.unmatchedInspection.findUnique({ where: { qmsInspectionId: id } })
  if (!row) throw new FlowError('待确认记录不存在')
  if (row.status !== 'PENDING') throw new FlowError('这条报检已经处理过了')
  return row
}

/** 已处理的待确认记录：立即消除 W1（扫描任务也会兜底） */
const clearW1 = (tx: Prisma.TransactionClient, id: string) => clearAlertKeys(tx, [alertKey('W1', 'unmatched', id)])

/** 人工关联：与自动匹配走同一个 recordReturn，同一事务里把待确认记录置为已处理 */
export async function resolveUnmatched(id: string, stepId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const row = await lockPendingUnmatched(tx, id)
    if (row.reason === 'CANCELLED_AFTER_MATCH') throw new FlowError('这条报检已撤销，只能忽略')
    const ins = await tx.qmsInspection.findUnique({ where: { id } })
    if (!ins) throw new FlowError('报检记录不存在')
    const step = await tx.routeStep.findUnique({ where: { id: stepId }, select: { part: { select: { workOrderNumber: true } } } })
    if (!step) throw new FlowError('步骤不存在或已删除')
    if (!inspectionWorkOrders(ins).includes(step.part.workOrderNumber)) throw new FlowError('只能关联到同一工单下的步骤（报检关联的工单）')
    const r = await recordReturn(tx, {
      stepId,
      qty: ins.quantity,
      source: 'QMS_INSPECTION',
      qmsInspectionId: ins.id,
      actorId,
      occurredAt: ins.submittedAt,
    })
    if (r.duplicate) throw new FlowError('这条报检已经关联过步骤')
    await tx.unmatchedInspection.update({
      where: { qmsInspectionId: id },
      data: { status: 'RESOLVED', resolvedBy: actorId, resolvedAt: new Date() },
    })
    await clearW1(tx, id)
    return r
  })
}

export async function ignoreUnmatched(id: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await lockPendingUnmatched(tx, id)
    await tx.unmatchedInspection.update({
      where: { qmsInspectionId: id },
      data: { status: 'IGNORED', resolvedBy: actorId, resolvedAt: new Date() },
    })
    await clearW1(tx, id)
    return { ok: true }
  })
}
