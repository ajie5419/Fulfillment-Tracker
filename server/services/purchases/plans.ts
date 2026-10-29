import type { Prisma } from '@prisma/client'
import type { z } from 'zod'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { resolvePlanNode } from '../plan/links'
import { createLine, lockParts, purchaseTx } from './purchases'
import { PURCHASE_DEPT } from './constants'
import { PURCHASE_PLAN_ISSUED, purchasePlanEditable, purchasePlanProgress, purchasePlanTransition } from '../../../shared/purchase-plans'
import type { newPlanBody, planHeadBody, planItemBody } from '../../schemas/purchase-plans'

type Tx = Prisma.TransactionClient
const itemInclude = { convertedLine: { select: { id: true, status: true } }, part: { select: { id: true, name: true, drawingNo: true } } } as const
const include = { items: { include: itemInclude, orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] }, planNode: { select: { id: true, name: true, seq: true } } } satisfies Prisma.PurchasePlanInclude

async function lockPlan(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM purchase_plan WHERE id = ${id} FOR UPDATE`
  const plan = await tx.purchasePlan.findUnique({ where: { id } })
  if (!plan) throw new FlowError('采购计划不存在')
  return plan
}
function editable(status: Parameters<typeof purchasePlanEditable>[0]) {
  if (!purchasePlanEditable(status)) throw new FlowError('已下发的采购计划不可编辑，请先撤回')
}
export async function workOrderOfPurchasePlan(id: string) {
  const plan = await prisma.purchasePlan.findUnique({ where: { id }, select: { workOrderNumber: true } })
  if (!plan) throw new FlowError('采购计划不存在')
  return plan.workOrderNumber
}
export async function createPurchasePlan(input: z.output<typeof newPlanBody>, actorId: string) {
  return purchaseTx(async tx => {
    if (!await tx.qmsWorkOrder.findFirst({ where: { workOrderNumber: input.workOrderNumber, isDeleted: false } })) throw new FlowError('工单不存在或已删除')
    const link = await resolvePlanNode(tx, input.workOrderNumber, input.planNodeId, { creating: true })
    return tx.purchasePlan.create({ data: { ...input, planNodeId: link.value ?? null, createdBy: actorId } })
  })
}
export async function updatePurchasePlan(id: string, input: z.output<typeof planHeadBody>) {
  return purchaseTx(async tx => {
    const plan = await lockPlan(tx, id)
    editable(plan.status)
    const link = await resolvePlanNode(tx, plan.workOrderNumber, input.planNodeId, { creating: false, oldNodeId: plan.planNodeId })
    return tx.purchasePlan.update({ where: { id }, data: { ...input, planNodeId: link.value } })
  })
}
export async function savePurchasePlanItem(planId: string, id: string | null, input: z.output<typeof planItemBody>) {
  return purchaseTx(async tx => {
    // 与 createLine 一样，先锁工件，后锁计划头，所有明细写入由计划头串行化。
    await lockParts(tx, [input.partId])
    const plan = await lockPlan(tx, planId)
    editable(plan.status)
    const old = id ? await tx.purchasePlanItem.findFirst({ where: { id, planId } }) : null
    if (id && !old) throw new FlowError('计划明细不存在')
    if (old?.convertedLineId) throw new FlowError('已转采购行的明细不可修改')
    if (input.partId && !await tx.part.findFirst({ where: { id: input.partId, workOrderNumber: plan.workOrderNumber } })) throw new FlowError('工件不存在或不属于该工单')
    const data = { ...input, needDate: input.needDate ?? null, partId: input.partId || null }
    return id ? tx.purchasePlanItem.update({ where: { id }, data }) : tx.purchasePlanItem.create({ data: { ...data, planId } })
  })
}
export async function deletePurchasePlanItem(planId: string, id: string) {
  return purchaseTx(async tx => {
    editable((await lockPlan(tx, planId)).status)
    const item = await tx.purchasePlanItem.findFirst({ where: { id, planId } })
    if (!item) throw new FlowError('计划明细不存在')
    if (item.convertedLineId) throw new FlowError('已转采购行的明细不可删除')
    await tx.purchasePlanItem.delete({ where: { id } })
    return { ok: true }
  })
}
export async function changePurchasePlanStatus(id: string, action: 'issue' | 'withdraw', actorId: string) {
  return purchaseTx(async tx => {
    const plan = await lockPlan(tx, id)
    const status = purchasePlanTransition(plan.status, action)
    if (!status) throw new FlowError(action === 'issue' ? '计划已下发，请刷新' : '只有已下发的计划可以撤回')
    const now = new Date()
    if (action === 'issue') {
      const items = await tx.purchasePlanItem.findMany({ where: { planId: id } })
      if (!items.length) throw new FlowError('请先添加计划明细')
      if (items.some(i => !i.needDate || Number(i.quantity) <= 0)) throw new FlowError('请补齐每行需求日和大于 0 的数量再下发')
      // BOM 自动草稿可以暂不挂节点，下发时执行采购行的新建口径。
      await resolvePlanNode(tx, plan.workOrderNumber, plan.planNodeId, { creating: true })
      let notified = 0
      if (items.some(i => i.convertedLineId === null)) {
        const heads = await tx.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: PURCHASE_DEPT }, select: { userId: true } })
        const owners = [...new Set(heads.map(h => h.userId))]
        await tx.todo.createMany({ data: owners.map(ownerId => ({ ownerId, action: PURCHASE_PLAN_ISSUED, refType: 'purchasePlan', refId: id })) })
        notified = owners.length
      }
      await tx.purchasePlan.update({ where: { id }, data: { status, issuedBy: actorId, issuedAt: now } })
      return { status, notified }
    }
    await tx.purchasePlan.update({ where: { id }, data: { status } })
    await tx.todo.updateMany({ where: { refType: 'purchasePlan', refId: id, action: PURCHASE_PLAN_ISSUED, status: 'OPEN' }, data: { status: 'CANCELLED', doneAt: now } })
    return { status, notified: 0 }
  })
}
export async function convertPurchasePlan(id: string, itemIds: string[] | undefined, actorId: string) {
  const current = await prisma.purchasePlan.findUnique({ where: { id }, select: { status: true } })
  if (!current) throw new FlowError('采购计划不存在')
  if (current.status !== 'ISSUED') throw new FlowError('只有已下发的计划可以转入采购行')
  const wanted = await prisma.purchasePlanItem.findMany({ where: { planId: id, ...(itemIds ? { id: { in: itemIds } } : { convertedLineId: null }) }, select: { id: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })
  const ids = itemIds ? [...new Set(itemIds)] : wanted.map(i => i.id)
  const results: { itemId: string; lineId?: string; error?: string }[] = []
  for (const itemId of ids) {
    try {
      const line = await purchaseTx(async tx => {
        const before = await tx.purchasePlanItem.findFirst({ where: { id: itemId, planId: id } })
        if (!before) throw new FlowError('计划明细不存在')
        await lockParts(tx, [before.partId])
        const plan = await lockPlan(tx, id)
        if (plan.status !== 'ISSUED') throw new FlowError('只有已下发的计划可以转入采购行')
        const item = await tx.purchasePlanItem.findFirstOrThrow({ where: { id: itemId, planId: id } })
        if (item.convertedLineId) throw new FlowError('这一行已转采购行，不可重复转入')
        if (!item.needDate || Number(item.quantity) <= 0) throw new FlowError('需求日或数量不完整')
        const line = await createLine({ workOrderNumber: plan.workOrderNumber, materialName: item.materialName, spec: item.spec, quantity: Number(item.quantity), unit: item.unit, needDate: item.needDate, partId: item.partId, supplierName: item.supplierName, planNodeId: plan.planNodeId, buyerId: actorId, note: item.note }, actorId, tx)
        await tx.purchasePlanItem.update({ where: { id: itemId }, data: { convertedLineId: line.id } })
        if (!await tx.purchasePlanItem.count({ where: { planId: id, convertedLineId: null } })) {
          await tx.todo.updateMany({ where: { refType: 'purchasePlan', refId: id, action: PURCHASE_PLAN_ISSUED, status: 'OPEN' }, data: { status: 'DONE', doneAt: new Date() } })
        }
        return line
      })
      results.push({ itemId, lineId: line.id })
    } catch (err) {
      // 单行事务失败已回滚，其他行继续；不向客户端透传数据库内部错误。
      results.push({ itemId, error: err instanceof FlowError ? err.message : '转入失败，请刷新后重试' })
    }
  }
  return { results, succeeded: results.filter(r => r.lineId).length, failed: results.filter(r => r.error).length }
}
function describe(plan: Prisma.PurchasePlanGetPayload<{ include: typeof include }>) {
  return { ...plan, items: plan.items.map(i => ({ ...i, quantity: Number(i.quantity) })), progress: purchasePlanProgress(plan.items) }
}
export async function getPurchasePlan(id: string) {
  const plan = await prisma.purchasePlan.findUnique({ where: { id }, include })
  if (!plan) throw new FlowError('采购计划不存在')
  return describe(plan)
}
export async function listPurchasePlans(filter: { workOrderNumber?: string; status?: 'DRAFT' | 'ISSUED' | 'WITHDRAWN'; page?: number; pageSize?: number; visibleWorkOrders?: string[] }) {
  const where: Prisma.PurchasePlanWhereInput = { AND: [filter.visibleWorkOrders ? { workOrderNumber: { in: filter.visibleWorkOrders } } : {}, filter.workOrderNumber ? { workOrderNumber: filter.workOrderNumber } : {}, filter.status ? { status: filter.status } : {}] }
  const total = await prisma.purchasePlan.count({ where })
  const pageSize = filter.pageSize ?? 50
  const page = Math.min(filter.page ?? 1, Math.max(1, Math.ceil(total / pageSize)))
  const rows = await prisma.purchasePlan.findMany({ where, include: { planNode: include.planNode, items: { select: { convertedLineId: true, convertedLine: { select: { status: true } } } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize })
  return { rows: rows.map(({ items, ...plan }) => ({ ...plan, progress: purchasePlanProgress(items) })), total, page, pageSize }
}
