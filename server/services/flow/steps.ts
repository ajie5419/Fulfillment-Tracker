/**
 * 工件和工序链的增删改。工件挂在工单（qms_work_order.workOrderNumber）下，工序链按 seq 排序。
 * 规则只有两条：已有流转记录的步骤不能删除、不能调顺序；步骤负责人默认是创建人。
 */
import type { PrereqState } from './readiness'
import type { Prisma, StepMode } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { openIssuesOfSteps } from '../issues/issues'
import { FlowError } from './errors'
import { ARRANGE_SEND, ARRANGE_START, RETURN_TYPES, arrangeAction, arrangeOwner, refreshPartCompletion } from './flow'
import { READY_TO_START } from '../purchases/constants'
import { readyOwners, refreshPartReady } from '../purchases/purchases'
import { resolveStepResponsibles } from './responsible'
import { partRelatedCounts } from './timeline'
import { deleteCommentsOf } from '../comments/comments'
import { loadNames } from './names'
import { planWarning, resolvePlanNode } from '../plan/links'

type Tx = Prisma.TransactionClient

async function lockPart(tx: Tx, partId: string) {
  await tx.$queryRaw`SELECT id FROM part WHERE id = ${partId} FOR UPDATE`
  const part = await tx.part.findUnique({ where: { id: partId } })
  if (!part) throw new FlowError('工件不存在或已删除')
  return part
}

async function hasEvents(tx: Tx, stepIds: string[]) {
  if (!stepIds.length) return false
  return (await tx.flowEvent.count({ where: { stepId: { in: stepIds } } })) > 0
}

async function assertProcess(tx: Tx, processId: string) {
  const p = await tx.qmsProcess.findFirst({ where: { id: processId, isDeleted: false }, select: { id: true } })
  if (!p) throw new FlowError('工序不存在或已停用')
}

/** 外协步骤的外协厂 / 厂内班组；自制步骤可选派工班组（10-26 起，原来自制不带） */
const supplierFor = (supplierId: string | null | undefined) => supplierId || null

/** 自制步骤只能派给厂内班组（QMS 外协单位里 kind = TEAM 的） */
export async function assertSelfTeam(tx: Tx, mode: StepMode, supplierId: string | null | undefined) {
  if (mode !== 'SELF' || !supplierId) return
  const team = await tx.qmsSupplier.findFirst({ where: { id: supplierId, isDeleted: false }, select: { kind: true } })
  if (!team) throw new FlowError('班组不存在或已停用')
  if (team.kind !== 'TEAM') throw new FlowError('自制工序只能派给厂内班组，外协厂请把方式改成外协')
}

/** 应开工日不能晚于要求完成日 */
function assertDates(planStartDate: Date | null | undefined, dueDate: Date | null | undefined) {
  if (planStartDate && dueDate && planStartDate.getTime() > dueDate.getTime()) throw new FlowError('应开工日不能晚于要求完成日')
}

// ───────────── 查询 ─────────────

/**
 * 步骤还缺信息：待开工且没有负责人（自制派到有班组长的班组也算有人负责，见 flow/responsible.ts），或外协步骤没选外协厂。
 * 没有负责人时上一道完成后发不出待办。responsibleId：按统一口径算出的负责人（不传时只看 ownerId）
 */
export function needsFill(s: { status: string; ownerId: string | null; mode: StepMode; supplierId: string | null }, responsibleId: string | null = s.ownerId) {
  return s.status === 'PENDING' && (!responsibleId || (s.mode !== 'SELF' && !s.supplierId))
}

/** 工单下的工件及其工序链（带名称、已返回数量），供页面直接展示 */
export async function listParts(workOrderNumber: string) {
  return loadParts({ workOrderNumber })
}

/** 单个工件（工件抽屉）：同 listParts 的一行；不存在时报错 */
/** 工件抽屉用的单个工件（接口 GET /api/parts/:id 再带上开工前提） */
export type PartDetail = Awaited<ReturnType<typeof getPart>> & { prereq: PrereqState }

