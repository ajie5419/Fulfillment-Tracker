/**
 * 付款申请（R10）：关联采购行、金额、申请日、是否卡交期、财务处理状态（待付 / 已付 / 暂缓）。不做审批。
 *
 * 能看到该工单的人都能申请（一般是采购员）；申请人或管理员可以删除没付的申请。
 * 状态只有财务（设置页"通知对象"里的 财务）或管理员能改，可附一句处理意见。
 * 列表按影响排序（comparePayments）：没付的在前 → 卡交期的在前 → 离需求日最近的在前。
 */
import type { PaymentStatus, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError, FlowForbidden } from '../flow/errors'
import { loadNames } from '../flow/names'
import { MAX_PAYMENT_LINES, PAYMENT_STATUS_TEXT, comparePayments, lineProgress, num } from './constants'

export interface Actor {
  userId: string
  isAdmin: boolean
}

export interface NewPaymentInput {
  purchaseLineIds: string[]
  amount: number
  requestDate: Date
  blocksDelivery: boolean
  note?: string | null
}

/** 财务：notify_role 里有 FINANCE 角色 */
export async function isFinance(userId: string) {
  return !!(await prisma.notifyRole.findFirst({ where: { userId, role: 'FINANCE' }, select: { id: true } }))
}

/** 关联的采购行（新建前做可见性检查用）：返回它们的工单；不存在、跨工单时报错 */
export async function workOrderOfLines(ids: string[]): Promise<string> {
  const uniq = [...new Set(ids)]
  if (!uniq.length) throw new FlowError('请选择采购行')
  if (uniq.length > MAX_PAYMENT_LINES) throw new FlowError(`一张付款申请最多关联 ${MAX_PAYMENT_LINES} 项`)
  const lines = await prisma.purchaseLine.findMany({ where: { id: { in: uniq } }, select: { workOrderNumber: true, status: true } })
  if (lines.length !== uniq.length) throw new FlowError('有采购行不存在，请刷新')
  const wos = new Set(lines.map((l) => l.workOrderNumber))
  if (wos.size > 1) throw new FlowError('一张付款申请只能关联同一个工单的采购行')
  if (lines.some((l) => l.status === 'CANCELLED')) throw new FlowError('已取消的采购行不能申请付款')
  return [...wos][0]!
}

export async function createPayment(input: NewPaymentInput, requesterId: string) {
  const workOrderNumber = await workOrderOfLines(input.purchaseLineIds)
  const ids = [...new Set(input.purchaseLineIds)]
  return prisma.paymentRequest.create({
    data: {
      workOrderNumber,
      amount: input.amount,
      requestDate: input.requestDate,
      blocksDelivery: input.blocksDelivery,
      note: input.note?.trim() || null,
      requesterId,
      lines: { create: ids.map((purchaseLineId) => ({ purchaseLineId })) },
    },
    select: { id: true },
  })
}

/** 改财务状态：财务或管理员。note 是处理意见（可空，不填时保留原来的） */
export async function setPaymentStatus(id: string, status: PaymentStatus, note: string | null | undefined, actor: Actor) {
  if (!actor.isAdmin && !(await isFinance(actor.userId))) throw new FlowForbidden('只有财务或管理员可以改付款状态')
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payment_request WHERE id = ${id} FOR UPDATE`
    if (!rows.length) throw new FlowError('付款申请不存在')
    return tx.paymentRequest.update({
      where: { id },
      data: { status, statusBy: actor.userId, statusAt: new Date(), ...(note !== undefined ? { financeNote: note?.trim() || null } : {}) },
      select: { id: true, status: true },
    })
  })
}

/** 删除：申请人或管理员，已付的不能删 */
export async function deletePayment(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payment_request WHERE id = ${id} FOR UPDATE`
    if (!rows.length) throw new FlowError('付款申请不存在')
    const p = await tx.paymentRequest.findUniqueOrThrow({ where: { id } })
    if (!actor.isAdmin && p.requesterId !== actor.userId) throw new FlowForbidden('只有申请人或管理员可以删除')
    if (p.status === 'PAID') throw new FlowError('已付的不能删除')
    await tx.paymentRequest.delete({ where: { id } })
    return { ok: true }
  })
}

export async function workOrderOfPayment(id: string) {
  return (await prisma.paymentRequest.findUnique({ where: { id }, select: { workOrderNumber: true } }))?.workOrderNumber ?? null
}

export interface PaymentFilter {
  /** UNPAID = 待付 + 暂缓（默认）；ALL = 全部 */
  status?: 'UNPAID' | PaymentStatus | 'ALL'
  workOrderNumber?: string
  visibleWorkOrders?: string[]
}

/** 付款申请列表（项目和财务看）：按影响排序，附关联物料、最近需求日、当前用户能做的操作 */
export async function listPayments(filter: PaymentFilter, viewer: Actor, now = new Date()) {
  const and: Prisma.PaymentRequestWhereInput[] = []
  const status = filter.status ?? 'UNPAID'
  if (status === 'UNPAID') and.push({ status: { in: ['PENDING', 'ON_HOLD'] } })
  else if (status !== 'ALL') and.push({ status })
  if (filter.workOrderNumber) and.push({ workOrderNumber: filter.workOrderNumber })
  if (filter.visibleWorkOrders) and.push({ workOrderNumber: { in: filter.visibleWorkOrders } })
  const [rows, finance] = await Promise.all([
    prisma.paymentRequest.findMany({ where: { AND: and }, include: { lines: { include: { purchaseLine: true } } }, take: 500 }),
    viewer.isAdmin ? Promise.resolve(true) : isFinance(viewer.userId),
  ])
  const names = await loadNames({ user: rows.flatMap((r) => [r.requesterId, r.statusBy]) })
  const out = rows.map((r) => {
    const lines = r.lines.map((x) => x.purchaseLine)
    const open = lines.filter((l) => l.status === 'OPEN')
    const nearestNeedDate = open.length ? new Date(Math.min(...open.map((l) => +l.needDate))) : null
    return {
      id: r.id,
      workOrderNumber: r.workOrderNumber,
      amount: num(r.amount),
      requestDate: r.requestDate,
      blocksDelivery: r.blocksDelivery,
      status: r.status,
      statusText: PAYMENT_STATUS_TEXT[r.status],
      note: r.note,
      financeNote: r.financeNote,
      requesterId: r.requesterId,
      requesterName: names.user.get(r.requesterId) ?? r.requesterId,
      statusByName: r.statusBy ? (names.user.get(r.statusBy) ?? r.statusBy) : null,
      statusAt: r.statusAt,
      createdAt: r.createdAt,
      nearestNeedDate,
      suppliers: [...new Set(lines.map((l) => l.supplierName).filter((x): x is string => !!x))],
      lines: lines.map((l) => ({
        id: l.id,
        materialName: l.materialName,
        spec: l.spec,
        needDate: l.needDate,
        promisedDate: l.promisedDate,
        status: l.status,
        progressText: lineProgress(l, now).text,
      })),
      permissions: {
        setStatus: finance,
        delete: r.status !== 'PAID' && (viewer.isAdmin || r.requesterId === viewer.userId),
      },
    }
  })
  return out.sort(comparePayments)
}
