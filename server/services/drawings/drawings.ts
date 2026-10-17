/**
 * 设计出图任务（R11）：按部件拆出图任务，标记出图、客户确认（独立节点）、一键生成 R9 发放单、设计负荷。
 *
 * 状态由事实推出（constants.ts deriveStatus）：待出图 → 已出图（未发放）→ 待客户确认（已发放、需要客户确认）→ 已完成；另有 已取消。
 * "已发放" = 有关联本任务的、不是作废状态的发放单（doc_release.drawingTaskId）。
 *
 * 权限从简（接口层判断可见范围）：能看到该工单的人都能新建、编辑、录客户确认；标记出图 / 撤销出图只能设计负责人本人或管理员。
 * 设计负责人本人不受工单可见范围限制（"我的出图任务"）。
 *
 * "可以开工"门槛：关联工件上有未完成（未取消）的出图任务时不发；任务变成 已完成 / 已取消 或不再关联该工件的那一刻
 * 重新评估（purchases.ts refreshPartReady，notify），回到未完成（撤销出图、发放单作废、重新启用）时作废没处理的待办。
 *
 * 并发：沿用 R10 采购的做法——READ COMMITTED，加锁顺序 先工件（按 ID 排序）→ 再出图任务（FOR UPDATE）→ 发放单。
 */
