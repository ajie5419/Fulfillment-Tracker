/** 总计划命令：各事务、加锁与副作用顺序按原服务整块保留。 */
import { isPlanStartLate, planAdjustmentNeedsReason, isPlanAdjustmentReasonMissing } from '../../../shared/plan-validation'
import { parseDay as parse } from '../../../shared/dates'
import type { PlanDateConflict } from '../../../shared/plan-schedule'
import type { BusinessDept, PlanNode, Prisma } from '@prisma/client'
import type { z } from 'zod'
import type { newNodeBody } from '../../schemas/plan'
import { prisma } from '../../utils/prisma'
import { clearAlertKeys } from '../alerts/clear'
import { dateFieldDay, shanghaiDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import { FlowError, FlowHttpError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { todayDate } from '../purchases/constants'
import { lockProcessRequirementWork, settleProcessRequirementWork } from '../process/requirements'
import { cancelTaskTodos } from './tasks'
import { CONFIRM_PLAN_NODE, PLAN_REF, addDays, childrenOf, planLink, resolvePreds, topoOrder, treeOrder,
  w9ConfirmKey, w9Key, w9SplitKey, waitsOn } from './constants'
import { loadPlans } from './queries'
import { scheduleSnapshot, schedulePreview, SchedulePreviewRollback, type SchedulePreview } from './schedule-preview'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const day = (d: Date) => dateFieldDay(d)

/** 锁住工单的总计划行（没有时建一行草稿），同一工单的总计划操作串行 */
async function lockPlan(tx: Tx, workOrderNumber: string, actorId: string | null) {
  await tx.workOrderPlan.upsert({ where: { workOrderNumber }, update: {}, create: { workOrderNumber, createdBy: actorId } })
  await tx.$queryRaw`SELECT workOrderNumber FROM work_order_plan WHERE workOrderNumber = ${workOrderNumber} FOR UPDATE`
  return tx.workOrderPlan.findUniqueOrThrow({ where: { workOrderNumber } })
}

async function assertWorkOrder(db: Db, workOrderNumber: string) {
  const wo = await db.qmsWorkOrder.findFirst({ where: { workOrderNumber, isDeleted: false }, select: { workOrderNumber: true, deliveryDate: true } })
  if (!wo) throw new FlowError('工单不存在或已删除')
  return wo
}

/** 节点责任部门的负责人（项目部另含"项目部负责人"） */
export async function deptHeads(db: Db, dept: BusinessDept): Promise<string[]> {
  const roles = await db.notifyRole.findMany({
    where: { OR: [{ role: 'DEPT_HEAD', department: dept }, ...(dept === 'PROJECT' ? [{ role: 'PROJECT_DEPT_HEAD' as const }] : [])] },
    select: { userId: true },
  })
  return [...new Set(roles.map((r) => r.userId))]
}

/** 请部门确认：状态改为待确认，作废没处理的旧确认待办，给责任部门负责人发新待办；超时未确认的旧预警清掉（从新待办重新计时） */
async function requestConfirm(tx: Tx, node: Pick<PlanNode, 'id' | 'dept'>): Promise<number> {
  await tx.planNode.update({ where: { id: node.id }, data: { confirmStatus: 'PENDING', confirmedBy: null, confirmedAt: null, rejectReason: null } })
  await tx.todo.updateMany({ where: { refType: PLAN_REF, refId: node.id, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, data: { status: 'CANCELLED', doneAt: new Date() } })
  await clearAlertKeys(tx, [w9ConfirmKey(node.id)])
  const owners = await deptHeads(tx, node.dept)
  if (owners.length) await tx.todo.createMany({ data: owners.map((ownerId) => ({ ownerId, action: CONFIRM_PLAN_NODE, refType: PLAN_REF, refId: node.id })) })
  return owners.length
}

/** 日期、顺序、前置关系改了以后，全工单节点的延误预警按新计划重算（下一轮扫描），先清掉旧的（有前置关系后受影响的不一定在后面） */
async function clearDelayAlerts(tx: Tx, workOrderNumber: string) {
  const all = await tx.planNode.findMany({ where: { workOrderNumber }, select: { id: true } })
  await clearAlertKeys(tx, all.map((n) => w9Key(n.id)))
}

/** 写前置节点：null = 恢复默认（上一个节点），数组 = 自定（可以为空 = 没有前置）。只能选同一工单的其他节点 */
async function saveDeps(tx: Tx, workOrderNumber: string, nodeId: string, preds: string[] | null) {
  await tx.planNodeDep.deleteMany({ where: { nodeId } })
  if (preds == null) {
    await tx.planNode.update({ where: { id: nodeId }, data: { customDeps: false } })
    return
  }
  const ids = [...new Set(preds)]
  if (ids.includes(nodeId)) throw new FlowError('前置节点不能选自己')
  const ok = await tx.planNode.count({ where: { id: { in: ids }, workOrderNumber } })
  if (ok !== ids.length) throw new FlowError('前置节点要是同一个工单总计划里的节点，请刷新后重选')
  await tx.planNode.update({ where: { id: nodeId }, data: { customDeps: true } })
  if (ids.length) await tx.planNodeDep.createMany({ data: ids.map((predId) => ({ nodeId, predId })) })
}

/** 改完以后整份校验：前置关系不能成环（默认的"上一个节点"也算，调顺序也可能成环），在同一事务里失败就整体回滚 */
async function assertNoCycle(tx: Tx, workOrderNumber: string) {
  const rows = await tx.planNode.findMany({
    where: { workOrderNumber },
    orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, customDeps: true, parentId: true },
  })
  const deps = await tx.planNodeDep.findMany({ where: { nodeId: { in: rows.map((n) => n.id) } } })
  const facts = treeOrder(rows.map((n) => ({ id: n.id, parent: n.parentId, preds: n.customDeps ? deps.filter((d) => d.nodeId === n.id).map((d) => d.predId) : null })))
  // 子节点等自己的上级：上级又要等子节点做完，必成环，单独说清楚
  const nameOf = new Map(rows.map((n) => [n.id, n.name]))
  const bad = facts.find((n) => n.parent && n.preds?.includes(n.parent))
  if (bad) throw new FlowError(`"${nameOf.get(bad.id)}"的前置节点里有它的上级"${nameOf.get(bad.parent!)}"：上级要等子节点做完，子节点不能再等上级，请去掉`)
  if (topoOrder(facts.map((n) => n.id), waitsOn(resolvePreds(facts), childrenOf(facts)))) return
  throw new FlowError('前置节点成环了（A 等 B、B 又等 A）：请检查前置节点，或者没自定前置的节点默认等"上一个节点"，调整顺序后可能成环')
}

const startCheck = (start: Date | null | undefined, plan: Date) => {
  if (!start) return
  const startDay = day(start)
  const planDay = day(plan)
  if (isPlanStartLate(startDay, planDay)) throw new FlowError(`计划开始日 ${startDay} 不能晚于计划完成日 ${planDay}`)
}

/** 上级节点校验（只有一层）：同一工单、不是自己、上级自己不是子节点、本节点下面没有子节点。返回上级（null = 一级节点） */
async function checkParent(tx: Tx, workOrderNumber: string, nodeId: string | null, parentId: string | null | undefined) {
  if (!parentId) return null
  if (parentId === nodeId) throw new FlowError('上级节点不能选自己')
  const parent = await tx.planNode.findUnique({ where: { id: parentId }, select: { id: true, workOrderNumber: true, parentId: true, phase: true, planDate: true, name: true } })
  if (!parent || parent.workOrderNumber !== workOrderNumber) throw new FlowError('上级节点要是同一个工单总计划里的节点，请刷新后重选')
  if (parent.parentId) throw new FlowError(`"${parent.name}"本身是子节点：子节点下面不能再挂子节点`)
  if (nodeId && (await tx.planNode.count({ where: { parentId: nodeId } }))) throw new FlowError('这个节点下面有子节点，不能再挂到别的节点下面')
  return parent
}

/**
 * 父任务是汇总行（10-23 zhao：子任务是父任务的细分，跟 MS Project 的摘要任务一样）：
 * 有子节点的节点，计划完成日 = 子节点里最晚的计划完成日，计划开始日 = 子节点里最早的开始日（没填开始日的按完成日算）。
 * 加、改、删、挪子节点和按模板生成后调一次。已发布时汇总行不用部门确认（作废待确认）；不再有子节点的恢复成普通节点，重新请部门确认。
 */
async function rollupParents(tx: Tx, workOrderNumber: string, published: boolean) {
  const nodes = await tx.planNode.findMany({ where: { workOrderNumber }, select: { id: true, dept: true, parentId: true, planDate: true, startDate: true, confirmStatus: true } })
  const kids = new Map<string, typeof nodes>()
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n])
  for (const n of nodes) {
    const cs = kids.get(n.id)
    if (cs?.length) {
      const plan = cs.map((c) => day(c.planDate)).reduce((a, b) => (a > b ? a : b))
      const start = cs.map((c) => day(c.startDate ?? c.planDate)).reduce((a, b) => (a < b ? a : b))
      const data: Prisma.PlanNodeUpdateInput = {}
      if (day(n.planDate) !== plan) data.planDate = parse(plan)
      // 开始日和完成日同一天时不另存开始日（和单独填的节点一样）
      const startVal = start === plan ? null : start
      if ((n.startDate ? day(n.startDate) : null) !== startVal) data.startDate = startVal ? parse(startVal) : null
      if (published && n.confirmStatus) {
        data.confirmStatus = null
        data.confirmedBy = null
        data.confirmedAt = null
        data.rejectReason = null
        await tx.todo.updateMany({ where: { refType: PLAN_REF, refId: n.id, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, data: { status: 'CANCELLED', doneAt: new Date() } })
        await clearAlertKeys(tx, [w9ConfirmKey(n.id)])
      }
      if (Object.keys(data).length) await tx.planNode.update({ where: { id: n.id }, data })
    } else if (published && !n.confirmStatus) {
      // 发布后所有普通节点都有确认状态；没有的 = 以前是汇总行、子节点都挪走了
      await requestConfirm(tx, n)
    }
  }
}

/** 汇总行的日期由子节点算，不能直接改 */
const summaryDateCheck = (hasKids: boolean, changed: boolean, name: string) => {
  if (hasKids && changed) throw new FlowError(`"${name}"下面有子节点，日期由子节点汇总（最早开始～最晚完成），请改子节点的日期`)
}

const needReason = (published: boolean, reason: string | null | undefined, what: string) => {
  if (isPlanAdjustmentReasonMissing(planAdjustmentNeedsReason(published), reason)) throw new FlowError(`总计划已发布，${what}要写调整原因`)
}

/**
 * 按模板生成：模板里的"交期前多少天"按 QMS 交期倒推出各节点计划日；有工期的算出计划开始日，有前置的连上前置节点。
 * 只能在草稿（或还没有总计划）时生成；已有的草稿节点整份替换（挂在它们上面的部门记录变成未挂）。
 */
export async function generateFromTemplate(workOrderNumber: string, templateId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const wo = await assertWorkOrder(tx, workOrderNumber)
    const plan = await lockPlan(tx, workOrderNumber, actorId)
    if (plan.status === 'PUBLISHED') throw new FlowError('总计划已发布，不能再按模板重新生成（可以逐个调整节点）')
    const tpl = await tx.planTemplate.findUnique({ where: { id: templateId }, include: { nodes: { orderBy: { seq: 'asc' } } } })
    if (!tpl) throw new FlowError('模板不存在')
    if (!tpl.nodes.length) throw new FlowError('模板里还没有节点')
    const delivery = day(wo.deliveryDate)
    const replacedNodes = await tx.planNode.findMany({ where: { workOrderNumber }, select: { id: true, requiresProcess: true } })
    // Deleting any node can unlink tasks, so lock every task before FK updates; only excluded nodes change policy.
    const processWork = await lockProcessRequirementWork(tx, replacedNodes.map(n => n.id), replacedNodes.filter(n => !n.requiresProcess).map(n => n.id))
    // 草稿节点下已分解的其他任务随节点一起删，待办作废
    await cancelTaskTodos(tx, (await tx.planTask.findMany({ where: { workOrderNumber }, select: { id: true } })).map((t) => t.id))
    const replaced = await tx.planNode.deleteMany({ where: { workOrderNumber } })
    // 逐个建（要拿到 ID 连前置节点）；模板有工期的算出计划开始日，有前置顺序号的转成节点 ID
    const idOfSeq = new Map<number, string>()
    for (const [i, n] of tpl.nodes.entries()) {
      const plan = addDays(delivery, -n.daysBeforeDelivery)
      const node = await tx.planNode.create({
        data: {
          workOrderNumber,
          seq: i + 1,
          name: n.name,
          dept: n.dept,
          requiresProcess: n.requiresProcess,
          phase: n.phase,
          planDate: parse(plan),
          startDate: n.durationDays && n.durationDays > 0 ? parse(addDays(plan, -(n.durationDays - 1))) : null,
          customDeps: Array.isArray(n.predSeqs),
        },
      })
      idOfSeq.set(n.seq, node.id)
    }
    const deps = tpl.nodes.flatMap((n) =>
      (Array.isArray(n.predSeqs) ? (n.predSeqs as unknown[]) : [])
        .map((seq) => idOfSeq.get(Number(seq)))
        .filter((predId): predId is string => !!predId && predId !== idOfSeq.get(n.seq))
        .map((predId) => ({ nodeId: idOfSeq.get(n.seq)!, predId })),
    )
    if (deps.length) await tx.planNodeDep.createMany({ data: deps, skipDuplicates: true })
    // 子节点挂到上级下面（阶段跟上级）
    const phaseOfSeq = new Map(tpl.nodes.map((n) => [n.seq, n.phase]))
    for (const n of tpl.nodes) {
      const parentId = n.parentSeq != null ? idOfSeq.get(n.parentSeq) : undefined
      if (parentId && parentId !== idOfSeq.get(n.seq)) {
        await tx.planNode.update({ where: { id: idOfSeq.get(n.seq)! }, data: { parentId, phase: phaseOfSeq.get(n.parentSeq!) ?? null } })
      }
    }
    await rollupParents(tx, workOrderNumber, false)
    await assertNoCycle(tx, workOrderNumber)
    await tx.workOrderPlan.update({ where: { workOrderNumber }, data: { templateName: tpl.name } })
    await settleProcessRequirementWork(tx, processWork, actorId, true)
    return { created: tpl.nodes.length, replaced: replaced.count, dateConflicts: (await loadPlans({ workOrderNumbers: [workOrderNumber] }, new Date(), tx)).get(workOrderNumber)?.forecast.dateConflicts ?? [] }
  }, { isolationLevel: 'ReadCommitted' })
}

