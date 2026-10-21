/** 我的待办：附上工单、工件、工序（或发放单）和下一步建议，页面拿到就能展示。 */
import { READY_TO_START } from '../purchases/constants'
import { describeReadyTodos } from '../purchases/purchases'
import { prisma } from '../../utils/prisma'
import { CONFIRM_CHANGE, SIGN_RELEASE } from '../releases/constants'
import { describeReleaseTodos } from '../releases/releases'
import { FlowError } from './errors'
import { ARRANGE_SEND, ARRANGE_START } from './flow'
import { MODE_TEXT, loadNames } from './names'
import { CONFIRM_PLAN_NODE, PLAN_REF } from '../plan/constants'
import { describePlanTodos } from '../plan/plan'
import { todayDay } from './dates'
import { dateFieldDay, shanghaiDay } from '../alerts/rules'
import { workBucket } from '../../../shared/workbench'

const ACTION_TEXT: Record<string, string> = {
  [ARRANGE_SEND]: '安排发出',
  [ARRANGE_START]: '安排开工',
  [SIGN_RELEASE]: '签收',
  [CONFIRM_CHANGE]: '确认变更影响',
  [READY_TO_START]: '可以开工',
  [CONFIRM_PLAN_NODE]: '确认总计划节点',
}

/**
 * visibleWorkOrders：可见工单（undefined = 全部）；不可见工单上的步骤待办不列出。
 * 发放相关的待办（签收、确认变更影响）是发给本人的，不受可见范围限制（接收人看得到发给自己的发放单）。
 * "可以开工"（R10，refType = part）按工件所属工单判断可见；附上工件的第一道工序，页面按工序方式给"登记发出"或"开工"。
 * "确认总计划节点"（R14，refType = planNode）发给部门负责人本人，不受可见范围限制；附上总计划页的跳转地址（plan.link）。
 */
