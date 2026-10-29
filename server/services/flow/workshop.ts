/**
 * 生产调度 / 车间看板（生产管理重设计第一批，10-26）：跨工单列出"该干什么"的工序，页面上直接开工、完工、发出、登记返厂。
 *
 *   可以开工 ready：待开工、按统一口径（readiness.ts）现在能开工的
 *   加工中 working：自制 / 厂内外协已开工
 *   在外加工 out：厂外外协已发出、还没全部返回
 *   卡住 stuck：QMS 判不合格（有异常）、等变更、第一道缺料 / 缺图——每条写明卡在哪
 *   近 7 天完成 done
 * 待开工但上一道还没做完的（排队中）不列。已完工 / 已取消工单上的工序不列。
 * 超期：外协在外看承诺返回日，其余看要求完成日；可以开工的另看应开工日是否已过（startLateDays）。
 */
import type { Prisma, StepStatus } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { openIssuesOfSteps } from '../issues/issues'
import { closedWorkOrders } from '../workorder/active'
import { overdueDays } from './dates'
import { resolveStepResponsibles } from './responsible'
import { RETURN_TYPES } from './flow'
import { loadNames } from './names'
import { type NotReadyReason, type PrereqState, prereqState, stepReadiness, stuckText } from './readiness'

export const WORKSHOP_COLUMNS = ['ready', 'working', 'out', 'stuck', 'done'] as const
export type WorkshopColumn = (typeof WORKSHOP_COLUMNS)[number]
const DONE_DAYS = 7
export type StuckKind = 'BLOCKED' | Exclude<NotReadyReason, 'PREV_NOT_DONE'>

export interface ProductionFilter {
  workOrderNumber?: string
  supplierId?: string
  /** 只看"我的"：本人负责的，以及本人当班组长的班组的自制工序（生产管理重设计第二批） */
  mine?: { userId: string; teamIds: string[] }
  visibleWorkOrders?: string[]
  now?: Date
}

/** 工件的开工前提（关键物料、设计任务），按工件 ID */
export async function loadPrereqs(partIds: string[]): Promise<Map<string, PrereqState>> {
  if (!partIds.length) return new Map()
  const [lines, drawings] = await Promise.all([
    prisma.purchaseLine.findMany({ where: { partId: { in: partIds } }, select: { partId: true, status: true } }),
    prisma.drawingTaskPart.findMany({ where: { partId: { in: partIds } }, select: { partId: true, task: { select: { status: true, materialStatus: true } } } }),
  ])
  return new Map(
    partIds.map((id) => [
      id,
      prereqState({ purchases: lines.filter((l) => l.partId === id).map((l) => l.status), drawings: drawings.filter((d) => d.partId === id).map((d) => d.task) }),
    ]),
  )
}

/** "我的"：本人负责的，或本人当班组长的班组的自制工序（不管指没指定负责人，班组长都要看到本班组的活） */
export function mineWhere(mine: { userId: string; teamIds: string[] }): Prisma.RouteStepWhereInput {
  return { OR: [{ ownerId: mine.userId }, ...(mine.teamIds.length ? [{ mode: 'SELF' as const, supplierId: { in: mine.teamIds } }] : [])] }
}

function woWhere(filter: ProductionFilter): Prisma.PartWhereInput | undefined {
  const wo = {
    ...(filter.workOrderNumber ? { equals: filter.workOrderNumber } : {}),
    ...(filter.visibleWorkOrders ? { in: filter.visibleWorkOrders } : {}),
  }
  return Object.keys(wo).length ? { workOrderNumber: wo } : undefined
}