export type NodeInput = Omit<z.output<typeof newNodeBody>, 'workOrderNumber'>

/** 加节点。发布后加的节点没有基线，要写原因（记调整记录），并请责任部门确认 */
export async function createNode(workOrderNumber: string, input: NodeInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await assertWorkOrder(tx, workOrderNumber)
    const plan = await lockPlan(tx, workOrderNumber, actorId)
    const published = plan.status === 'PUBLISHED'
    needReason(published, input.reason, '加节点')
    const seq = input.seq ?? ((await tx.planNode.aggregate({ where: { workOrderNumber }, _max: { seq: true } }))._max.seq ?? 0) + 1
    startCheck(input.startDate, input.planDate)
    const parent = await checkParent(tx, workOrderNumber, null, input.parentId)
    const node = await tx.planNode.create({
      data: {
        workOrderNumber,
        seq,
        name: input.name.trim(),
        dept: input.dept,
        requiresProcess: input.requiresProcess ?? true,
        parentId: parent?.id ?? null,
        // 子节点的阶段跟上级
        phase: parent ? parent.phase : input.phase?.trim() || null,
        startDate: input.startDate ?? null,
        planDate: input.planDate,
        note: input.note?.trim() || null,
      },
    })
    if (input.preds !== undefined) await saveDeps(tx, workOrderNumber, node.id, input.preds)
    await assertNoCycle(tx, workOrderNumber)
    if (published) {
      await tx.planChangeLog.create({ data: { workOrderNumber, nodeId: node.id, nodeName: node.name, kind: 'ADD', newDate: node.planDate, reason: input.reason!.trim(), actorId } })
      await requestConfirm(tx, node)
      await clearDelayAlerts(tx, workOrderNumber)
    }
    if (parent) await rollupParents(tx, workOrderNumber, published)
    return { id: node.id, dateConflicts: (await loadPlans({ workOrderNumbers: [workOrderNumber] }, new Date(), tx)).get(workOrderNumber)?.forecast.dateConflicts ?? [] }
  })
}

