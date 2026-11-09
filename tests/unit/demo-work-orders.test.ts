import { beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'
vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
import { demoWorkOrderApi } from '../../server/services/dev/work-orders'

const input = { workOrderNumber: 'DEMO-WO-004', customerNameId: 'DEMO-CUSTOMER-RAIL', quantity: 1, deliveryDate: '2026-12-01', actorUserId: 'u-003' }
const row = { ...input, deliveryDate: new Date('2026-12-01'), updatedAt: new Date(), syncedAt: new Date(), status: 'OPEN', isDeleted: false, version: 1 }
beforeEach(resetServiceDb)

describe('isolated demo work orders', () => {
  it('creates editable work orders with a customer and version', async () => {
    returns('qmsWorkOrder.create', row)
    const result = await demoWorkOrderApi().createWorkOrder(input)
    expect(result).not.toHaveProperty('syncedAt')
    expect(result.deliveryDate).toEqual(row.deliveryDate)
    expect(method('qmsWorkOrder.create')).toHaveBeenCalledWith({ data: expect.objectContaining({ workOrderNumber: input.workOrderNumber, customerName: '演示客户（铁路局）', version: 1, status: 'OPEN' }) })
  })
  it('rejects non-demo numbers and unknown customers before writes', async () => {
    await expect(demoWorkOrderApi().createWorkOrder({ ...input, workOrderNumber: 'REAL-001' })).rejects.toThrow('DEMO-')
    await expect(demoWorkOrderApi().createWorkOrder({ ...input, customerNameId: 'unknown' })).rejects.toThrow('演示客户')
    expect(method('qmsWorkOrder.create')).not.toHaveBeenCalled()
  })
  it('reports duplicate numbers instead of overwriting existing work', async () => {
    method('qmsWorkOrder.create').mockRejectedValue({ code: 'P2002' })
    await expect(demoWorkOrderApi().createWorkOrder(input)).rejects.toMatchObject({ statusCode: 409, code: 'WORK_ORDER_EXISTS' })
  })
  it('uses an atomic version predicate and rejects a concurrent edit', async () => {
    returns('qmsWorkOrder.findUnique', { workOrderNumber: input.workOrderNumber, version: 1, status: 'OPEN', isDeleted: false })
    returns('qmsWorkOrder.updateMany', { count: 0 })
    await expect(demoWorkOrderApi().updateWorkOrder(input.workOrderNumber, { version: 1, actorUserId: 'u-003', quantity: 2 })).rejects.toMatchObject({ statusCode: 409 })
    expect(method('qmsWorkOrder.updateMany')).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 1 }), data: expect.objectContaining({ quantity: 2, version: { increment: 1 } }) }))
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
  })
  it('cancels without deleting, and repeated cancellation is idempotent', async () => {
    returns('qmsWorkOrder.findUnique', { version: 1, status: 'OPEN', isDeleted: false })
    returns('qmsWorkOrder.updateMany', { count: 1 })
    returns('qmsWorkOrder.findUniqueOrThrow', { ...row, version: 2, status: 'CANCELLED' })
    const api = demoWorkOrderApi()
    await expect(api.cancelWorkOrder(input.workOrderNumber, { version: 1, actorUserId: 'u-003' })).resolves.toMatchObject({ status: 'CANCELLED', version: 2 })
    returns('qmsWorkOrder.findUnique', { ...row, version: 2, status: 'CANCELLED', isDeleted: false })
    await expect(api.cancelWorkOrder(input.workOrderNumber, { version: 1, actorUserId: 'u-003' })).resolves.toMatchObject({ status: 'CANCELLED' })
    expect(method('qmsWorkOrder.updateMany')).toHaveBeenCalledTimes(1)
  })
})
