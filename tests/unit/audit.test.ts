import { beforeEach, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'
vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
import { createPayment, deletePayment, setPaymentStatus } from '../../server/services/purchases/payments'
import { saveThreshold, addNotifyRole } from '../../server/services/alerts/settings'
import { logContext } from '../../server/observability/context'

beforeEach(() => {
  resetServiceDb()
  returns('purchaseLine.findMany', [{ workOrderNumber: 'WO', status: 'OPEN' }])
  returns('paymentRequest.create', { id: 'pay' })
  returns('$queryRaw', [{ id: 'pay' }])
  returns('paymentRequest.update', { id: 'pay', status: 'PAID' })
  returns('purchaseLine.updateMany', { count: 1 })
  returns('paymentRequest.findUniqueOrThrow', { id: 'pay', requesterId: 'actor', status: 'PENDING', amount: 10 })
  returns('paymentRequest.delete', { id: 'pay' })
})

const create = () => createPayment({ purchaseLineIds: ['line'], amount: 10, requestDate: new Date(), blocksDelivery: false, note: 'private note' }, 'actor')
const operations: Array<() => Promise<unknown>> = [create, () => setPaymentStatus('pay', 'PAID', 'private note', { userId: 'actor', isAdmin: true }), () => deletePayment('pay', { userId: 'actor', isAdmin: true })]

it.each(operations)('records payment changes before commit with explicit actor and correlated request', async operation => {
  await logContext.run({ requestId: 'request', actorId: 'other' }, operation)
  const calls = serviceCalls.map(c => c[0])
  expect(calls.indexOf('auditLog.create')).toBeGreaterThan(calls.indexOf('transaction.begin'))
  expect(calls.indexOf('auditLog.create')).toBeLessThan(calls.indexOf('transaction.commit'))
  expect(method('auditLog.create')).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'actor', requestId: 'request', entityId: 'pay' }) })
  expect(JSON.stringify(method('auditLog.create').mock.calls)).not.toContain('private note')
})

it.each(operations)('propagates audit failure so the business transaction rolls back', async operation => {
  method('auditLog.create').mockRejectedValueOnce(new Error('audit storage failed'))
  await expect(operation()).rejects.toThrow('audit storage failed')
  expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
  expect(serviceCalls.some(c => c[0] === 'transaction.commit')).toBe(false)
})

it('never writes a success audit for a prohibited paid deletion', async () => {
  returns('paymentRequest.findUniqueOrThrow', { status: 'PAID', requesterId: 'actor' })
  await expect(deletePayment('pay', { userId: 'actor', isAdmin: true })).rejects.toThrow('已付的不能删除')
  expect(method('auditLog.create')).not.toHaveBeenCalled()
})

it('audits administrator settings and does not claim changes for an existing role', async () => {
  returns('threshold.upsert', {})
  await logContext.run({ requestId: 'req', actorId: 'admin' }, () => saveThreshold('W1', { yellowDays: 1, redDays: 2, remindHours: 24 }))
  expect(method('auditLog.create')).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'admin', action: 'settings.threshold' }) })
  method('auditLog.create').mockClear()
  returns('qmsUser.findFirst', { id: 'finance' })
  returns('notifyRole.findFirst', { id: 'existing' })
  expect(await addNotifyRole({ role: 'FINANCE', userId: 'finance' })).toEqual({ id: 'existing' })
  expect(method('auditLog.create')).not.toHaveBeenCalled()
})