/** Published date changes require a reason and department reconfirmation.
 * Linked-date previews run the same validations as saves and roll back atomically.
 */
export async function updateNode(id: string, input: Partial<NodeInput> & { linkedDates?: boolean; preview?: boolean; previewToken?: string }, actorId: string): Promise<{ id: string; reconfirm: boolean; preview?: SchedulePreview; dateConflicts?: PlanDateConflict[] }> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.planNode.findUnique({ where: { id }, select: { workOrderNumber: true } })
    if (!cur) throw new FlowError('总计划节点不存在')
    const plan = await lockPlan(tx, cur.workOrderNumber, actorId)
    const old = await tx.planNode.findUnique({ where: { id } })
    if (!old) throw new FlowError('总计划节点不存在')
    const published = plan.status === 'PUBLISHED'
    const dateChanged = input.planDate !== undefined && day(input.planDate) !== day(old.planDate)
    const deptChanged = input.dept !== undefined && input.dept !== old.dept
    const processChanged = input.requiresProcess !== undefined && input.requiresProcess !== old.requiresProcess
    const startChanged = input.startDate !== undefined && (input.startDate ? day(input.startDate) : null) !== (old.startDate ? day(old.startDate) : null)
    const linked = input.linkedDates && (dateChanged || startChanged)
    if (input.previewToken && !linked) throw new FlowError('计划日期已变化，请重新打开节点后调整')
    if (input.preview && !linked) throw new FlowError('日期未变化，请关闭预览后重新保存')
    const before = linked ? await scheduleSnapshot(tx, old.workOrderNumber) : null
    const hasKids = (await tx.planNode.count({ where: { parentId: id } })) > 0
    summaryDateCheck(hasKids, dateChanged || startChanged, old.name)
    if (planAdjustmentNeedsReason(published, day(old.planDate), input.planDate ? day(input.planDate) : undefined, old.startDate ? day(old.startDate) : null, input.startDate === undefined ? undefined : input.startDate ? day(input.startDate) : null)) needReason(published, input.reason, '改计划日期')
    const data: Prisma.PlanNodeUpdateInput = {}
    if (input.name !== undefined) data.name = input.name.trim()
    if (input.dept !== undefined) data.dept = input.dept
    if (input.requiresProcess !== undefined) data.requiresProcess = input.requiresProcess
    if (input.planDate !== undefined) data.planDate = input.planDate
    if (input.seq != null) data.seq = input.seq
    if (input.note !== undefined) data.note = input.note?.trim() || null
    if (input.phase !== undefined) data.phase = input.phase?.trim() || null
    if (input.startDate !== undefined) data.startDate = input.startDate
    startCheck(input.startDate !== undefined ? input.startDate : old.startDate, input.planDate ?? old.planDate)
    // 上级节点：改了要校验；子节点的阶段跟上级
    const newParentId = input.parentId !== undefined ? input.parentId || null : old.parentId
    const parentChanged = newParentId !== old.parentId
    const parent = parentChanged
      ? await checkParent(tx, old.workOrderNumber, id, newParentId)
      : old.parentId
        ? await tx.planNode.findUnique({ where: { id: old.parentId }, select: { phase: true } })
        : null
    if (parentChanged) data.parent = newParentId ? { connect: { id: newParentId } } : { disconnect: true }
    if (parent) data.phase = parent.phase
    const processWork = processChanged ? await lockProcessRequirementWork(tx, [id]) : null
    const node = await tx.planNode.update({ where: { id }, data })
    if (!node.parentId && node.phase !== old.phase) await tx.planNode.updateMany({ where: { parentId: id }, data: { phase: node.phase } })
    // 前置节点：页面每次保存都会带上，只有真的变了才重写（避免无谓地清掉、重发延误预警）
    let depsChanged = false
    if (input.preds !== undefined) {
      const oldPreds = old.customDeps ? (await tx.planNodeDep.findMany({ where: { nodeId: id }, select: { predId: true } })).map((d) => d.predId).sort() : null
      const newPreds = input.preds == null ? null : [...new Set(input.preds)].sort()
      depsChanged = JSON.stringify(oldPreds) !== JSON.stringify(newPreds)
      if (depsChanged) await saveDeps(tx, node.workOrderNumber, id, input.preds)
    }
    const seqChanged = input.seq != null && input.seq !== old.seq
    if (depsChanged || seqChanged || parentChanged) await assertNoCycle(tx, node.workOrderNumber)
    const adjustmentReason = input.reason?.trim() ?? ''
    if (before) {
      if (depsChanged || seqChanged || parentChanged) throw new FlowError('联动日期时请先单独保存前置、顺序或上级关系，再调整日期')
      const after = await scheduleSnapshot(tx, node.workOrderNumber)
      const { preview: _preview, previewToken: _token, ...intent } = input
      const preview = schedulePreview(before, after.nodes, id, intent)
      if (input.preview) throw new SchedulePreviewRollback(preview)
      if (input.previewToken !== preview.token) throw new FlowError('计划或执行情况已变化，请重新预览联动日期后保存')
      const linkedChanges = preview.changes.filter((c) => c.id !== id)
      for (const c of linkedChanges) {
        const updated = await tx.planNode.update({ where: { id: c.id }, data: { startDate: c.start ? parse(c.start) : null, planDate: parse(c.finish) } })
        if (published) {
          if (c.oldFinish !== c.finish) await tx.planChangeLog.create({ data: { workOrderNumber: node.workOrderNumber, nodeId: c.id, nodeName: c.name, kind: 'DATE', oldDate: parse(c.oldFinish), newDate: parse(c.finish), reason: adjustmentReason, actorId } })
          if (c.oldStart !== c.start) await tx.planChangeLog.create({ data: { workOrderNumber: node.workOrderNumber, nodeId: c.id, nodeName: c.name, kind: 'START', oldDate: c.oldStart ? parse(c.oldStart) : null, newDate: c.start ? parse(c.start) : null, reason: adjustmentReason, actorId } })
          if (!after.nodes.some((n) => n.parent === c.id)) await requestConfirm(tx, updated)
        }
      }
    }
    if (published && dateChanged) {
      await tx.planChangeLog.create({
        data: { workOrderNumber: node.workOrderNumber, nodeId: id, nodeName: node.name, kind: 'DATE', oldDate: old.planDate, newDate: node.planDate, reason: input.reason!.trim(), actorId },
      })
    }
    if (published && startChanged) await tx.planChangeLog.create({ data: { workOrderNumber: node.workOrderNumber, nodeId: id, nodeName: node.name, kind: 'START', oldDate: old.startDate, newDate: node.startDate, reason: adjustmentReason, actorId } })
    let reconfirm = false
    if (published && !hasKids && (dateChanged || startChanged || deptChanged)) {
      await requestConfirm(tx, node)
      reconfirm = true
    }
    // 子节点的日期、上级变了：重算汇总行（原上级、新上级）
    if (!before && (dateChanged || startChanged || parentChanged)) await rollupParents(tx, node.workOrderNumber, published)
    if (dateChanged || seqChanged || depsChanged || startChanged || parentChanged) await clearDelayAlerts(tx, node.workOrderNumber)
    if (processWork) {
      await settleProcessRequirementWork(tx, processWork, actorId, node.requiresProcess)
      await tx.planChangeLog.create({ data: { workOrderNumber: node.workOrderNumber, nodeId: id, nodeName: node.name, kind: 'PROCESS', reason: node.requiresProcess ? '启用工艺处理' : '取消工艺处理', actorId } })
    }
    return { id, reconfirm, dateConflicts: (await loadPlans({ workOrderNumbers: [node.workOrderNumber] }, new Date(), tx)).get(node.workOrderNumber)?.forecast.dateConflicts ?? [] }
  }, { isolationLevel: 'ReadCommitted' }).catch((error: unknown) => {
    if (error instanceof SchedulePreviewRollback) return { id, reconfirm: false, preview: error.preview }
    throw error
  })
}