export async function getPart(partId: string) {
  const [part] = await loadParts({ id: partId })
  if (!part) throw new FlowError('工件不存在或已删除')
  return part
}

async function loadParts(where: Prisma.PartWhereInput) {
  const parts = await prisma.part.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: { steps: { orderBy: { seq: 'asc' } } },
  })
  const steps = parts.flatMap((p) => p.steps)
  const stepIds = steps.map((s) => s.id)
  const woOf = new Map(parts.map((p) => [p.id, p.workOrderNumber]))
  const responsibles = await resolveStepResponsibles(prisma, steps.map((s) => ({ ...s, workOrderNumber: woOf.get(s.partId)! })))
  const responsibleOf = new Map(steps.map((s, i) => [s.id, responsibles[i] ?? null]))
  const [names, sums, counts, issues, related] = await Promise.all([
    loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId), user: [...steps.map((s) => s.ownerId), ...responsibles] }),
    prisma.flowEvent.groupBy({
      by: ['stepId'],
      where: { stepId: { in: stepIds }, type: { in: RETURN_TYPES } },
      _sum: { qty: true },
    }),
    prisma.flowEvent.groupBy({ by: ['stepId'], where: { stepId: { in: stepIds } }, _count: { _all: true } }),
    // 有异常的步骤要能跳到对应异常
    openIssuesOfSteps(steps.filter((s) => s.status === 'BLOCKED').map((s) => s.id)),
    // 卡片顶部的关联记录数（设计、物料、异常、留言）
    partRelatedCounts(parts.map((p) => p.id)),
  ])
  const returned = new Map(sums.map((s) => [s.stepId, s._sum.qty ?? 0]))
  const eventCount = new Map(counts.map((c) => [c.stepId, c._count._all]))
  return parts.map((p) => ({
    ...p,
    related: related.get(p.id)!,
    steps: p.steps.map((s) => ({
      ...s,
      processName: names.process.get(s.processId) ?? s.processId,
      supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
      ownerName: s.ownerId ? (names.user.get(s.ownerId) ?? s.ownerId) : null,
      /** 没有负责人、派到班组时由班组长负责（flow/responsible.ts）；有负责人时为 null */
      leaderName: !s.ownerId && responsibleOf.get(s.id) ? (names.user.get(responsibleOf.get(s.id)!) ?? responsibleOf.get(s.id)!) : null,
      returnedQty: returned.get(s.id) ?? 0,
      eventCount: eventCount.get(s.id) ?? 0,
      /** 该步骤上未关闭的异常（步骤"有异常"时） */
      issues: issues.get(s.id) ?? [],
      /** 待补充：还没开工、但缺负责人，或外协却没选外协厂（BOM 导入的步骤默认就是这样） */
      needsFill: needsFill(s, responsibleOf.get(s.id) ?? null),
    })),
  }))
}

/** 单个步骤（手机发出登记从待办跳过来时预填用） */
export async function getStep(stepId: string) {
  const step = await prisma.routeStep.findUnique({ where: { id: stepId }, include: { part: true } })
  if (!step) throw new FlowError('步骤不存在或已删除')
  const names = await loadNames({ process: [step.processId], supplier: [step.supplierId] })
  return {
    ...step,
    processName: names.process.get(step.processId) ?? step.processId,
    supplierName: step.supplierId ? (names.supplier.get(step.supplierId) ?? step.supplierId) : null,
  }
}

/** 工件的流转记录（只读） */
export async function listEvents(partId: string) {
  const events = await prisma.flowEvent.findMany({
    where: { step: { partId } },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    include: { step: { select: { seq: true, processId: true } } },
  })
  const names = await loadNames({ process: events.map((e) => e.step.processId), user: events.map((e) => e.actorId) })
  return events.map(({ step, ...e }) => ({
    ...e,
    seq: step.seq,
    processName: names.process.get(step.processId) ?? step.processId,
    actorName: e.actorId ? (names.user.get(e.actorId) ?? e.actorId) : null,
  }))
}

