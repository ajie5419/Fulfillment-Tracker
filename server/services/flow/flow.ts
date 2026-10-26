/**
 * 工序步骤状态推进（方案 4.3 状态机）。每个对外函数都在一个事务里完成。
 *
 *   待开工 PENDING ──发出登记（厂外外协）──→ 在外加工 OUT ──返厂──→ 已完成 DONE
 *   待开工 PENDING ──开工（自制/厂内外协）──→ 加工中 IN_PROGRESS ──完工 / 返厂──→ 已完成 DONE
 *
 * 返厂（QMS 报检或手工补登）统一走 recordReturn：第一次返厂就给下一道生成待办，
 * 数量全部返回才算完成（方案 4.3 分批返厂）。flow_event 只新增，这里不提供修改和删除。
 */
import type { FlowEventType, FlowSource, Part, Prisma, RouteStep } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { alertKey } from '../alerts/rules'
import { READY_TO_START } from '../purchases/constants'
import { FlowError } from './errors'

type Tx = Prisma.TransactionClient

/** 计入"已返回数量"的事件类型。完工按全部返回处理，也计入 */
const RETURN_TYPES: FlowEventType[] = ['RETURN', 'RETURN_MANUAL', 'FINISH']

export const ARRANGE_SEND = 'ARRANGE_SEND'
export const ARRANGE_START = 'ARRANGE_START'

/** 锁住步骤行再读，保证同一步骤的返厂、发出串行执行（判断"第一次返厂"、累计数量不会算重） */
export async function lockStep(tx: Tx, stepId: string): Promise<RouteStep & { part: Part }> {
  // 状态取自加锁读：事务里之前若有过普通读，普通读用的是旧快照，可能是过期状态
  const [locked] = await tx.$queryRaw<{ status: RouteStep['status'] }[]>`SELECT status FROM route_step WHERE id = ${stepId} FOR UPDATE`
  if (!locked) throw new FlowError('步骤不存在或已删除')
  const step = await tx.routeStep.findUnique({ where: { id: stepId }, include: { part: true } })
  if (!step) throw new FlowError('步骤不存在或已删除')
  return { ...step, status: locked.status }
}

/** 立即消除该步骤上指定规则的活动预警（扫描任务也会兜底消除，这里让页面马上看到） */
async function clearStepAlerts(tx: Tx, stepId: string, rules: ('W2' | 'W3' | 'W10')[]) {
  await clearAlertKeys(tx, rules.map((r) => alertKey(r, 'step', stepId)))
}

/** 工件已经动起来了（开工、发出、返厂）：关闭它的"可以开工"待办（R10） */
async function closeReadyTodos(tx: Tx, partId: string, now: Date) {
  await tx.todo.updateMany({ where: { refType: 'part', refId: partId, action: READY_TO_START, status: 'OPEN' }, data: { status: 'DONE', doneAt: now } })
}

/** 关闭该步骤上指定类型的未完成待办 */
async function closeTodos(tx: Tx, stepId: string, actions: string[], now: Date) {
  await tx.todo.updateMany({
    where: { refType: 'step', refId: stepId, action: { in: actions }, status: 'OPEN' },
    data: { status: 'DONE', doneAt: now },
  })
}

export interface SendInput {
  stepId: string
  supplierId?: string | null
  promisedReturnDate: Date
  qty?: number
  actorId: string
  source: FlowSource
}

/** 发出登记：仅厂外外协、待开工的步骤。前一道没完成也允许发出（现场常有先后不一）。 */
export function sendStep(input: SendInput) {
  return prisma.$transaction(async (tx) => {
    const step = await lockStep(tx, input.stepId)
    if (step.mode !== 'EXTERNAL_OUTSOURCE') throw new FlowError('只有厂外外协的步骤需要发出登记')
    if (step.status !== 'PENDING') throw new FlowError('该步骤已发出或已完成，不能重复发出')
    const supplierId = input.supplierId || step.supplierId
    if (!supplierId) throw new FlowError('请选择外协厂')
    const supplier = await tx.qmsSupplier.findFirst({ where: { id: supplierId, isDeleted: false }, select: { id: true } })
    if (!supplier) throw new FlowError('外协厂不存在或已停用')

    const now = new Date()
    const updated = await tx.routeStep.update({
      where: { id: step.id },
      data: { supplierId, promisedReturnDate: input.promisedReturnDate, status: 'OUT', startedAt: now },
    })
    await tx.flowEvent.create({
      data: {
        stepId: step.id,
        type: 'SEND',
        qty: input.qty ?? step.part.quantity,
        source: input.source,
        actorId: input.actorId,
        occurredAt: now,
      },
    })
    await closeTodos(tx, step.id, [ARRANGE_SEND], now)
    await closeReadyTodos(tx, step.partId, now)
    await clearStepAlerts(tx, step.id, ['W2'])
    await tx.part.update({ where: { id: step.partId }, data: { currentStepId: step.id, statusSince: now } })
    return updated
  })
}