/** 删节点：挂在上面的部门记录变成未挂（外键置空），其他任务一起删。发布后删要写原因（记调整记录） */
export async function deleteNode(id: string, reason: string | null | undefined, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.planNode.findUnique({ where: { id }, select: { workOrderNumber: true } })
    if (!cur) throw new FlowError('总计划节点不存在')
    const plan = await lockPlan(tx, cur.workOrderNumber, actorId)
    const node = await tx.planNode.findUnique({ where: { id } })
    if (!node) throw new FlowError('总计划节点不存在')
    const published = plan.status === 'PUBLISHED'
    const kids = await tx.planNode.count({ where: { parentId: id } })
    if (kids) throw new FlowError(`"${node.name}"下面还有 ${kids} 个子节点：请先删除子节点，或把它们改成一级节点`)
    needReason(published, reason, '删节点')
    // FK unlinking follows the same lock order even when the effective policy stays enabled.
    const processWork = await lockProcessRequirementWork(tx, [id], node.requiresProcess ? [] : [id])
    if (published) {
      await tx.planChangeLog.create({ data: { workOrderNumber: node.workOrderNumber, nodeId: id, nodeName: node.name, kind: 'DELETE', oldDate: node.planDate, reason: reason!.trim(), actorId } })
    }
    await tx.todo.updateMany({ where: { refType: PLAN_REF, refId: id, status: 'OPEN' }, data: { status: 'CANCELLED', doneAt: new Date() } })
    // 节点下的其他任务随节点一起删（外键级联），待办作废
    await cancelTaskTodos(tx, (await tx.planTask.findMany({ where: { planNodeId: id }, select: { id: true } })).map((t) => t.id))
    await clearAlertKeys(tx, [w9Key(id), w9ConfirmKey(id), w9SplitKey(id)])
    await tx.planNode.delete({ where: { id } }) // 前置关系两头都级联删除
    await settleProcessRequirementWork(tx, processWork, actorId, true)
    if (node.parentId) await rollupParents(tx, node.workOrderNumber, published)
    // 删掉后，紧跟着它、默认等"上一个节点"的节点改等更前面的节点，可能成环：成环就整笔回滚
    await assertNoCycle(tx, node.workOrderNumber)
    await clearDelayAlerts(tx, node.workOrderNumber)
    return { ok: true }
  }, { isolationLevel: 'ReadCommitted' })
}