// ───────────── 工件 ─────────────

export interface PartInput {
  name: string
  drawingNo?: string | null
  revision?: string | null
  quantity: number
  qmsPartId?: string | null
}

export async function createPart(workOrderNumber: string, input: PartInput) {
  const wo = await prisma.qmsWorkOrder.findFirst({ where: { workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
  if (!wo) throw new FlowError('工单不存在或已删除')
  return prisma.part.create({
    data: {
      workOrderNumber,
      name: input.name.trim(),
      drawingNo: input.drawingNo?.trim() || null,
      revision: input.revision?.trim() || null,
      quantity: input.quantity,
      qmsPartId: input.qmsPartId?.trim() || null,
    },
  })
}

export async function updatePart(partId: string, input: Partial<PartInput>) {
  return prisma.$transaction(async (tx) => {
    await lockPart(tx, partId)
    return tx.part.update({
      where: { id: partId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.drawingNo !== undefined ? { drawingNo: input.drawingNo?.trim() || null } : {}),
        ...(input.revision !== undefined ? { revision: input.revision?.trim() || null } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.qmsPartId !== undefined ? { qmsPartId: input.qmsPartId?.trim() || null } : {}),
      },
    })
  })
}

export async function deletePart(partId: string) {
  return prisma.$transaction(async (tx) => {
    await lockPart(tx, partId)
    const steps = await tx.routeStep.findMany({ where: { partId }, select: { id: true } })
    const ids = steps.map((s) => s.id)
    if (await hasEvents(tx, ids)) throw new FlowError('该工件已有流转记录，不能删除')
    await tx.todo.updateMany({ where: { refType: 'step', refId: { in: ids }, status: 'OPEN' }, data: { status: 'CANCELLED' } })
    await deleteCommentsOf(tx, 'part', partId) // 留言和它发出的提醒都没有外键，一起删，别留下指向已删工件的数据
    await tx.part.delete({ where: { id: partId } }) // 步骤级联删除
    return { ok: true }
  })
}

// ───────────── 步骤 ─────────────

export interface StepInput {
  processId: string
  mode: StepMode
  supplierId?: string | null
  ownerId?: string | null
  dueDate?: Date | null
  /** 应开工日 */
  planStartDate?: Date | null
  /** 所属总计划节点（R14） */
  planNodeId?: string | null
}

/** 工序的日期晚于节点计划日：厂外外协有承诺返回日看承诺返回日，否则看要求完成日 */
function stepWarning(s: { mode: StepMode; dueDate: Date | null; promisedReturnDate: Date | null }, node: Parameters<typeof planWarning>[2]) {
  if (s.mode === 'EXTERNAL_OUTSOURCE' && s.promisedReturnDate) return planWarning('承诺返回日', s.promisedReturnDate, node)
  return planWarning('要求完成日', s.dueDate, node)
}

/** 追加到工序链末尾。负责人不填时默认是创建人 */
export async function addStep(partId: string, input: StepInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const part = await lockPart(tx, partId)
    await assertProcess(tx, input.processId)
    await assertSelfTeam(tx, input.mode, input.supplierId)
    assertDates(input.planStartDate, input.dueDate)
    const link = await resolvePlanNode(tx, part.workOrderNumber, input.planNodeId, { creating: true })
    const last = await tx.routeStep.findFirst({ where: { partId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    const before = await firstStepOf(tx, partId)
    const step = await tx.routeStep.create({
      data: {
        partId,
        seq: (last?.seq ?? 0) + 1,
        processId: input.processId,
        mode: input.mode,
        supplierId: supplierFor(input.supplierId),
        ownerId: input.ownerId || actorId,
        dueDate: input.dueDate ?? null,
        planStartDate: input.planStartDate ?? null,
        planNodeId: link.value ?? null,
      },
    })
    await syncFirstStep(tx, partId, part.workOrderNumber, before)
    return { ...step, planWarning: stepWarning(step, link.node) }
  })
}

export async function updateStep(stepId: string, input: Partial<StepInput>) {
  return prisma.$transaction((tx) => updateStepTx(tx, stepId, input))
}

/** 改一道工序（在调用方的事务里）：批量编排逐道调用，规则与单道修改完全一样 */
async function updateStepTx(tx: Tx, stepId: string, input: Partial<StepInput>) {
  {
    const found = await tx.routeStep.findUnique({ where: { id: stepId }, select: { partId: true } })
    if (!found) throw new FlowError('步骤不存在或已删除')
    const part = await lockPart(tx, found.partId)
    // 加锁后重读：并发修改可能已改了所属节点 / 状态，用锁后的值做校验
    const step = await tx.routeStep.findUnique({ where: { id: stepId } })
    if (!step) throw new FlowError('步骤不存在或已删除')
    if (input.processId !== undefined) await assertProcess(tx, input.processId)
    const mode = input.mode ?? step.mode
    if (mode !== step.mode && step.status !== 'PENDING') throw new FlowError('步骤已发出或已开工，不能再改加工方式')
    // 改成自制时原来的外协厂不一定是班组：没另外指定就清空
    // 只改方式不传外协厂时：自制 ↔ 外协切换要清掉原来的班组 / 外协厂（两边不通用），厂内 ↔ 厂外外协之间保留
    const crossesSelf = mode !== step.mode && (mode === 'SELF' || step.mode === 'SELF')
    const supplierId = input.supplierId !== undefined ? input.supplierId : crossesSelf ? null : step.supplierId
    if (input.supplierId !== undefined || mode !== step.mode) await assertSelfTeam(tx, mode, supplierId)
    assertDates(
      input.planStartDate !== undefined ? input.planStartDate : step.planStartDate,
      input.dueDate !== undefined ? input.dueDate : step.dueDate,
    )
    const link = await resolvePlanNode(tx, part.workOrderNumber, input.planNodeId, { creating: false, oldNodeId: step.planNodeId })
    const updated = await tx.routeStep.update({
      where: { id: stepId },
      data: {
        ...(input.processId !== undefined ? { processId: input.processId } : {}),
        mode,
        supplierId: supplierFor(supplierId),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId || null } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.planStartDate !== undefined ? { planStartDate: input.planStartDate } : {}),
        ...(link.value !== undefined ? { planNodeId: link.value } : {}),
      },
    })
    // 厂外外协 ↔ 自制 / 厂内外协：没处理的"安排发出 / 安排开工"换成新方式对应的那一类（原地改，负责人和计时不变，手工转交的也一样）
    if (updated.status === 'PENDING' && arrangeAction(updated.mode) !== arrangeAction(step.mode)) {
      await tx.todo.updateMany({
        where: { refType: 'step', refId: stepId, action: arrangeAction(step.mode), status: 'OPEN' },
        data: { action: arrangeAction(updated.mode) },
      })
    }
    // 负责人 / 班组 / 方式变了：没处理的"安排发出 / 开工""可以开工"待办跟着换人（与改负责人同一个口径）
    if (updated.status === 'PENDING' && (updated.ownerId !== step.ownerId || updated.supplierId !== step.supplierId || updated.mode !== step.mode)) {
      await rerouteStepTodos(tx, step, updated, part.workOrderNumber)
    }
    return { ...updated, planWarning: updated.status === 'DONE' ? null : stepWarning(updated, link.node) }
  }
}

type RoutableStep = { id: string; partId: string; seq: number; ownerId: string | null; mode: StepMode; supplierId: string | null }

/** 这道工序没处理的待办"按规则应该在谁手里"：arrange = 安排发出 / 开工；ready = 它是第一道时工件的"可以开工"（不是第一道为 null） */
export interface StepTodoHolders {
  arrange: string[]
  ready: string[] | null
}

/**
 * 按工序当前（或改之前）的负责人 / 班组 / 方式，算出它的待办应该发给谁——和发待办时同一套函数
 * （flow.arrangeOwner、purchases.readyOwners），兜底的人也算在内。改之前、改之后各算一次，交给 moveStepTodos。
 */
export async function stepTodoHolders(tx: Tx, s: RoutableStep, workOrderNumber: string): Promise<StepTodoHolders> {
  const [prev, first] = await Promise.all([
    tx.routeStep.findFirst({ where: { partId: s.partId, seq: { lt: s.seq } }, orderBy: { seq: 'desc' }, select: { ownerId: true } }),
    tx.routeStep.findFirst({ where: { partId: s.partId }, orderBy: { seq: 'asc' }, select: { id: true } }),
  ])
  const target = { ownerId: s.ownerId, mode: s.mode, supplierId: s.supplierId, workOrderNumber }
  const arrange = await arrangeOwner(tx, target, prev?.ownerId ?? null)
  return {
    arrange: arrange ? [arrange] : [],
    ready: first?.id === s.id ? await readyOwners(tx, target, workOrderNumber) : null,
  }
}

/**
 * 工序换了负责人（含改班组、改方式带来的班组长变化）：把这道工序没处理的待办转给新负责人——
 *   这道工序的"安排发出 / 开工"，以及它是第一道时工件的"可以开工"。
 */
async function rerouteStepTodos(tx: Tx, before: RoutableStep, after: RoutableStep, workOrderNumber: string) {
  const from = await stepTodoHolders(tx, before, workOrderNumber)
  const to = await stepTodoHolders(tx, after, workOrderNumber)
  await moveStepTodos(tx, after, from, to)
}

/**
 * 把待办从"改之前按规则在谁手里"（from）转给"改之后应该给谁"（to）。改工序（rerouteStepTodos）、换 / 清班组长（team-leaders.ts）都走这里。
 * 只动 ownerId 在 from 里、又不在 to 里的待办：被手工转交给别人的（ownerId 不在 from 里）不动；还该在原人手里的不动。
 * 原待办标"已转交"、给 to 里每个人建一条（已经有的不重复建）；W2 从最早一条起计时，转交不重新计时。to 为空（算不出新的人）时不动。
 */
export async function moveStepTodos(tx: Tx, step: Pick<RoutableStep, 'id' | 'partId'>, from: StepTodoHolders, to: StepTodoHolders) {
  await moveTodos(tx, { refType: 'step', refId: step.id, action: { in: [ARRANGE_SEND, ARRANGE_START] } }, from.arrange, to.arrange)
  if (from.ready && to.ready) await moveTodos(tx, { refType: 'part', refId: step.partId, action: READY_TO_START }, from.ready, to.ready)
}

async function moveTodos(tx: Tx, where: Prisma.TodoWhereInput, from: string[], to: string[]) {
  const stale = from.filter((u) => !to.includes(u))
  if (!to.length || !stale.length) return
  const open = await tx.todo.findMany({ where: { ...where, status: 'OPEN', ownerId: { in: stale } }, orderBy: { createdAt: 'asc' } })
  if (!open.length) return
  const now = new Date()
  // 同一对象同一类待办：to 里每人一条（原来发给多个兜底的人时合成一份）
  const seen = new Set<string>()
  for (const t of open) {
    // 带 status = OPEN 条件逐条转：读完到这里之间被处理 / 手工转交掉的不再动，也不替它建新的
    const moved = await tx.todo.updateMany({ where: { id: t.id, status: 'OPEN' }, data: { status: 'TRANSFERRED', doneAt: now } })
    if (!moved.count) continue
    const key = `${t.refType}:${t.refId}:${t.action}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const ownerId of to) {
      const exists = await tx.todo.findFirst({ where: { ownerId, refType: t.refType, refId: t.refId, action: t.action, status: 'OPEN' }, select: { id: true } })
      if (!exists) await tx.todo.create({ data: { ownerId, action: t.action, refType: t.refType, refId: t.refId, dueAt: t.dueAt } })
    }
  }
}

/** 工件当前的第一道（判断第一道有没有变） */
export const firstStepOf = (tx: Tx, partId: string) => tx.routeStep.findFirst({ where: { partId }, orderBy: { seq: 'asc' } })

/**
 * 第一道变了（建第一道、复制工序链、套模板、调顺序、删第一道）：工件的"可以开工"按统一规则重新评估——
 *   原来已发的待办从原第一道的负责人转给新第一道的负责人（同 moveStepTodos，手工转交的不动）；
 *   物料图纸早就齐了、还没发过的，现在补发（refreshPartReady notify）；新第一道不能开工的作废。
 * 调用方已锁住工件（锁顺序：工件 → 工序，见 purchases.refreshPartReady）。
 * Reconcile completion after every route edit, including appends that leave the first process unchanged.
 */
export async function syncFirstStep(tx: Tx, partId: string, workOrderNumber: string, before: RoutableStep | null) {
  await refreshPartCompletion(tx, partId, new Date())
  const after = await firstStepOf(tx, partId)
  if ((after?.id ?? null) === (before?.id ?? null)) return
  if (before && after) {
    const [from, to] = await Promise.all([readyOwners(tx, before, workOrderNumber), readyOwners(tx, after, workOrderNumber)])
    await moveTodos(tx, { refType: 'part', refId: partId, action: READY_TO_START }, from, to)
  }
  await refreshPartReady(tx, partId, true)
}

// ───────────── 批量编排（生产管理重设计第一批）─────────────

export interface BatchStepInput {
  partIds: string[]
  /** 只改这道工序；不传 = 这些工件上全部还没完成的工序 */
  processId?: string | null
  set: Pick<Partial<StepInput>, 'ownerId' | 'supplierId' | 'planStartDate' | 'dueDate' | 'planNodeId'>
}

/**
 * 勾选多个工件，一次给工序设负责人、班组 / 外协厂、应开工日、要求完成日、所属总计划节点。只改没完成的工序。
 * 班组（厂内班组）只设到自制工序上，外协厂只设到外协工序上；方式不合的工序不设它（计入 skipped），其他字段照改。
 * 一个事务：任何一道校验不过（如应开工日晚于要求完成日、节点不属于该工单）整批不改，报错写明是哪个工件的哪道工序。
 */
export async function batchUpdateSteps(input: BatchStepInput) {
  return prisma.$transaction(async (tx) => {
    const ids = [...new Set(input.partIds)].sort() // 按 ID 顺序加锁，避免并发批量互相等
    for (const id of ids) await lockPart(tx, id)
    const steps = await tx.routeStep.findMany({
      where: { partId: { in: ids }, status: { not: 'DONE' }, ...(input.processId ? { processId: input.processId } : {}) },
      include: { part: { select: { name: true } } },
      orderBy: [{ partId: 'asc' }, { seq: 'asc' }],
    })
    let teamKind: boolean | null = null
    if (input.set.supplierId) {
      const sup = await tx.qmsSupplier.findFirst({ where: { id: input.set.supplierId, isDeleted: false }, select: { kind: true } })
      if (!sup) throw new FlowError('班组 / 外协厂不存在或已停用')
      teamKind = sup.kind === 'TEAM'
    }
    const names = await loadNames({ process: steps.map((s) => s.processId) })
    let updated = 0
    let skipped = 0
    const warnings: string[] = []
    for (const s of steps) {
      const body: Partial<StepInput> = { ...input.set }
      if (input.set.supplierId !== undefined && input.set.supplierId !== null && teamKind !== null) {
        // 班组只给自制，外协厂只给外协；方式不合的这道不设外协厂 / 班组（其他字段照改）
        if (teamKind !== (s.mode === 'SELF')) {
          delete body.supplierId
          skipped++
        }
      }
      if (!Object.keys(body).length) continue
      try {
        const r = await updateStepTx(tx, s.id, body)
        if (r.planWarning) warnings.push(`${s.part.name} · ${names.process.get(s.processId) ?? s.processId}：${r.planWarning}`)
      } catch (e) {
        if (e instanceof FlowError) throw new FlowError(`${s.part.name} · 第 ${s.seq} 道 ${names.process.get(s.processId) ?? s.processId}：${e.message}`)
        throw e
      }
      updated++
    }
    return { updated, skipped, planWarning: warnings.length ? warnings.slice(0, 3).join('；') + (warnings.length > 3 ? ` 等 ${warnings.length} 道` : '') : null }
  })
}

/** 与相邻步骤交换顺序。两个步骤都不能有流转记录 */
export async function moveStep(stepId: string, direction: 'up' | 'down') {
  return prisma.$transaction(async (tx) => {
    const step = await tx.routeStep.findUnique({ where: { id: stepId } })
    if (!step) throw new FlowError('步骤不存在或已删除')
    const part = await lockPart(tx, step.partId)
    const before = await firstStepOf(tx, step.partId)
    const other = await tx.routeStep.findFirst({
      where: { partId: step.partId, seq: direction === 'up' ? { lt: step.seq } : { gt: step.seq } },
      orderBy: { seq: direction === 'up' ? 'desc' : 'asc' },
    })
    if (!other) throw new FlowError(direction === 'up' ? '已经是第一道' : '已经是最后一道')
    if (await hasEvents(tx, [step.id, other.id])) throw new FlowError('已有流转记录的步骤不能调整顺序')
    // (partId, seq) 唯一：先挪到临时位置再交换
    await tx.routeStep.update({ where: { id: step.id }, data: { seq: -step.seq } })
    await tx.routeStep.update({ where: { id: other.id }, data: { seq: step.seq } })
    await tx.routeStep.update({ where: { id: step.id }, data: { seq: other.seq } })
    await syncFirstStep(tx, step.partId, part.workOrderNumber, before)
    return { ok: true }
  })
}

export async function deleteStep(stepId: string) {
  return prisma.$transaction(async (tx) => {
    const step = await tx.routeStep.findUnique({ where: { id: stepId } })
    if (!step) throw new FlowError('步骤不存在或已删除')
    const part = await lockPart(tx, step.partId)
    if (await hasEvents(tx, [stepId])) throw new FlowError('该步骤已有流转记录，不能删除')
    const before = await firstStepOf(tx, step.partId)
    await tx.todo.updateMany({ where: { refType: 'step', refId: stepId, status: 'OPEN' }, data: { status: 'CANCELLED' } })
    await tx.routeStep.delete({ where: { id: stepId } })
    if (part.currentStepId === stepId) await tx.part.update({ where: { id: part.id }, data: { currentStepId: null } })
    await syncFirstStep(tx, step.partId, part.workOrderNumber, before)
    return { ok: true }
  })
}

/**
 * 从另一个工件复制工序链，追加到目标工件末尾。
 * 复制工序、方式、外协厂、负责人；不复制日期和状态。
 */
export async function copyRoute(targetPartId: string, fromPartId: string, actorId: string) {
  if (targetPartId === fromPartId) throw new FlowError('不能从自己复制')
  return prisma.$transaction(async (tx) => {
    const target = await lockPart(tx, targetPartId)
    const before = await firstStepOf(tx, targetPartId)
    const source = await tx.routeStep.findMany({ where: { partId: fromPartId }, orderBy: { seq: 'asc' } })
    if (!source.length) throw new FlowError('来源工件还没有工序链')
    const last = await tx.routeStep.findFirst({ where: { partId: targetPartId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    let seq = last?.seq ?? 0
    for (const s of source) {
      await tx.routeStep.create({
        data: {
          partId: targetPartId,
          seq: ++seq,
          processId: s.processId,
          mode: s.mode,
          supplierId: s.supplierId,
          ownerId: s.ownerId ?? actorId,
        },
      })
    }
    await syncFirstStep(tx, targetPartId, target.workOrderNumber, before)
    return { copied: source.length }
  })
}
