import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({
  paymentRequest: { findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
  qmsWorkOrder: { findMany: vi.fn() }, notifyRole: { findFirst: vi.fn() },
  purchaseLine: { updateMany: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn(),
}))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map() }) }))
import { listPayments, paymentStats, setPaymentStatus } from '../../server/services/purchases/payments'
const day = new Date('2026-10-10')
const records = ['PENDING', 'ON_HOLD', 'PAID'].map((status, i) => ({ id: `PAY-${i}`, status, workOrderNumber: i === 2 ? 'deleted' : 'WO', amount: 100, requestDate: day, createdAt: day, blocksDelivery: true, requesterId: 'u', lines: [{ purchaseLine: { id: `line-${i}`, materialName: 'Steel', spec: 'Q355', supplierName: 'supplier', needDate: day, status: i === 2 ? 'ARRIVED' : 'OPEN', arrivedDate: i === 2 ? day : null, promisedDate: null } }] }))
function matches(r: any, w: any): boolean {
  return Object.entries(w).every(([key, value]: [string, any]) => key === 'AND' ? value.every((x: any) => matches(r, x)) : value?.in ? value.in.includes(r[key]) : r[key] === value)
}
beforeEach(() => {
  vi.resetAllMocks()
  db.paymentRequest.findMany.mockImplementation(async ({ where }) => records.filter(r => matches(r, where)))
  db.paymentRequest.count.mockImplementation(async ({ where }) => records.filter(r => matches(r, where)).length)
  db.qmsWorkOrder.findMany.mockResolvedValue([{ workOrderNumber: 'WO' }])
  db.$transaction.mockImplementation(fn => fn(db))
  db.$queryRaw.mockResolvedValue([{ id: 'PAY-0' }])
  db.paymentRequest.update.mockResolvedValue({ id: 'PAY-0', status: 'PAID' })
})
it.each([['UNPAID', 2], ['PENDING', 1], ['ON_HOLD', 1], ['PAID', 1], ['ALL', 3]] as const)('keeps %s rows, group totals and stat filters consistent', async (status, count) => {
  const rows = await listPayments({ status }, { userId: 'u', isAdmin: true })
  expect(rows).toHaveLength(count)
  if (status === 'PAID') expect(rows.every(r => r.status === 'PAID')).toBe(true)
  expect(rows.reduce((sum, r) => sum + (r.amount ?? 0), 0)).toBe(count * 100)
  expect(await paymentStats({})).toEqual({ pending: 1, onHold: 1, paid: 1, blockingUnpaid: 2 })
})
it('keeps arrived material metadata and marks an orphan work order', async () => {
  const [row] = await listPayments({ status: 'PAID' }, { userId: 'u', isAdmin: true })
  expect(row).toMatchObject({ paymentNo: 'PAY-2', workOrderDeleted: true, nearestNeedDate: day, suppliers: ['supplier'], lines: [{ id: 'line-2', spec: 'Q355' }] })
})
it('applies the same visibility and work-order range to list and cards', async () => {
  expect(await listPayments({ status: 'ALL', visibleWorkOrders: ['WO'], workOrderNumber: 'deleted' }, { userId: 'u', isAdmin: true })).toEqual([])
  expect(await paymentStats({ visibleWorkOrders: ['WO'], workOrderNumber: 'deleted' })).toEqual({ pending: 0, onHold: 0, paid: 0, blockingUnpaid: 0 })
})
it('removes payment delay reason transactionally only when no other unpaid request remains', async () => {
  await setPaymentStatus('PAY-0', 'PAID', undefined, { userId: 'u', isAdmin: true })
  expect(db.purchaseLine.updateMany).toHaveBeenCalledWith({ where: { delayReason: 'PAYMENT', payments: { some: { paymentId: 'PAY-0' }, none: { payment: { status: { not: 'PAID' } } } } }, data: { delayReason: null, delayNote: null } })
  db.purchaseLine.updateMany.mockClear()
  await setPaymentStatus('PAY-0', 'ON_HOLD', undefined, { userId: 'u', isAdmin: true })
  expect(db.purchaseLine.updateMany).not.toHaveBeenCalled()
})