export interface ActInput {
  stepId: string
  actorId: string
  source: FlowSource
}

function assertInPlant(step: RouteStep) {
  if (step.mode === 'EXTERNAL_OUTSOURCE') throw new FlowError('厂外外协的步骤请用发出登记和返厂，不用开工/完工')
}

/** 开工：自制、厂内外协。 */
export function startStep(input: ActInput) {
  return prisma.$transaction(async (tx) => {
    const step = await lockStep(tx, input.stepId)
    assertInPlant(step)
    if (step.status !== 'PENDING') throw new FlowError('该步骤已开工或已完成')
    const now = new Date()
    const updated = await tx.routeStep.update({ where: { id: step.id }, data: { status: 'IN_PROGRESS', startedAt: now } })
    await tx.flowEvent.create({
      data: { stepId: step.id, type: 'START', qty: step.part.quantity, source: input.source, actorId: input.actorId, occurredAt: now },
    })
    await closeTodos(tx, step.id, [ARRANGE_START], now)
    await closeReadyTodos(tx, step.partId, now)
    await clearStepAlerts(tx, step.id, ['W2'])
    await tx.part.update({ where: { id: step.partId }, data: { currentStepId: step.id, statusSince: now } })
    return updated
  })
}

/** 完工：自制、厂内外协。效果与"剩余数量全部返厂"相同。没点开工直接完工也允许（开工是可选的）。 */
export function finishStep(input: ActInput) {
  return prisma.$transaction(async (tx) => {
    const step = await lockStep(tx, input.stepId)
    assertInPlant(step)
    if (step.status !== 'PENDING' && step.status !== 'IN_PROGRESS') throw new FlowError('该步骤已完成')
    const returned = await returnedQty(tx, step.id)
    return applyReturn(tx, step, {
      type: 'FINISH',
      qty: Math.max(step.part.quantity - returned, 0),
      source: input.source,
      actorId: input.actorId,
      occurredAt: new Date(),
      forceDone: true,
    })
  })
}

export interface ReturnInput {
  stepId: string
  qty: number
  source: FlowSource
  qmsInspectionId?: string | null
  actorId?: string | null
  occurredAt: Date
}

export interface ReturnResult {
  duplicate: boolean
  stepDone: boolean
  todoCreated: boolean
}

/**
 * 返厂：QMS 报检匹配、人工关联、手工补登共用。调用方负责开事务。
 * 同一 qmsInspectionId 已记录过时直接返回 duplicate，不做任何改动（幂等）。
 */
export async function recordReturn(tx: Tx, input: ReturnInput): Promise<ReturnResult> {
  if (input.qty < 0) throw new FlowError('返厂数量不能为负数')
  const step = await lockStep(tx, input.stepId)
  if (input.qmsInspectionId) {
    const existing = await tx.flowEvent.findUnique({ where: { qmsInspectionId: input.qmsInspectionId }, select: { id: true } })
    if (existing) return { duplicate: true, stepDone: false, todoCreated: false }
  }
  return applyReturn(tx, step, {
    type: input.qmsInspectionId ? 'RETURN' : 'RETURN_MANUAL',
    qty: input.qty,
    source: input.source,
    qmsInspectionId: input.qmsInspectionId ?? null,
    actorId: input.actorId ?? null,
    occurredAt: input.occurredAt,
    forceDone: false,
  })
}

/** 手工补登返厂（漏报兜底），自带事务 */
export async function manualReturn(input: { stepId: string; qty: number; actorId: string; source: FlowSource }) {
  if (input.qty <= 0) throw new FlowError('返厂数量必须大于 0')
  return prisma.$transaction((tx) => recordReturn(tx, { ...input, occurredAt: new Date() }))
}

async function returnedQty(tx: Tx, stepId: string) {
  const agg = await tx.flowEvent.aggregate({ where: { stepId, type: { in: RETURN_TYPES } }, _sum: { qty: true } })
  return agg._sum.qty ?? 0
}

