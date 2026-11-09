import { beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
import { resetDemo } from '../../server/services/dev/demo'

beforeEach(() => {
  resetServiceDb()
  for (const model of ['part', 'routeStep', 'qmsInspection', 'release', 'issue', 'purchaseLine', 'drawingTask', 'assemblyNode', 'planNode', 'planTask', 'alert', 'qmsUser', 'uploadFile', 'purchasePlan']) {
    returns(`${model}.findMany`, [])
  }
  returns('qmsUser.findMany', [{ id: 'u-005' }])
  returns('workOrderLocalSave.deleteMany', { count: 0 })
  for (const model of ['flowEvent', 'todo', 'paymentRequest', 'incomingCheck', 'planChangeLog', 'reminder', 'uploadFile', 'issue', 'release', 'purchasePlan', 'purchaseLine', 'drawingTask', 'assemblyNode', 'planNode', 'workOrderPlan', 'alert', 'notifyRole', 'workOrderExt', 'threshold', 'unmatchedInspection', 'routeStep', 'part', 'routeTemplate', 'qmsInspection', 'qmsWorkOrder', 'qmsSupplier', 'qmsProcess', 'qmsUser', 'deptMapping', 'qmsDepartment']) {
    returns(`${model}.deleteMany`, { count: 0 })
  }
})

describe('demo reset login continuity', () => {
  it('preserves demo login accounts while still clearing scenarios in isolated mode', async () => {
    await resetDemo(undefined, { preserveUsers: true })
    expect(method('qmsUser.deleteMany')).not.toHaveBeenCalled()
    expect(method('qmsWorkOrder.deleteMany')).toHaveBeenCalledWith({ where: { workOrderNumber: { startsWith: 'DEMO-' } } })
    expect(method('workOrderPlan.deleteMany')).toHaveBeenCalled()
    expect(method('workOrderLocalSave.deleteMany')).toHaveBeenCalledWith({ where: { workOrderNumber: { startsWith: 'DEMO-' } } })
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })

  it('retains the existing default cleanup behavior outside isolated mode', async () => {
    await resetDemo()
    expect(method('qmsUser.deleteMany')).toHaveBeenCalledWith({ where: { username: { startsWith: 'DEMO-' } } })
  })
})
