/** 我的待办：附上工单、工件、工序和下一步建议，页面拿到就能展示。 */
import { prisma } from '../../utils/prisma'
import { FlowError } from './errors'
import { ARRANGE_SEND, ARRANGE_START } from './flow'
import { MODE_TEXT, loadNames } from './names'

const ACTION_TEXT: Record<string, string> = {
  [ARRANGE_SEND]: '安排发出',
  [ARRANGE_START]: '安排开工',
}

export async function listMyTodos(userId: string) {
  const todos = await prisma.todo.findMany({ where: { ownerId: userId, status: 'OPEN' }, orderBy: { createdAt: 'asc' } })
  if (!todos.length) return []
  const stepIds = todos.filter((t) => t.refType === 'step').map((t) => t.refId)
  const steps = await prisma.routeStep.findMany({ where: { id: { in: stepIds } }, include: { part: true } })
  // 上一道（触发待办的那道）
  const prevSteps = !steps.length ? [] : await prisma.routeStep.findMany({
    where: { OR: steps.map((s) => ({ partId: s.partId, seq: { lt: s.seq } })) },
    orderBy: { seq: 'desc' },
  })
  const names = await loadNames({
    process: [...steps, ...prevSteps].map((s) => s.processId),
    supplier: [...steps, ...prevSteps].map((s) => s.supplierId),
  })
  const byId = new Map(steps.map((s) => [s.id, s]))

  return todos.map((t) => {
    const step = byId.get(t.refId)
    const actionText = ACTION_TEXT[t.action] ?? t.action
    if (!step) return { ...t, actionText, title: actionText, suggestion: '关联对象已删除', step: null }
    const processName = names.process.get(step.processId) ?? step.processId
    const prev = prevSteps.find((p) => p.partId === step.partId && p.seq < step.seq)
    const prevName = prev ? (names.process.get(prev.processId) ?? prev.processId) : null
    const supplierName = step.supplierId ? (names.supplier.get(step.supplierId) ?? null) : null
    const suggestion =
      t.action === ARRANGE_SEND
        ? `${prevName ? `${prevName}已返厂，` : ''}请登记发出${supplierName ? `（计划外协厂：${supplierName}）` : ''}，填承诺返回日`
        : `${prevName ? `${prevName}已返厂，` : ''}请安排${MODE_TEXT[step.mode]}开工`
    return {
      ...t,
      actionText,
      title: `${actionText}：${step.part.name} · ${processName}`,
      suggestion,
      step: {
        id: step.id,
        seq: step.seq,
        status: step.status,
        mode: step.mode,
        processName,
        supplierId: step.supplierId,
        supplierName,
        partId: step.partId,
        partName: step.part.name,
        workOrderNumber: step.part.workOrderNumber,
      },
    }
  })
}

/** 转交：原待办标记已转交，给新负责人建一条同样的待办 */
export async function transferTodo(todoId: string, toUserId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM todo WHERE id = ${todoId} FOR UPDATE`
    const todo = await tx.todo.findUnique({ where: { id: todoId } })
    if (!todo) throw new FlowError('待办不存在')
    if (todo.status !== 'OPEN') throw new FlowError('这条待办已处理或已转交')
    if (todo.ownerId === toUserId) throw new FlowError('不能转交给当前负责人')
    const user = await tx.qmsUser.findFirst({ where: { id: toUserId, isDeleted: false }, select: { id: true } })
    if (!user) throw new FlowError('转交对象不存在')
    await tx.todo.update({ where: { id: todoId }, data: { status: 'TRANSFERRED', doneAt: new Date() } })
    return tx.todo.create({
      data: { ownerId: toUserId, action: todo.action, refType: todo.refType, refId: todo.refId, dueAt: todo.dueAt },
    })
  })
}
