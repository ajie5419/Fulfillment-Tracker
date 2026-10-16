/**
 * 工件和工序链的增删改。工件挂在工单（qms_work_order.workOrderNumber）下，工序链按 seq 排序。
 * 规则只有两条：已有流转记录的步骤不能删除、不能调顺序；步骤负责人默认是创建人。
 */
import type { Prisma, StepMode } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from './errors'
import { loadNames } from './names'

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

/** 自制步骤不带外协厂 */
const supplierFor = (mode: StepMode, supplierId: string | null | undefined) => (mode === 'SELF' ? null : supplierId || null)

// ───────────── 查询 ─────────────

/** 工单下的工件及其工序链（带名称、已返回数量），供页面直接展示 */
export async function listParts(workOrderNumber: string) {
  const parts = await prisma.part.findMany({
    where: { workOrderNumber },
    orderBy: { createdAt: 'asc' },
    include: { steps: { orderBy: { seq: 'asc' } } },
  })
  const steps = parts.flatMap((p) => p.steps)
  const stepIds = steps.map((s) => s.id)
  const [names, sums, counts] = await Promise.all([
    loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId), user: steps.map((s) => s.ownerId) }),
    prisma.flowEvent.groupBy({
      by: ['stepId'],
      where: { stepId: { in: stepIds }, type: { in: ['RETURN', 'RETURN_MANUAL', 'FINISH'] } },
      _sum: { qty: true },
    }),
    prisma.flowEvent.groupBy({ by: ['stepId'], where: { stepId: { in: stepIds } }, _count: { _all: true } }),
  ])
  const returned = new Map(sums.map((s) => [s.stepId, s._sum.qty ?? 0]))
  const eventCount = new Map(counts.map((c) => [c.stepId, c._count._all]))
  return parts.map((p) => ({
    ...p,
    steps: p.steps.map((s) => ({
      ...s,
      processName: names.process.get(s.processId) ?? s.processId,
      supplierName: s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : null,
      ownerName: s.ownerId ? (names.user.get(s.ownerId) ?? s.ownerId) : null,
      returnedQty: returned.get(s.id) ?? 0,
      eventCount: eventCount.get(s.id) ?? 0,
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
}

/** 追加到工序链末尾。负责人不填时默认是创建人 */
export async function addStep(partId: string, input: StepInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await lockPart(tx, partId)
    await assertProcess(tx, input.processId)
    const last = await tx.routeStep.findFirst({ where: { partId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    return tx.routeStep.create({
      data: {
        partId,
        seq: (last?.seq ?? 0) + 1,
        processId: input.processId,
        mode: input.mode,
        supplierId: supplierFor(input.mode, input.supplierId),
        ownerId: input.ownerId || actorId,
        dueDate: input.dueDate ?? null,
      },
    })
  })
}

export async function updateStep(stepId: string, input: Partial<StepInput>) {
  return prisma.$transaction(async (tx) => {
    const step = await tx.routeStep.findUnique({ where: { id: stepId } })
    if (!step) throw new FlowError('步骤不存在或已删除')
    await lockPart(tx, step.partId)
    if (input.processId !== undefined) await assertProcess(tx, input.processId)
    const mode = input.mode ?? step.mode
    if (mode !== step.mode && step.status !== 'PENDING') throw new FlowError('步骤已发出或已开工，不能再改加工方式')
    const supplierId = input.supplierId !== undefined ? input.supplierId : step.supplierId
    return tx.routeStep.update({
      where: { id: stepId },
      data: {
        ...(input.processId !== undefined ? { processId: input.processId } : {}),
        mode,
        supplierId: supplierFor(mode, supplierId),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId || null } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      },
    })
  })
}

/** 与相邻步骤交换顺序。两个步骤都不能有流转记录 */
export async function moveStep(stepId: string, direction: 'up' | 'down') {
  return prisma.$transaction(async (tx) => {
    const step = await tx.routeStep.findUnique({ where: { id: stepId } })
    if (!step) throw new FlowError('步骤不存在或已删除')
    await lockPart(tx, step.partId)
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
    return { ok: true }
  })
}

export async function deleteStep(stepId: string) {
  return prisma.$transaction(async (tx) => {
    const step = await tx.routeStep.findUnique({ where: { id: stepId } })
    if (!step) throw new FlowError('步骤不存在或已删除')
    const part = await lockPart(tx, step.partId)
    if (await hasEvents(tx, [stepId])) throw new FlowError('该步骤已有流转记录，不能删除')
    await tx.todo.updateMany({ where: { refType: 'step', refId: stepId, status: 'OPEN' }, data: { status: 'CANCELLED' } })
    await tx.routeStep.delete({ where: { id: stepId } })
    if (part.currentStepId === stepId) await tx.part.update({ where: { id: part.id }, data: { currentStepId: null } })
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
    await lockPart(tx, targetPartId)
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
    return { copied: source.length }
  })
}
