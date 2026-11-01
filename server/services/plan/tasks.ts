/**
 * 部门计划二次分解（zhao 10-22 确认）：总计划发布后，各部门在节点下分解部门任务。
 *   设计任务 / 采购行 / 工序 / 装配节点照旧用原来的记录（挂节点），这里只管它们覆盖不到的"其他任务"（plan_task）和"把工序挂到节点"。
 *   只分一级；不需要项目部审核（日期晚于节点照现有规则只提示、总计划里标红）。
 *   其他任务建好给负责人发"完成部门任务"待办（截止日 = 计划完成日）；改负责人换人发，改日期改截止日，完成关待办，撤销完成重发，删掉作废待办。
 *   预计日、顺延、节点自动完成、W9 都由总计划的现算逻辑（constants.ts）统一处理，这里不另算。
 * 权限在接口层判断（planTask；标完成另放行任务负责人）。
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { dateFieldDay, shanghaiDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import { FlowError } from '../flow/errors'
import { todayDate } from '../purchases/constants'
import { DO_PLAN_TASK, PLAN_TASK_REF, lateWarning, planLink, w9SplitKey } from './constants'
import { clearAlertKeys } from '../alerts/clear'

type Tx = Prisma.TransactionClient

export interface PlanTaskInput {
  name: string
  ownerId: string
  planDate: Date
  note?: string | null
}

async function assertUser(tx: Tx, id: string) {
  const u = await tx.qmsUser.findFirst({ where: { id, isDeleted: false }, select: { id: true } })
  if (!u) throw new FlowError('负责人不存在')
}

async function lockTask(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM plan_task WHERE id = ${id} FOR UPDATE`
  if (!rows.length) throw new FlowError('部门任务不存在')
  return tx.planTask.findUniqueOrThrow({ where: { id }, include: { planNode: { select: { name: true, planDate: true } } } })
}

const openTodos = (id: string) => ({ refType: PLAN_TASK_REF, refId: id, action: DO_PLAN_TASK, status: 'OPEN' as const })

/** 作废这些任务没处理的待办（删任务、删节点、重新生成总计划时用） */
export async function cancelTaskTodos(tx: Tx, taskIds: string[]) {
  if (!taskIds.length) return
  await tx.todo.updateMany({ where: { refType: PLAN_TASK_REF, refId: { in: taskIds }, status: 'OPEN' }, data: { status: 'CANCELLED', doneAt: new Date() } })
}

const warn = (planDate: Date, node: { name: string; planDate: Date }) =>
  lateWarning('计划完成日', dateFieldDay(planDate), { name: node.name, planDay: dateFieldDay(node.planDate) })

/** 在节点下建其他任务：给负责人发待办；计划完成日晚于节点计划日只提示 */
export async function createPlanTask(nodeId: string, input: PlanTaskInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const node = await tx.planNode.findUnique({ where: { id: nodeId }, select: { id: true, workOrderNumber: true, name: true, planDate: true } })
    if (!node) throw new FlowError('总计划节点不存在')
    await assertUser(tx, input.ownerId)
    const task = await tx.planTask.create({
      data: {
        workOrderNumber: node.workOrderNumber,
        planNodeId: node.id,
        name: input.name.trim(),
        ownerId: input.ownerId,
        planDate: input.planDate,
        note: input.note?.trim() || null,
        createdBy: actorId,
      },
    })
    await tx.todo.create({ data: { ownerId: task.ownerId, action: DO_PLAN_TASK, refType: PLAN_TASK_REF, refId: task.id, dueAt: task.planDate } })
    // 节点有了部门任务，"未分解"提醒消失（扫描也会清，这里先清掉免得页面还挂着）
    await clearAlertKeys(tx, [w9SplitKey(node.id)])
    return { id: task.id, planWarning: warn(task.planDate, node) }
  })
}

/** 改其他任务（名称、负责人、计划完成日、备注）。没完成的：换负责人换人发待办，改日期改待办截止日 */
export async function updatePlanTask(id: string, input: Partial<PlanTaskInput>) {
  return prisma.$transaction(async (tx) => {
    const old = await lockTask(tx, id)
    if (input.ownerId !== undefined && input.ownerId !== old.ownerId) await assertUser(tx, input.ownerId)
    const data: Prisma.PlanTaskUpdateInput = {}
    if (input.name !== undefined) data.name = input.name.trim()
    if (input.ownerId !== undefined) data.ownerId = input.ownerId
    if (input.planDate !== undefined) data.planDate = input.planDate
    if (input.note !== undefined) data.note = input.note?.trim() || null
    const task = await tx.planTask.update({ where: { id }, data })
    if (!task.doneDate) {
      if (task.ownerId !== old.ownerId) {
        await cancelTaskTodos(tx, [id])
        await tx.todo.create({ data: { ownerId: task.ownerId, action: DO_PLAN_TASK, refType: PLAN_TASK_REF, refId: id, dueAt: task.planDate } })
      } else if (+task.planDate !== +old.planDate) {
        await tx.todo.updateMany({ where: openTodos(id), data: { dueAt: task.planDate } })
      }
    }
    return { id, planWarning: warn(task.planDate, old.planNode) }
  })
}

export async function deletePlanTask(id: string) {
  return prisma.$transaction(async (tx) => {
    await lockTask(tx, id)
    await cancelTaskTodos(tx, [id])
    await tx.planTask.delete({ where: { id } })
    return { ok: true }
  })
}

