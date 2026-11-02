import { Prisma, type ReceiptStatus, type Release } from '@prisma/client'
import type { Counts, ReleaseFilter, ReleaseProgress } from './types'

export const uniq = <T>(xs: T[]) => [...new Set(xs)]

export function countReceipts(receipts: { status: ReceiptStatus }[]): Counts {
  const c: Counts = { PENDING: 0, SIGNED: 0, REJECTED: 0, CANCELLED: 0 }
  for (const r of receipts) c[r.status]++
  return c
}

/** 列表上的状态文字：已作废 / 有拒收 / 签收中 / 已全部签收 */
export function progressText(status: Release['status'], c: Counts) {
  if (status === 'VOID') return '已作废'
  if (c.REJECTED) return '有拒收'
  if (c.PENDING) return '签收中'
  return '已全部签收'
}

/** 签收进度筛选条件（列表筛选和统计卡共用，同一口径） */
export function progressWhere(progress: ReleaseProgress, viewerId: string): Prisma.ReleaseWhereInput {
  if (progress === 'VOID') return { status: 'VOID' }
  if (progress === 'PENDING') return { status: 'ACTIVE', receipts: { some: { status: 'PENDING' } } }
  if (progress === 'REJECTED') return { status: 'ACTIVE', receipts: { some: { status: 'REJECTED' } } }
  return { status: 'ACTIVE', receipts: { some: { userId: viewerId, status: 'PENDING' } } }
}

/** 工单、类型、我发出的 / 发给我的、可见范围（不含签收进度） */
export function releaseScope(filter: Omit<ReleaseFilter, 'progress'>, viewerId: string): Prisma.ReleaseWhereInput[] {
  const and: Prisma.ReleaseWhereInput[] = []
  if (filter.workOrderNumber) and.push({ workOrderNumber: filter.workOrderNumber })
  if (filter.type) and.push({ type: filter.type })
  if (filter.mine === 'issued') and.push({ issuerId: viewerId })
  if (filter.mine === 'received') and.push({ receipts: { some: { userId: viewerId } } })
  if (filter.visibleWorkOrders) and.push({ OR: [{ workOrderNumber: { in: filter.visibleWorkOrders } }, { issuerId: viewerId }, { receipts: { some: { userId: viewerId } } }] })
  return and
}