/**
 * 发布：当时的计划日记为基线；每个节点请责任部门负责人确认（发"确认总计划节点"待办）。发布立即生效，不等确认。
 * 返回没有负责人的部门（这些节点没人收到确认待办，设置页"人员与角色"里补上部门负责人后改一下节点即可重新发出）。
 */
export async function publishPlan(workOrderNumber: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await assertWorkOrder(tx, workOrderNumber)
    const plan = await lockPlan(tx, workOrderNumber, actorId)
    if (plan.status === 'PUBLISHED') throw new FlowError('总计划已经发布过了')
    const nodes = await tx.planNode.findMany({ where: { workOrderNumber }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }] })
    if (!nodes.length) throw new FlowError('总计划还没有节点，请先按模板生成或添加节点')
    const current = (await loadPlans({ workOrderNumbers: [workOrderNumber] }, new Date(), tx)).get(workOrderNumber)
    if (!current) throw new FlowError('总计划读取失败，不能发布')
    const dateConflicts = current.forecast.dateConflicts.filter((conflict) => conflict.blocksPublish)
    if (dateConflicts.length) throw new FlowHttpError(`总计划日期校验未通过：${dateConflicts.map((conflict) => conflict.message).join('；')}`, 409, undefined, { dateConflicts })
    const now = new Date()
    let todos = 0
    const noHead = new Set<string>()
    const parents = new Set(nodes.map((n) => n.parentId).filter(Boolean))
    for (const n of nodes) {
      await tx.planNode.update({ where: { id: n.id }, data: { baselineDate: n.planDate } })
      // 汇总行（有子节点）不用部门确认，确认落在子节点上
      if (parents.has(n.id)) continue
      const sent = await requestConfirm(tx, n)
      todos += sent
      if (!sent) noHead.add(BUSINESS_DEPT_NAME[n.dept])
    }
    await tx.workOrderPlan.update({ where: { workOrderNumber }, data: { status: 'PUBLISHED', publishedAt: now, publishedBy: actorId } })
    return { nodes: nodes.length, todos, deptsWithoutHead: [...noHead] }
  })
}

