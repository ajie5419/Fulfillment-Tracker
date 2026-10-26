/**
 * 车间看板（借鉴 ERPNext 作业卡看板，10-26，只读）：工序按状态分列——可以开工 / 加工中 / 在外加工 / 有异常 / 近 7 天完成。
 * 可按工单、班组 / 外协厂筛选（派工到班组后，班组长看自己班组手上的活）。操作仍在"生产管理"和手机端做。
 * "可以开工" = 待开工、且前一道已完成或已有部分返回 / 报工（与给下一道发待办的时机一致）；第一道直接算。
 */
import type { StepStatus } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { overdueDays } from './dates'
import { RETURN_TYPES } from './flow'
import { loadNames } from './names'

export const WORKSHOP_COLUMNS = ['ready', 'working', 'out', 'blocked', 'done'] as const
export type WorkshopColumn = (typeof WORKSHOP_COLUMNS)[number]
const COLUMN_OF: Partial<Record<StepStatus, WorkshopColumn>> = { PENDING: 'ready', IN_PROGRESS: 'working', OUT: 'out', BLOCKED: 'blocked', DONE: 'done' }
const DONE_DAYS = 7

export async function listWorkshop(filter: { workOrderNumber?: string; supplierId?: string; visibleWorkOrders?: string[]; now?: Date }) {
  const now = filter.now ?? new Date()
  const wo = {
    ...(filter.workOrderNumber ? { equals: filter.workOrderNumber } : {}),
    ...(filter.visibleWorkOrders ? { in: filter.visibleWorkOrders } : {}),
  }
  const steps = await prisma.routeStep.findMany({
    where: {
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
      ...(Object.keys(wo).length ? { part: { workOrderNumber: wo } } : {}),
      OR: [{ status: { in: ['PENDING', 'IN_PROGRESS', 'OUT', 'BLOCKED'] } }, { status: 'DONE', finishedAt: { gte: new Date(+now - DONE_DAYS * 86_400_000) } }],
    },
    include: { part: { select: { workOrderNumber: true, name: true, quantity: true, drawingNo: true } } },
    orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { seq: 'asc' }],
  })
  // 待开工的只留"可以开工"的：看同一工件的前一道
  const pendingParts = [...new Set(steps.filter((s) => s.status === 'PENDING').map((s) => s.partId))]
  const siblings = pendingParts.length
    ? await prisma.routeStep.findMany({ where: { partId: { in: pendingParts } }, select: { id: true, partId: true, seq: true, status: true } })
    : []
  const sums = await prisma.flowEvent.groupBy({
    by: ['stepId'],
    where: { stepId: { in: [...steps.map((s) => s.id), ...siblings.map((s) => s.id)] }, type: { in: RETURN_TYPES } },
    _sum: { qty: true },
  })
  const doneQty = new Map(sums.map((x) => [x.stepId, x._sum.qty ?? 0]))
  const ready = (s: { id: string; partId: string; seq: number }) => {
    const prev = siblings.filter((x) => x.partId === s.partId && x.seq < s.seq).sort((a, b) => b.seq - a.seq)[0]
    return !prev || prev.status === 'DONE' || (doneQty.get(prev.id) ?? 0) > 0
  }
  const shown = steps.filter((s) => s.status !== 'PENDING' || ready(s))
  const names = await loadNames({ process: shown.map((s) => s.processId), supplier: shown.map((s) => s.supplierId), user: shown.map((s) => s.ownerId) })
  const cards = shown.map((s) => {
    // 逾期：外协在外看承诺返回日，其余看要求完成日；已完成的不算
    const late = s.status === 'DONE' ? 0 : overdueDays(s.status === 'OUT' && s.promisedReturnDate ? s.promisedReturnDate : s.dueDate, now)
    return {
      column: COLUMN_OF[s.status]!,
      stepId: s.id,
      partId: s.partId,
      seq: s.seq,
      workOrderNumber: s.part.workOrderNumber,
      partName: s.part.name,
      drawingNo: s.part.drawingNo,
      quantity: s.part.quantity,
      doneQty: doneQty.get(s.id) ?? 0,
      processName: names.process.get(s.processId) ?? s.processId,
      mode: s.mode,
      supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
      ownerName: s.ownerId ? (names.user.get(s.ownerId) ?? s.ownerId) : null,
      planStartDate: s.planStartDate,
      dueDate: s.dueDate,
      promisedReturnDate: s.promisedReturnDate,
      finishedAt: s.finishedAt,
      held: !!s.holdReleaseId,
      overdueDays: late,
    }
  })
  return WORKSHOP_COLUMNS.map((key) => ({ key, cards: cards.filter((c) => c.column === key) }))
}