/** 生产调度的工序行 + 还没排工序的工件数 */
export async function listProduction(filter: ProductionFilter) {
  const now = filter.now ?? new Date()
  const partWhere = woWhere(filter)
  const steps = await prisma.routeStep.findMany({
    where: {
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
      ...(filter.mine ? { AND: [mineWhere(filter.mine)] } : {}),
      ...(partWhere ? { part: partWhere } : {}),
      OR: [{ status: { in: ['PENDING', 'IN_PROGRESS', 'OUT', 'BLOCKED'] } }, { status: 'DONE', finishedAt: { gte: new Date(+now - DONE_DAYS * 86_400_000) } }],
    },
    include: { part: { select: { workOrderNumber: true, name: true, quantity: true, drawingNo: true } } },
    orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { seq: 'asc' }],
  })
  // 待开工的要看同一工件的上一道（上一道可能不在上面的结果里，比如被班组 / 负责人筛掉了）
  const pendingParts = [...new Set(steps.filter((s) => s.status === 'PENDING').map((s) => s.partId))]
  const siblings = pendingParts.length
    ? await prisma.routeStep.findMany({ where: { partId: { in: pendingParts } }, select: { id: true, partId: true, seq: true, status: true } })
    : []
  const firstParts = [...new Set(steps.filter((s) => s.status === 'PENDING' && !siblings.some((x) => x.partId === s.partId && x.seq < s.seq)).map((s) => s.partId))]
  const [sums, prereqs, closed, unroutedParts] = await Promise.all([
    prisma.flowEvent.groupBy({
      by: ['stepId'],
      where: { stepId: { in: [...steps.map((s) => s.id), ...siblings.map((s) => s.id)] }, type: { in: RETURN_TYPES } },
      _sum: { qty: true },
    }),
    loadPrereqs(firstParts),
    closedWorkOrders(steps.map((s) => s.part.workOrderNumber)),
    countUnroutedParts(filter),
  ])
  const doneQty = new Map(sums.map((x) => [x.stepId, x._sum.qty ?? 0]))
  const NO_PREREQ: PrereqState = { tracked: false, missingMaterial: 0, missingDrawing: 0, missingMaterialList: 0 }

  type Classified = { s: (typeof steps)[number]; column: WorkshopColumn; stuck: StuckKind | null; prereq: PrereqState }
  const classified: Classified[] = []
  for (const s of steps) {
    if (closed.has(s.part.workOrderNumber)) continue
    if (s.status === 'PENDING') {
      const prevStep = siblings.filter((x) => x.partId === s.partId && x.seq < s.seq).sort((a, b) => b.seq - a.seq)[0]
      const prereq = prereqs.get(s.partId) ?? NO_PREREQ
      const r = stepReadiness({
        status: s.status,
        held: !!s.holdReleaseId,
        prev: prevStep ? { status: prevStep.status, doneQty: doneQty.get(prevStep.id) ?? 0 } : null,
        prereq,
      })
      if (r.ready) classified.push({ s, column: 'ready', stuck: null, prereq })
      else if (r.reason && r.reason !== 'PREV_NOT_DONE') classified.push({ s, column: 'stuck', stuck: r.reason, prereq })
      continue
    }
    const column: Record<Exclude<StepStatus, 'PENDING'>, WorkshopColumn> = { IN_PROGRESS: 'working', OUT: 'out', BLOCKED: 'stuck', DONE: 'done' }
    classified.push({ s, column: column[s.status], stuck: s.status === 'BLOCKED' ? 'BLOCKED' : null, prereq: NO_PREREQ })
  }

  const shown = classified.map((c) => c.s)
  // 谁负责（flow/responsible.ts）：没指定负责人、派到班组的由班组长负责，主按钮不再是"指定负责人"
  const responsibles = await resolveStepResponsibles(prisma, shown.map((s) => ({ ...s, workOrderNumber: s.part.workOrderNumber })))
  const [names, issues] = await Promise.all([
    loadNames({ process: shown.map((s) => s.processId), supplier: shown.map((s) => s.supplierId), user: [...shown.map((s) => s.ownerId), ...responsibles] }),
    openIssuesOfSteps(shown.filter((s) => s.status === 'BLOCKED').map((s) => s.id)),
  ])
  const rows = classified.map(({ s, column, stuck, prereq }, i) => {
    const leaderId = s.ownerId ? null : (responsibles[i] ?? null)
    const late = s.status === 'DONE' ? 0 : overdueDays(s.status === 'OUT' && s.promisedReturnDate ? s.promisedReturnDate : s.dueDate, now)
    const startLateDays = s.status === 'PENDING' ? overdueDays(s.planStartDate, now) : 0
    return {
      column,
      status: s.status,
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
      supplierId: s.supplierId,
      supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
      ownerId: s.ownerId,
      ownerName: s.ownerId ? (names.user.get(s.ownerId) ?? s.ownerId) : null,
      /** 没指定负责人时由班组长负责（自制派到班组的） */
      leaderId,
      leaderName: leaderId ? (names.user.get(leaderId) ?? leaderId) : null,
      planStartDate: s.planStartDate,
      dueDate: s.dueDate,
      promisedReturnDate: s.promisedReturnDate,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      held: !!s.holdReleaseId,
      holdReleaseId: s.holdReleaseId,
      /** 要求完成日 / 承诺返回日已过几天 */
      overdueDays: late,
      /** 应开工日已过几天（只算待开工的） */
      startLateDays: column === 'ready' ? startLateDays : 0,
      /** 卡住原因 */
      stuckKind: stuck,
      stuckText: stuck ? stuckText(stuck, prereq) : null,
      issues: issues.get(s.id) ?? [],
    }
  })
  return { rows, unroutedParts }
}

/** 还没排工序的工件（未完工工单） */
async function countUnroutedParts(filter: ProductionFilter): Promise<number> {
  const parts = await prisma.part.findMany({ where: { ...woWhere(filter), status: 'ACTIVE', steps: { none: {} } }, select: { workOrderNumber: true } })
  if (!parts.length) return 0
  const closed = await closedWorkOrders(parts.map((p) => p.workOrderNumber))
  return parts.filter((p) => !closed.has(p.workOrderNumber)).length
}

export type ProductionRow = Awaited<ReturnType<typeof listProduction>>['rows'][number]

/** 车间看板：同一批工序按列分组 */
export async function listWorkshop(filter: ProductionFilter) {
  const { rows } = await listProduction(filter)
  return WORKSHOP_COLUMNS.map((key) => ({ key, cards: rows.filter((c) => c.column === key) }))
}