async function applyReturn(
  tx: Tx,
  step: RouteStep & { part: Part },
  e: {
    type: FlowEventType
    qty: number
    source: FlowSource
    qmsInspectionId?: string | null
    actorId: string | null
    occurredAt: Date
    forceDone: boolean
  },
): Promise<ReturnResult> {
  const prevCount = await tx.flowEvent.count({ where: { stepId: step.id, type: { in: RETURN_TYPES } } })
  const prevQty = await returnedQty(tx, step.id)
  await tx.flowEvent.create({
    data: {
      stepId: step.id,
      type: e.type,
      qty: e.qty,
      source: e.source,
      qmsInspectionId: e.qmsInspectionId ?? null,
      actorId: e.actorId,
      occurredAt: e.occurredAt,
    },
  })

  // 已完成（或有异常）的步骤再收到返厂：只记事件
  if (step.status === 'DONE' || step.status === 'BLOCKED') return { duplicate: false, stepDone: false, todoCreated: false }

  const now = new Date()
  const next = await tx.routeStep.findFirst({ where: { partId: step.partId, seq: { gt: step.seq } }, orderBy: { seq: 'asc' } })

  // 第一次返厂就给下一道发待办（结构件常常先回来先转）。下一道已经发出/开工的不再提醒
  let todoCreated = false
  if (prevCount === 0 && next && next.status === 'PENDING') {
    const ownerId = next.ownerId ?? step.ownerId
    const action = next.mode === 'EXTERNAL_OUTSOURCE' ? ARRANGE_SEND : ARRANGE_START
    if (ownerId) {
      const open = await tx.todo.findFirst({ where: { refType: 'step', refId: next.id, action, status: 'OPEN' }, select: { id: true } })
      if (!open) {
        await tx.todo.create({ data: { ownerId, action, refType: 'step', refId: next.id } })
        todoCreated = true
      }
    }
  }

  const done = e.forceDone || prevQty + e.qty >= step.part.quantity
  const wasPending = step.status === 'PENDING'
  await tx.routeStep.update({
    where: { id: step.id },
    data: {
      // 没登记发出/开工就返厂了（漏登），按已开始处理
      startedAt: step.startedAt ?? e.occurredAt,
      ...(done
        ? { status: 'DONE', finishedAt: e.occurredAt }
        : wasPending
          ? { status: step.mode === 'EXTERNAL_OUTSOURCE' ? 'OUT' : 'IN_PROGRESS' }
          : {}),
    },
  })
  // 已经有了返厂，本步骤的"安排发出/开工"待办、工件的"可以开工"待办没有意义了
  await closeTodos(tx, step.id, [ARRANGE_SEND, ARRANGE_START], now)
  await closeReadyTodos(tx, step.partId, now)

  if (done) {
    await tx.part.update({
      where: { id: step.partId },
      data: next ? { currentStepId: next.id, statusSince: now } : { status: 'DONE', statusSince: now },
    })
  } else if (wasPending) {
    await tx.part.update({ where: { id: step.partId }, data: { currentStepId: step.id, statusSince: now } })
  }

  // 消除该步骤的 W3（承诺返回日逾期）预警；步骤已离开待开工，W2（转序停滞）也一并消除；完工了 W10（厂内工序逾期）也消除
  await clearStepAlerts(tx, step.id, done ? ['W2', 'W3', 'W10'] : ['W2', 'W3'])

  return { duplicate: false, stepDone: done, todoCreated }
}

// ───────────── 有异常（方案 4.3：已完成 ⇄ 有异常）─────────────

/**
 * QMS 检验判不合格 → 步骤置为"有异常"。调用方（异常模块）负责开事务、并与生成异常放在同一事务。
 * 已是有异常的不重复处理。步骤还在外（部分返回）时也置为有异常，之后的返厂只记事件。
 */
export async function blockStep(tx: Tx, stepId: string) {
  const step = await lockStep(tx, stepId)
  if (step.status === 'BLOCKED') return false
  await tx.routeStep.update({ where: { id: step.id }, data: { status: 'BLOCKED' } })
  // 步骤不再"在外"/"加工中"，W3、W10（逾期）没有意义了，由异常跟进；W2 只看待开工的步骤，不受影响
  await clearStepAlerts(tx, step.id, ['W3', 'W10'])
  return true
}

/**
 * 关联的异常全部关闭后恢复步骤：数量已全部返回（或已完工）→ 已完成，否则回到 在外加工 / 加工中。
 * 由异常关闭的事务调用；该步骤还有其他未关闭异常时不恢复（由调用方判断）。
 * 恢复为已完成且工件当前步骤还停在这一步时（被拦下时还没全部返回），工件指针推进到下一道。
 */
export async function restoreBlockedStep(tx: Tx, stepId: string) {
  const step = await lockStep(tx, stepId)
  if (step.status !== 'BLOCKED') return null
  const returned = await returnedQty(tx, step.id)
  const finished = (await tx.flowEvent.count({ where: { stepId: step.id, type: 'FINISH' } })) > 0
  const done = finished || returned >= step.part.quantity
  const now = new Date()
  const status = done ? 'DONE' : step.mode === 'EXTERNAL_OUTSOURCE' ? 'OUT' : 'IN_PROGRESS'
  await tx.routeStep.update({ where: { id: step.id }, data: { status, ...(done && !step.finishedAt ? { finishedAt: now } : {}) } })
  if (done && step.part.currentStepId === step.id) {
    const next = await tx.routeStep.findFirst({ where: { partId: step.partId, seq: { gt: step.seq } }, orderBy: { seq: 'asc' } })
    await tx.part.update({
      where: { id: step.partId },
      data: next ? { currentStepId: next.id, statusSince: now } : { status: 'DONE', statusSince: now },
    })
  }
  return status
}
