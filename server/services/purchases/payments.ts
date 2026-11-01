/**
 * 付款申请（R10）：关联采购行、金额、申请日、是否卡交期、财务处理状态（待付 / 已付 / 暂缓）。不做审批。
 *
 * 采购部、该工单项目经理、管理员能申请（接口层判断，权限方案 R13）；申请人或管理员可以删除没付的申请。
 * 金额只给财务、采购部、领导、项目部负责人、管理员、该工单项目经理看，其他人返回 null。
 * 状态只有财务（设置页"人员与角色"里的 财务）或管理员能改，可附一句处理意见。
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
    const updated = await tx.paymentRequest.update({
      where: { id },
      data: { status, statusBy: actor.userId, statusAt: new Date(), ...(note !== undefined ? { financeNote: note?.trim() || null } : {}) },
      select: { id: true, status: true },
    })
    if (status === 'PAID') {
      // A paid request no longer explains a material delay. Other unpaid requests still do.
      await tx.purchaseLine.updateMany({
        where: { delayReason: 'PAYMENT', payments: { some: { paymentId: id }, none: { payment: { status: { not: 'PAID' } } } } },
        data: { delayReason: null, delayNote: null },
      })
    }
    return updated
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

/** 列表最多返回的条数 */
const MAX_PAYMENT_ROWS = 500

export interface PaymentFilter {
  /** UNPAID = 待付 + 暂缓（默认）；ALL = 全部 */
  status?: 'UNPAID' | PaymentStatus | 'ALL'
  workOrderNumber?: string
  visibleWorkOrders?: string[]
  /** 只看卡交期的（前端改版第二轮统计卡"卡交期未付"） */
  blocking?: boolean
  /** 付款金额可见（权限方案 R13）；不可见的金额返回 null。不给时都可见 */
  amountVisible?: (workOrderNumber: string) => boolean
}

/** 付款申请列表（项目和财务看）：按影响排序，附关联物料、最近需求日、当前用户能做的操作 */
function paymentScope(filter: Pick<PaymentFilter, 'workOrderNumber' | 'visibleWorkOrders'>): Prisma.PaymentRequestWhereInput[] {
  const scope: Prisma.PaymentRequestWhereInput[] = []
  if (filter.workOrderNumber) scope.push({ workOrderNumber: filter.workOrderNumber })
  if (filter.visibleWorkOrders) scope.push({ workOrderNumber: { in: filter.visibleWorkOrders } })
  return scope
}

/**
 * 付款申请页顶部统计卡（前端改版第二轮）：待付、暂缓、卡交期未付、已付。范围与列表相同（工单、可见范围），
 * 不受状态筛选影响；每个数字与列表的状态筛选（+ 只看卡交期）同一口径，用 count 不受列表截断影响。
 */
export async function paymentStats(filter: Pick<PaymentFilter, 'workOrderNumber' | 'visibleWorkOrders'>) {
  const scope = paymentScope(filter)
  const count = (w: Prisma.PaymentRequestWhereInput) => prisma.paymentRequest.count({ where: { AND: [...scope, w] } })
  const [pending, onHold, paid, blockingUnpaid] = await Promise.all([
    count({ status: 'PENDING' }),
    count({ status: 'ON_HOLD' }),
    count({ status: 'PAID' }),
    count({ status: { in: ['PENDING', 'ON_HOLD'] }, blocksDelivery: true }),
  ])
  return { pending, onHold, paid, blockingUnpaid }
}

export async function listPayments(filter: PaymentFilter, viewer: Actor, now = new Date()) {
  const scope = paymentScope(filter)
  if (filter.blocking) scope.push({ blocksDelivery: true })
  const status = filter.status ?? 'UNPAID'
  const wanted: PaymentStatus[] = status === 'UNPAID' ? ['PENDING', 'ON_HOLD'] : status === 'ALL' ? ['PENDING', 'ON_HOLD', 'PAID'] : [status]
  const unpaid = wanted.filter((x) => x !== 'PAID')
  // 截断前先定好顺序：没付的单独查（卡交期、新的在前），已付的另查最新的；合并后按影响排序再截断。
  // 枚举顺序（PENDING, PAID, ON_HOLD）不能直接用来排"没付的在前"。
  const query = (statuses: PaymentStatus[]) =>
    statuses.length
      ? prisma.paymentRequest.findMany({
          where: { AND: [...scope, { status: { in: statuses } }] },
          include: { lines: { include: { purchaseLine: true } } },
          orderBy: [{ blocksDelivery: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
          take: MAX_PAYMENT_ROWS,
        })
      : Promise.resolve([])
  const [open, paid, finance] = await Promise.all([
    query(unpaid),
    query(wanted.includes('PAID') ? ['PAID'] : []),
    viewer.isAdmin ? Promise.resolve(true) : isFinance(viewer.userId),
  ])
  const rows = [...open, ...paid]
  const names = await loadNames({ user: rows.flatMap((r) => [r.requesterId, r.statusBy]) })
  const existing = new Set((await prisma.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: [...new Set(rows.map(r => r.workOrderNumber))] }, isDeleted: false }, select: { workOrderNumber: true } })).map(w => w.workOrderNumber))
  const out = rows.map((r) => {
    const lines = r.lines.map((x) => x.purchaseLine)
    const open = lines.filter((l) => l.status === 'OPEN')
    const dated = open.length ? open : lines
    const nearestNeedDate = dated.length ? new Date(Math.min(...dated.map((l) => +l.needDate))) : null
    return {
      id: r.id,
      paymentNo: r.id,
      workOrderDeleted: !existing.has(r.workOrderNumber),
      workOrderNumber: r.workOrderNumber,
      amount: !filter.amountVisible || filter.amountVisible(r.workOrderNumber) ? num(r.amount) : null,
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
      // 排序仅看未到货行；显示日期可回退至全部关联行。
      sortNeedDate: open.length ? new Date(Math.min(...open.map((l) => +l.needDate))) : null,
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
  return out.sort((a, b) => comparePayments(
    { ...a, nearestNeedDate: a.sortNeedDate },
    { ...b, nearestNeedDate: b.sortNeedDate },
  )).slice(0, MAX_PAYMENT_ROWS).map(({ sortNeedDate, ...row }) => row)
}