async function lockNode(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM plan_node WHERE id = ${id} FOR UPDATE`
  if (!rows.length) throw new FlowError('总计划节点不存在')
  const node = await tx.planNode.findUniqueOrThrow({ where: { id } })
  const plan = await tx.workOrderPlan.findUnique({ where: { workOrderNumber: node.workOrderNumber }, select: { status: true } })
  return { node, published: plan?.status === 'PUBLISHED' }
}

const closeConfirmTodos = (tx: Tx, id: string, now: Date) =>
  tx.todo.updateMany({ where: { refType: PLAN_REF, refId: id, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, data: { status: 'DONE', doneAt: now } })

/** 部门确认节点（待确认、已退回的都可以确认） */
export async function confirmNode(id: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const { node, published } = await lockNode(tx, id)
    if (!published || !node.confirmStatus) throw new FlowError('总计划还没有发布，不用接收')
    if (node.confirmStatus === 'CONFIRMED') throw new FlowError('这个节点已经接收过了，请刷新')
    const now = new Date()
    await tx.planNode.update({ where: { id }, data: { confirmStatus: 'CONFIRMED', confirmedBy: actorId, confirmedAt: now, rejectReason: null } })
    await closeConfirmTodos(tx, id, now)
    await clearAlertKeys(tx, [w9ConfirmKey(id)])
    return { id, confirmStatus: 'CONFIRMED' as const }
  })
}

/** 部门退回节点（写原因）：提醒项目经理（没有项目经理时提醒项目部负责人）。项目经理调整日期后自动重新请确认 */
export async function rejectNode(id: string, reason: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const { node, published } = await lockNode(tx, id)
    if (!published || !node.confirmStatus) throw new FlowError('总计划还没有发布，不用接收')
    if (node.confirmStatus !== 'PENDING') throw new FlowError(node.confirmStatus === 'REJECTED' ? '这个节点已经退回了，请刷新' : '这个节点已经接收了')
    const now = new Date()
    await tx.planNode.update({ where: { id }, data: { confirmStatus: 'REJECTED', confirmedBy: actorId, confirmedAt: now, rejectReason: reason.trim() } })
    await closeConfirmTodos(tx, id, now)
    await clearAlertKeys(tx, [w9ConfirmKey(id)])
    const pm = (await tx.workOrderExt.findUnique({ where: { workOrderNumber: node.workOrderNumber }, select: { projectManagerId: true } }))?.projectManagerId
    const to = pm ? [pm] : (await tx.notifyRole.findMany({ where: { role: 'PROJECT_DEPT_HEAD' }, select: { userId: true } })).map((r) => r.userId)
    const who = (await loadNames({ user: [actorId] })).user.get(actorId) ?? actorId
    const title = `【退回】${who}（${BUSINESS_DEPT_NAME[node.dept]}）退回了总计划节点"${node.name}"（计划 ${day(node.planDate)}）：${reason.trim()}（${node.workOrderNumber}）`
    if (to.length) {
      await tx.reminder.createMany({
        data: [...new Set(to)].map((userId) => ({
          userId,
          kind: 'PLAN',
          level: 'YELLOW' as const,
          title: title.length > 190 ? `${title.slice(0, 189)}…` : title,
          link: planLink(node.workOrderNumber, id),
          dedupeKey: `PLAN_REJECT:${id}:${now.getTime()}:${userId}`,
        })),
        skipDuplicates: true,
      })
    }
    return { id, confirmStatus: 'REJECTED' as const, notified: to.length }
  })
}

/** 手动标记节点完成（完成日默认今天、不能晚于今天） */
export async function completeNode(id: string, date: Date | null | undefined, actorId: string, now = new Date()) {
  const d = date ?? todayDate(now)
  if (day(d) > shanghaiDay(now)) throw new FlowError('完成日期不能晚于今天')
  return prisma.$transaction(async (tx) => {
    // 和创建 / 调整节点一致：计划行 → 节点行。定位读只取工单号，不能用它判断完成条件。
    const target = await tx.planNode.findUnique({ where: { id }, select: { workOrderNumber: true } })
    if (!target) throw new FlowError('总计划节点不存在')
    await lockPlan(tx, target.workOrderNumber, actorId)
    const { node } = await lockNode(tx, id)
    if (node.manualDoneAt) throw new FlowError('这个节点已经标记完成了，请刷新')
    // 本事务显式使用 READ COMMITTED：锁后重读子节点和预测来源，不能沿用定位读的 RR 快照。
    const kids = await tx.planNode.findMany({ where: { parentId: id }, select: { id: true, name: true } })
    if (kids.length) {
      const est = (await loadPlans({ workOrderNumbers: [node.workOrderNumber] }, now, tx)).get(node.workOrderNumber)?.forecast.nodes ?? []
      const done = new Set(est.filter((e) => e.done).map((e) => e.id))
      const undone = kids.filter((k) => !done.has(k.id))
      if (undone.length) throw new FlowError(`还有子节点没完成：${undone.map((k) => k.name).join('、')}（子节点都完成后会自动完成）`)
      throw new FlowError('有子节点的节点随子节点自动完成，无需手动标记')
    }
    const data = (await loadPlans({ workOrderNumbers: [node.workOrderNumber] }, now, tx)).get(node.workOrderNumber)
    // Cancelled tasks no longer own completion, matching forecasts and the UI.
    if (data?.tasks.some((t) => t.nodeId === id && !t.facts.excluded)) throw new FlowError('已分解的节点随任务自动完成，无需手动标记')
    await tx.planNode.update({ where: { id }, data: { actualDate: d, manualDoneBy: actorId, manualDoneAt: now } })
    await clearAlertKeys(tx, [w9Key(id), w9SplitKey(id)])
    return { id, actualDate: day(d) }
  }, { isolationLevel: 'ReadCommitted' })
}

/** 撤销手动完成（自动完成的不能撤销：挂靠任务还都是完成状态） */
export async function undoCompleteNode(id: string) {
  return prisma.$transaction(async (tx) => {
    const { node } = await lockNode(tx, id)
    if (!node.manualDoneAt) throw new FlowError('这个节点没有手动标记完成（挂靠任务全部完成时自动完成的不能撤销）')
    await tx.planNode.update({ where: { id }, data: { actualDate: null, manualDoneBy: null, manualDoneAt: null } })
    return { id }
  })
}