export async function listMyTodos(userId: string, visibleWorkOrders?: string[], now = new Date()) {
  let todos = await prisma.todo.findMany({ where: { ownerId: userId, status: 'OPEN' }, orderBy: { createdAt: 'asc' } })
  if (!todos.length) return []
  const stepIds = todos.filter((t) => t.refType === 'step').map((t) => t.refId)
  let steps = await prisma.routeStep.findMany({ where: { id: { in: stepIds } }, include: { part: true } })
  const ready = await describeReadyTodos(todos.filter((t) => t.refType === 'part').map((t) => t.refId))
  if (visibleWorkOrders) {
    const visible = new Set(visibleWorkOrders)
    const hidden = new Set(steps.filter((s) => !visible.has(s.part.workOrderNumber)).map((s) => s.id))
    steps = steps.filter((s) => !hidden.has(s.id))
    todos = todos.filter((t) => !(t.refType === 'step' && hidden.has(t.refId)))
    todos = todos.filter((t) => t.refType !== 'part' || visible.has(ready.get(t.refId)?.workOrderNumber ?? ''))
  }
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
  const releases = await describeReleaseTodos(todos)
  const plans = await describePlanTodos(todos.filter((t) => t.refType === PLAN_REF).map((t) => t.refId))

  const rows = todos.map((t) => {
    const actionText = ACTION_TEXT[t.action] ?? t.action
    if (t.refType === PLAN_REF) {
      const p = plans.get(t.refId)
      if (!p) return { ...t, actionText, title: actionText, suggestion: '关联的总计划节点已删除', step: null, release: null, plan: null }
      return {
        ...t,
        actionText,
        title: `${actionText}：${p.workOrderNumber} · ${p.name}（${p.deptText}，计划 ${p.planDate}）`,
        suggestion: '项目经理已发布总计划：请确认本部门能按这个日期完成；做不到请退回并写原因',
        step: null,
        release: null,
        plan: { ...p, nodeId: t.refId },
      }
    }
    if (t.refType === 'receipt' || t.refType === 'release') {
      const release = (t.refType === 'receipt' ? releases.byReceipt.get(t.refId) : releases.byRelease.get(t.refId)) ?? null
      if (!release) return { ...t, actionText, title: actionText, suggestion: '关联的发放单已删除', step: null, release: null, plan: null }
      const what = `${release.typeText} ${release.releaseNo}${release.version ? `（${release.version}）` : ''}${release.parts.length ? ` · ${release.parts.join('、')}` : ''}`
      return {
        ...t,
        actionText,
        title: `${actionText}：${what}`,
        suggestion:
          t.action === SIGN_RELEASE
            ? '请核对收到的图纸/文件后签收；版本不对等问题请拒收并写原因'
            : '关联工件已在加工或在外协：请确认变更影响（是否返工、是否通知外协厂），确认后解除未开工工序的"等变更"',
        step: null,
        release: { ...release, receiptId: t.refType === 'receipt' ? t.refId : null },
        plan: null,
      }
    }
    if (t.refType === 'part') {
      const p = ready.get(t.refId)
      if (!p) return { ...t, actionText, title: actionText, suggestion: '关联的工件已删除', step: null, release: null, plan: null }
      const s = p.step
      const verb = s?.mode === 'EXTERNAL_OUTSOURCE' ? '登记发出' : '开工'
      return {
        ...t,
        actionText,
        title: `${actionText}：${p.partName}${s ? ` · ${s.processName}` : ''}`,
        suggestion: `${[p.arrived ? `关键物料已全部到货（${p.arrived} 项）` : '', p.drawings ? `图纸已发放（${p.drawings} 个设计任务）` : ''].filter(Boolean).join('，') || '物料和图纸已齐'}，请安排${s ? `第一道工序${verb}` : '开工'}`,
        step: s,
        release: null,
        plan: null,
      }
    }
    const step = byId.get(t.refId)
    if (!step) return { ...t, actionText, title: actionText, suggestion: '关联对象已删除', step: null, release: null, plan: null }
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
        /** 等变更（设计变更发放后还没确认影响） */
        held: !!step.holdReleaseId,
      },
      release: null,
      plan: null,
    }
  })
  // 工作台卡片流（前端改版第二轮）：所属工单、截止日、按工厂时区的今天分组。电脑端工作台和手机端 /m 共用这里的 dueDay / bucket。
  // 截止日：总计划节点确认取节点计划日；否则待办自带的 dueAt（按工厂时区取日期）；再没有取工序的要求完成日（日期字段）
  const today = todayDay(now)
  return rows.map((t) => {
    const stepDue = t.refType === 'step' ? byId.get(t.refId)?.dueDate : null
    const dueDay = t.plan?.planDate ?? (t.dueAt ? shanghaiDay(t.dueAt) : stepDue ? dateFieldDay(stepDue) : null)
    return {
      ...t,
      workOrderNumber: (t.refType === 'part' ? ready.get(t.refId)?.workOrderNumber : null) ?? t.release?.workOrderNumber ?? t.plan?.workOrderNumber ?? (t.refType === 'step' ? byId.get(t.refId)?.part.workOrderNumber : null) ?? null,
      dueDay,
      bucket: workBucket({ kind: 'todo', dueDay }, today),
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
    // 签收是本人确认收到，转给别人就失去意义了；发错人请发放人作废后重发
    if (todo.action === SIGN_RELEASE) throw new FlowError('签收待办不能转交：不是发给你的请拒收并写原因')
    const user = await tx.qmsUser.findFirst({ where: { id: toUserId, isDeleted: false }, select: { id: true } })
    if (!user) throw new FlowError('转交对象不存在')
    await tx.todo.update({ where: { id: todoId }, data: { status: 'TRANSFERRED', doneAt: new Date() } })
    return tx.todo.create({
      data: { ownerId: toUserId, action: todo.action, refType: todo.refType, refId: todo.refId, dueAt: todo.dueAt },
    })
  })
}