import type { DrawingTask, DrawingTaskStatus, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { alertKey, dateFieldDay, shanghaiDay } from '../alerts/rules'
import { FlowError, FlowForbidden } from '../flow/errors'
import { loadNames } from '../flow/names'
import { todayDate } from '../purchases/constants'
import { lockParts, purchaseTx, refreshPartReady } from '../purchases/purchases'
import { TYPE_TEXT } from '../releases/constants'
import { DRAWING_STATUS_TEXT, OPEN_DRAWING_STATUSES, TECH_DEPT, canReleaseFrom, deriveStatus, isOverdue, thisWeek } from './constants'

type Tx = Prisma.TransactionClient
type TaskWithParts = DrawingTask & { parts: { partId: string }[] }

export interface Actor {
  userId: string
  isAdmin: boolean
}

export interface TaskInput {
  partIds?: string[]
  componentName: string
  ownerId?: string | null
  planDate: Date
  needsCustomerConfirm?: boolean
  customerPlanDate?: Date | null
  note?: string | null
}

export interface NewTaskInput extends TaskInput {
  workOrderNumber: string
}

export interface PatchTaskInput extends Partial<TaskInput> {
  /** 取消 / 重新启用 */
  cancelled?: boolean
}

export const w7Key = (id: string) => alertKey('W7', 'drawing', id)

/** 出图任务相关的事务：与采购同一套（READ COMMITTED） */
export const drawingTx = purchaseTx

const uniq = <T>(xs: T[]) => [...new Set(xs)]

/** 先锁关联工件（及 alsoParts，如编辑后要关联的新工件），再锁出图任务行并读最新数据 */
export async function lockTask(tx: Tx, id: string, alsoParts: string[] = []): Promise<TaskWithParts> {
  const cur = await tx.drawingTaskPart.findMany({ where: { taskId: id }, select: { partId: true } })
  await lockParts(tx, [...cur.map((p) => p.partId), ...alsoParts])
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM drawing_task WHERE id = ${id} FOR UPDATE`
  if (!rows.length) throw new FlowError('出图任务不存在')
  const task = await tx.drawingTask.findUniqueOrThrow({ where: { id }, include: { parts: { select: { partId: true } } } })
  // 极少见：锁之前关联工件刚被改过
  const extra = task.parts.map((p) => p.partId).filter((p) => !cur.some((c) => c.partId === p))
  if (extra.length) await lockParts(tx, extra)
  return task
}

/** 是否有关联本任务、不是作废状态的发放单 */
async function isReleased(tx: Tx, taskId: string) {
  return (await tx.release.count({ where: { drawingTaskId: taskId, status: 'ACTIVE' } })) > 0
}

const blocking = (s: DrawingTaskStatus) => OPEN_DRAWING_STATUSES.includes(s)

/**
 * 按最新事实重算状态并写回；然后对受影响的工件重新评估"可以开工"：
 * 原来挡着某个工件（未完成、且关联着）、现在不再挡（完成 / 取消 / 不再关联）→ notify；其余只作废（还没齐时）。
 */
export async function settleTask(tx: Tx, before: { status: DrawingTaskStatus; partIds: string[] }, taskId: string) {
  const task = await tx.drawingTask.findUniqueOrThrow({ where: { id: taskId }, include: { parts: { select: { partId: true } } } })
  const status = deriveStatus({
    cancelled: task.status === 'CANCELLED',
    drawnDate: task.drawnDate,
    needsCustomerConfirm: task.needsCustomerConfirm,
    customerConfirmedDate: task.customerConfirmedDate,
    released: await isReleased(tx, taskId),
  })
  if (status !== task.status) await tx.drawingTask.update({ where: { id: taskId }, data: { status } })
  if (!blocking(status)) await clearAlertKeys(tx, [w7Key(taskId)])
  const nowParts = task.parts.map((p) => p.partId)
  let readySent = 0
  for (const partId of uniq([...before.partIds, ...nowParts]).sort()) {
    const wasBlocking = before.partIds.includes(partId) && blocking(before.status)
    const stillBlocking = nowParts.includes(partId) && blocking(status)
    if ((await refreshPartReady(tx, partId, wasBlocking && !stillBlocking)) === 'sent') readySent++
  }
  return { status, readySent }
}

// ───────────── 校验 ─────────────

async function assertOwner(tx: Tx, ownerId: string | null | undefined) {
  if (!ownerId) return
  const u = await tx.qmsUser.findFirst({ where: { id: ownerId, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })
  if (!u) throw new FlowError('设计负责人不存在或已停用')
}

async function assertParts(tx: Tx, partIds: string[], workOrderNumber: string) {
  if (!partIds.length) return
  const parts = await tx.part.findMany({ where: { id: { in: partIds } }, select: { workOrderNumber: true } })
  if (parts.length !== partIds.length || parts.some((p) => p.workOrderNumber !== workOrderNumber)) throw new FlowError('关联工件不存在或不属于该工单')
}

function assertCustomerPlan(needs: boolean, customerPlanDate: Date | null | undefined) {
  if (!needs && customerPlanDate) throw new FlowError('不需要客户确认时不用填客户确认计划日')
}

function assertNotFuture(d: Date, now: Date, what: string) {
  if (dateFieldDay(d) > shanghaiDay(now)) throw new FlowError(`${what}不能晚于今天`)
}

const canDraw = (task: { ownerId: string | null }, actor: Actor) => actor.isAdmin || (!!task.ownerId && task.ownerId === actor.userId)

// ───────────── 新建 / 修改 ─────────────

export async function createTask(input: NewTaskInput, actorId: string) {
  const partIds = uniq(input.partIds ?? [])
  const needs = !!input.needsCustomerConfirm
  assertCustomerPlan(needs, input.customerPlanDate)
  return drawingTx(async (tx) => {
    await lockParts(tx, partIds)
    const wo = await tx.qmsWorkOrder.findFirst({ where: { workOrderNumber: input.workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
    if (!wo) throw new FlowError('工单不存在或已删除')
    await assertParts(tx, partIds, wo.workOrderNumber)
    await assertOwner(tx, input.ownerId)
    const task = await tx.drawingTask.create({
      data: {
        workOrderNumber: wo.workOrderNumber,
        componentName: input.componentName.trim(),
        ownerId: input.ownerId || null,
        planDate: input.planDate,
        needsCustomerConfirm: needs,
        customerPlanDate: needs ? (input.customerPlanDate ?? null) : null,
        note: input.note?.trim() || null,
        createdBy: actorId,
        parts: { create: partIds.map((partId) => ({ partId })) },
      },
    })
    // 新挂上一个待出图的任务：这些工件没处理的"可以开工"待办作废
    for (const partId of [...partIds].sort()) await refreshPartReady(tx, partId, false)
    return task
  })
}

export async function updateTask(id: string, input: PatchTaskInput) {
  const newParts = input.partIds ? uniq(input.partIds) : undefined
  return drawingTx(async (tx) => {
    const old = await lockTask(tx, id, newParts)
    const before = { status: old.status, partIds: old.parts.map((p) => p.partId) }
    const data: Prisma.DrawingTaskUncheckedUpdateInput = {}
    if (input.componentName !== undefined) data.componentName = input.componentName.trim()
    if (input.ownerId !== undefined) {
      await assertOwner(tx, input.ownerId)
      data.ownerId = input.ownerId || null
    }
    if (input.planDate !== undefined) data.planDate = input.planDate
    const needs = input.needsCustomerConfirm ?? old.needsCustomerConfirm
    if (input.needsCustomerConfirm !== undefined) data.needsCustomerConfirm = needs
    if (input.customerPlanDate !== undefined) data.customerPlanDate = input.customerPlanDate
    assertCustomerPlan(needs, input.customerPlanDate)
    if (!needs) Object.assign(data, { customerPlanDate: null, customerConfirmedDate: null, customerConfirmedBy: null })
    if (input.note !== undefined) data.note = input.note?.trim() || null
    if (input.cancelled !== undefined && input.cancelled !== (old.status === 'CANCELLED')) {
      // 先标成取消 / 待出图，settleTask 再按事实推出准确状态
      data.status = input.cancelled ? 'CANCELLED' : 'PENDING'
    }
    if (newParts) {
      await assertParts(tx, newParts, old.workOrderNumber)
      await tx.drawingTaskPart.deleteMany({ where: { taskId: id, partId: { notIn: newParts } } })
      await tx.drawingTaskPart.createMany({ data: newParts.map((partId) => ({ taskId: id, partId })), skipDuplicates: true })
    }
    if (Object.keys(data).length) await tx.drawingTask.update({ where: { id }, data })
    // 计划日、客户确认改了：预警按新日期重算（下一轮扫描），先清掉旧的
    if (input.planDate !== undefined || input.customerPlanDate !== undefined || input.needsCustomerConfirm !== undefined) await clearAlertKeys(tx, [w7Key(id)])
    const r = await settleTask(tx, before, id)
    return { id, ...r }
  })
}

// ───────────── 出图 / 客户确认 ─────────────

/** 标记出图：设计负责人本人或管理员。出图日默认今天、不能晚于今天 */
export async function markDrawn(id: string, drawnDate: Date | null | undefined, actor: Actor) {
  const now = new Date()
  const day = drawnDate ?? todayDate(now)
  assertNotFuture(day, now, '出图日期')
  return drawingTx(async (tx) => {
    const task = await lockTask(tx, id)
    if (!canDraw(task, actor)) throw new FlowForbidden('只有设计负责人本人或管理员可以标记出图')
    if (task.status === 'CANCELLED') throw new FlowError('出图任务已取消')
    if (task.drawnDate) throw new FlowError('已经标记过出图了，请刷新')
    await tx.drawingTask.update({ where: { id }, data: { drawnDate: day, drawnBy: actor.userId } })
    await clearAlertKeys(tx, [w7Key(id)])
    const r = await settleTask(tx, { status: task.status, partIds: task.parts.map((p) => p.partId) }, id)
    return { id, ...r }
  })
}

/** 撤销出图（标错了）：设计负责人本人或管理员；已经发放了的要先作废发放单。客户确认一并清掉 */
export async function undoDrawn(id: string, actor: Actor) {
  return drawingTx(async (tx) => {
    const task = await lockTask(tx, id)
    if (!canDraw(task, actor)) throw new FlowForbidden('只有设计负责人本人或管理员可以撤销出图')
    if (!task.drawnDate) throw new FlowError('还没有出图')
    if (await isReleased(tx, id)) throw new FlowError('图纸已经发放了，请先作废发放单再撤销出图')
    await tx.drawingTask.update({ where: { id }, data: { drawnDate: null, drawnBy: null, customerConfirmedDate: null, customerConfirmedBy: null } })
    const r = await settleTask(tx, { status: task.status, partIds: task.parts.map((p) => p.partId) }, id)
    return { id, ...r }
  })
}

/** 录客户确认（独立节点）：能看到该工单的人都可以录。要先出图；确认日默认今天、不能晚于今天 */
export async function confirmCustomer(id: string, confirmedDate: Date | null | undefined, actorId: string) {
  const now = new Date()
  const day = confirmedDate ?? todayDate(now)
  assertNotFuture(day, now, '客户确认日期')
  return drawingTx(async (tx) => {
    const task = await lockTask(tx, id)
    if (task.status === 'CANCELLED') throw new FlowError('出图任务已取消')
    if (!task.needsCustomerConfirm) throw new FlowError('这个任务不需要客户确认')
    if (!task.drawnDate) throw new FlowError('还没有出图，不能录客户确认')
    if (task.customerConfirmedDate) throw new FlowError('客户已经确认过了，请刷新')
    await tx.drawingTask.update({ where: { id }, data: { customerConfirmedDate: day, customerConfirmedBy: actorId } })
    await clearAlertKeys(tx, [w7Key(id)])
    const r = await settleTask(tx, { status: task.status, partIds: task.parts.map((p) => p.partId) }, id)
    return { id, ...r }
  })
}

export async function undoCustomer(id: string) {
  return drawingTx(async (tx) => {
    const task = await lockTask(tx, id)
    if (!task.customerConfirmedDate) throw new FlowError('客户还没有确认')
    await tx.drawingTask.update({ where: { id }, data: { customerConfirmedDate: null, customerConfirmedBy: null } })
    const r = await settleTask(tx, { status: task.status, partIds: task.parts.map((p) => p.partId) }, id)
    return { id, ...r }
  })
}

// ───────────── 发放（R9 发放单）─────────────

/**
 * 建发放单时关联出图任务（releases.ts createRelease 在同一事务里调用，此前已 lockTask）：
 * 要求同一工单、已出图、未取消；类型只能是图纸或设计变更。
 */
export function assertReleasable(task: TaskWithParts, workOrderNumber: string, type: string) {
  if (task.workOrderNumber !== workOrderNumber) throw new FlowError('出图任务不属于该工单')
  if (type !== 'DRAWING' && type !== 'CHANGE') throw new FlowError('从出图任务发放时类型只能是图纸或设计变更')
  if (!canReleaseFrom(task.status)) throw new FlowError(task.status === 'CANCELLED' ? '出图任务已取消' : '还没有出图，不能发放')
}

// ───────────── 查询 ─────────────

export type TaskView = 'open' | 'pending' | 'overdue' | 'drawn' | 'done' | 'cancelled' | 'all'

export interface TaskFilter {
  workOrderNumber?: string
  ownerId?: string
  view?: TaskView
  q?: string
  /** 可见工单（undefined = 全部） */
  visibleWorkOrders?: string[]
}

/** 每次最多返回的行数（在数据库里先筛选、排序后再截断） */
const MAX_LIST_ROWS = 500

/** 出图逾期（与 constants.ts isOverdue 一致；日期都存为当天 UTC 零点，直接比较） */
export function overdueWhere(today: Date): Prisma.DrawingTaskWhereInput {
  return {
    OR: [
      { status: 'PENDING', planDate: { lt: today } },
      { status: { in: ['DRAWN', 'CUSTOMER_PENDING'] }, needsCustomerConfirm: true, customerConfirmedDate: null, customerPlanDate: { lt: today } },
    ],
  }
}

function viewWhere(view: TaskView, today: Date): Prisma.DrawingTaskWhereInput {
  switch (view) {
    case 'open':
      return { status: { in: OPEN_DRAWING_STATUSES } }
    case 'pending':
      return { status: 'PENDING' }
    case 'overdue':
      return overdueWhere(today)
    case 'drawn':
      return { status: { in: ['DRAWN', 'CUSTOMER_PENDING'] } }
    case 'done':
      return { status: 'DONE' }
    case 'cancelled':
      return { status: 'CANCELLED' }
    default:
      return {}
  }
}

async function techHeadText() {
  const heads = await prisma.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: TECH_DEPT }, select: { userId: true } })
  const names = (await loadNames({ user: heads.map((h) => h.userId) })).user
  return heads.length ? `${TECH_DEPT}（${heads.map((h) => names.get(h.userId) ?? h.userId).join('、')}）` : `${TECH_DEPT}负责人（未设置）`
}

async function describeTasks(rows: TaskWithParts[], now: Date, viewer?: Actor) {
  const partIds = uniq(rows.flatMap((r) => r.parts.map((p) => p.partId)))
  const ids = rows.map((r) => r.id)
  const [parts, names, releases, alerts, deptHead] = await Promise.all([
    partIds.length ? prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true, drawingNo: true } }) : [],
    loadNames({ user: rows.flatMap((r) => [r.ownerId, r.drawnBy, r.customerConfirmedBy]) }),
    ids.length
      ? prisma.release.findMany({ where: { drawingTaskId: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { id: true, releaseNo: true, type: true, status: true, version: true, drawingTaskId: true } })
      : [],
    ids.length ? prisma.alert.findMany({ where: { activeKey: { in: ids.map(w7Key) } }, select: { activeKey: true, level: true } }) : [],
    techHeadText(),
  ])
  const partOf = new Map(parts.map((p) => [p.id, p]))
  const levelOf = new Map(alerts.map((a) => [a.activeKey!, a.level]))
  const user = (id: string | null) => (id ? (names.user.get(id) ?? id) : null)
  return rows.map(({ parts: links, ...t }) => {
    const mine = releases.filter((r) => r.drawingTaskId === t.id)
    const isOwner = !!viewer && !!t.ownerId && t.ownerId === viewer.userId
    const drawable = !!viewer && (viewer.isAdmin || isOwner)
    return {
      ...t,
      statusText: DRAWING_STATUS_TEXT[t.status],
      partIds: links.map((p) => p.partId),
      parts: links.map((p) => {
        const part = partOf.get(p.partId)
        return { id: p.partId, name: part ? (part.drawingNo ? `${part.name}（${part.drawingNo}）` : part.name) : '（已删除的工件）' }
      }),
      ownerName: user(t.ownerId),
      /** 没指定设计负责人时显示默认责任人 */
      ownerText: user(t.ownerId) ?? deptHead,
      drawnByName: user(t.drawnBy),
      customerConfirmedByName: user(t.customerConfirmedBy),
      overdue: isOverdue(t, now),
      releases: mine.map((r) => ({ id: r.id, releaseNo: r.releaseNo, typeText: TYPE_TEXT[r.type], status: r.status, version: r.version })),
      alertLevel: levelOf.get(w7Key(t.id)) ?? null,
      permissions: {
        markDrawn: drawable && t.status === 'PENDING',
        undoDrawn: drawable && !!t.drawnDate && !mine.some((r) => r.status === 'ACTIVE'),
        confirm: t.status !== 'CANCELLED' && t.needsCustomerConfirm && !!t.drawnDate && !t.customerConfirmedDate,
        release: canReleaseFrom(t.status),
      },
    }
  })
}

const PARTS_INCLUDE = { parts: { select: { partId: true } } } as const

/** 统计：按可见范围、所选工单 / 负责人，不受视图和搜索影响；用 count，不受列表截断影响 */
async function taskStats(scope: Prisma.DrawingTaskWhereInput[], now: Date) {
  const today = todayDate(now)
  const { monday, sunday } = thisWeek(now)
  const count = (w: Prisma.DrawingTaskWhereInput) => prisma.drawingTask.count({ where: { AND: [...scope, w] } })
  const [pending, drawn, customerPending, overdue, dueThisWeek] = await Promise.all([
    count({ status: 'PENDING' }),
    count({ status: 'DRAWN' }),
    count({ status: 'CUSTOMER_PENDING' }),
    count(overdueWhere(today)),
    count({ status: 'PENDING', planDate: { gte: monday, lte: sunday } }),
  ])
  return { pending, drawn, customerPending, overdue, dueThisWeek }
}

/**
 * 出图任务列表 + 统计。视图、负责人、关键字在数据库里筛选，再按顺序截断到 500 行（total 是筛选后的总数）。
 * 排序：状态（待出图 → 已出图 → 待客户确认 → 已完成 → 已取消）→ 计划完成日从近到远。
 */
export async function listTasks(filter: TaskFilter, viewer: Actor, now = new Date()) {
  const today = todayDate(now)
  const scope: Prisma.DrawingTaskWhereInput[] = []
  if (filter.visibleWorkOrders) scope.push({ workOrderNumber: { in: filter.visibleWorkOrders } })
  if (filter.workOrderNumber) scope.push({ workOrderNumber: filter.workOrderNumber })
  if (filter.ownerId) scope.push({ ownerId: filter.ownerId })
  const q = filter.q?.trim()
  const search: Prisma.DrawingTaskWhereInput[] = q ? [{ OR: [{ componentName: { contains: q } }, { workOrderNumber: { contains: q } }, { note: { contains: q } }] }] : []
  const where: Prisma.DrawingTaskWhereInput = { AND: [...scope, viewWhere(filter.view ?? 'open', today), ...search] }
  const orderBy: Prisma.DrawingTaskOrderByWithRelationInput[] = [{ status: 'asc' }, { planDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
  const [found, total, stats] = await Promise.all([
    prisma.drawingTask.findMany({ where, include: PARTS_INCLUDE, orderBy, take: MAX_LIST_ROWS }),
    prisma.drawingTask.count({ where }),
    taskStats(scope, now),
  ])
  return { rows: await describeTasks(found, now, viewer), total, stats }
}

/** 单个任务（编辑、从提醒跳转） */
export async function getTask(id: string, viewer: Actor, now = new Date()) {
  const task = await prisma.drawingTask.findUnique({ where: { id }, include: PARTS_INCLUDE })
  if (!task) throw new FlowError('出图任务不存在')
  const [row] = await describeTasks([task], now, viewer)
  return row!
}

/**
 * 设计负荷：按设计负责人列 在手任务数（未完成）、逾期数、本周到期（待出图、计划完成日在本周）、待客户确认数。
 * 都用 groupBy 在数据库里算；没指定负责人的单独一行（技术部负责人）。逾期多的在前。
 */
export async function designLoad(filter: { workOrderNumber?: string; visibleWorkOrders?: string[] }, now = new Date()) {
  const today = todayDate(now)
  const { monday, sunday } = thisWeek(now)
  const scope: Prisma.DrawingTaskWhereInput[] = []
  if (filter.visibleWorkOrders) scope.push({ workOrderNumber: { in: filter.visibleWorkOrders } })
  if (filter.workOrderNumber) scope.push({ workOrderNumber: filter.workOrderNumber })
  const group = (w: Prisma.DrawingTaskWhereInput) => prisma.drawingTask.groupBy({ by: ['ownerId'], where: { AND: [...scope, w] }, _count: { _all: true } })
  const [open, overdue, dueThisWeek, pendingDraw, customer] = await Promise.all([
    group({ status: { in: OPEN_DRAWING_STATUSES } }),
    group(overdueWhere(today)),
    group({ status: 'PENDING', planDate: { gte: monday, lte: sunday } }),
    group({ status: 'PENDING' }),
    group({ status: 'CUSTOMER_PENDING' }),
  ])
  const owners = uniq(open.map((g) => g.ownerId))
  const [names, deptHead] = await Promise.all([loadNames({ user: owners }), techHeadText()])
  const pick = (gs: { ownerId: string | null; _count: { _all: number } }[], o: string | null) => gs.find((g) => g.ownerId === o)?._count._all ?? 0
  return {
    week: { monday: dateFieldDay(monday), sunday: dateFieldDay(sunday) },
    rows: owners
      .map((o) => ({
        ownerId: o,
        ownerName: o ? (names.user.get(o) ?? o) : `未指定（${deptHead}）`,
        open: pick(open, o),
        pendingDraw: pick(pendingDraw, o),
        overdue: pick(overdue, o),
        dueThisWeek: pick(dueThisWeek, o),
        customerPending: pick(customer, o),
      }))
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.ownerName.localeCompare(b.ownerName, 'zh-CN')),
  }
}