/** 标完成（完成日默认今天、不能晚于今天）：关掉待办 */
export async function completePlanTask(id: string, date: Date | null | undefined, actorId: string, now = new Date()) {
  const d = date ?? todayDate(now)
  if (dateFieldDay(d) > shanghaiDay(now)) throw new FlowError('完成日期不能晚于今天')
  return prisma.$transaction(async (tx) => {
    const task = await lockTask(tx, id)
    if (task.doneDate) throw new FlowError('这个任务已经完成了，请刷新')
    await tx.planTask.update({ where: { id }, data: { doneDate: d, doneBy: actorId } })
    await tx.todo.updateMany({ where: openTodos(id), data: { status: 'DONE', doneAt: now } })
    return { id, doneDate: dateFieldDay(d) }
  })
}

/** 撤销完成：重新给负责人发待办 */
export async function undoCompletePlanTask(id: string) {
  return prisma.$transaction(async (tx) => {
    const task = await lockTask(tx, id)
    if (!task.doneDate) throw new FlowError('这个任务还没有完成')
    await tx.planTask.update({ where: { id }, data: { doneDate: null, doneBy: null } })
    await tx.todo.create({ data: { ownerId: task.ownerId, action: DO_PLAN_TASK, refType: PLAN_TASK_REF, refId: id, dueAt: task.planDate } })
    return { id }
  })
}

/** 待办转交时任务负责人跟着换（flow/todos.ts transferTodo 调用） */
export async function transferPlanTaskOwner(tx: Tx, id: string, toUserId: string) {
  await tx.planTask.updateMany({ where: { id }, data: { ownerId: toUserId } })
}

/**
 * 把工序挂到节点（节点"分解"里的"挂工序"）：只能挂同一工单的工序；已挂别的节点的改挂到这个节点。
 * 工序日期晚于节点照样挂（总计划里标红）。
 */
export async function linkStepsToNode(nodeId: string, stepIds: string[]) {
  return prisma.$transaction(async (tx) => {
    const node = await tx.planNode.findUnique({ where: { id: nodeId }, select: { id: true, workOrderNumber: true } })
    if (!node) throw new FlowError('总计划节点不存在')
    const ids = [...new Set(stepIds)]
    const steps = await tx.routeStep.findMany({ where: { id: { in: ids } }, select: { id: true, part: { select: { workOrderNumber: true } } } })
    if (steps.length !== ids.length || steps.some((s) => s.part.workOrderNumber !== node.workOrderNumber)) throw new FlowError('有工序不存在或不属于该工单')
    const r = await tx.routeStep.updateMany({ where: { id: { in: ids } }, data: { planNodeId: node.id } })
    await clearAlertKeys(tx, [w9SplitKey(node.id)])
    return { linked: r.count }
  })
}

/** 同一工单的工序（"挂工序"弹窗用）：工件、工序名称、方式、要求完成日、当前挂的节点、状态 */
export async function stepOptions(workOrderNumber: string) {
  const steps = await prisma.routeStep.findMany({
    where: { part: { workOrderNumber } },
    include: { part: { select: { name: true, drawingNo: true } }, planNode: { select: { seq: true, name: true } } },
    orderBy: [{ part: { name: 'asc' } }, { seq: 'asc' }],
  })
  const procs = await prisma.qmsProcess.findMany({ where: { id: { in: [...new Set(steps.map((s) => s.processId))] } }, select: { id: true, name: true } })
  const pname = new Map(procs.map((p) => [p.id, p.name]))
  return steps.map((s) => ({
    id: s.id,
    partName: s.part.drawingNo ? `${s.part.name}（${s.part.drawingNo}）` : s.part.name,
    processName: pname.get(s.processId) ?? s.processId,
    mode: s.mode,
    status: s.status,
    dueDate: s.dueDate ? dateFieldDay(s.dueDate) : null,
    planNodeId: s.planNodeId,
    planNodeName: s.planNode ? `${s.planNode.seq}. ${s.planNode.name}` : null,
  }))
}

/**
 * "完成部门任务"待办的说明：任务、节点、工单、计划完成日；任务已删的返回不到。
 * 负责人看不到该工单（visibleWorkOrders 不含）时不给"查看"链接（总计划页会 403），仍可直接标完成。
 */
export async function describePlanTaskTodos(ids: string[], visibleWorkOrders?: string[]) {
  if (!ids.length) return new Map<string, { id: string; workOrderNumber: string; name: string; nodeName: string; deptText: string; planDate: string; link: string | null }>()
  const visible = visibleWorkOrders ? new Set(visibleWorkOrders) : null
  const tasks = await prisma.planTask.findMany({ where: { id: { in: ids } }, include: { planNode: { select: { name: true, dept: true } } } })
  return new Map(
    tasks.map((t) => [
      t.id,
      {
        id: t.id,
        workOrderNumber: t.workOrderNumber,
        name: t.name,
        nodeName: t.planNode.name,
        deptText: BUSINESS_DEPT_NAME[t.planNode.dept],
        planDate: dateFieldDay(t.planDate),
        link: !visible || visible.has(t.workOrderNumber) ? planLink(t.workOrderNumber, t.planNodeId) : null,
      },
    ]),
  )
}
