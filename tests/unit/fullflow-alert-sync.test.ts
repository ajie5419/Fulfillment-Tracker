import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ drawingTaskPart: { findMany: vi.fn() }, drawingTask: { findUniqueOrThrow: vi.fn(), update: vi.fn() }, release: { count: vi.fn() }, $queryRaw: vi.fn(), alert: { updateMany: vi.fn() } }))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))
vi.mock('../../server/services/purchases/purchases', () => ({ purchaseTx: (fn: any) => fn(db), lockParts: vi.fn(), refreshPartReady: vi.fn() }))
import { markDrawn } from '../../server/services/drawings/drawings'
import { judgeW7, w7Summary } from '../../server/services/drawings/constants'
import { DEFAULT_THRESHOLDS } from '../../server/services/alerts/rules'
let task: any
beforeEach(() => {
  vi.resetAllMocks()
  task = { id: 'D', status: 'PENDING', ownerId: 'designer', parts: [], drawnDate: null, needsCustomerConfirm: false, customerConfirmedDate: null }
  db.$queryRaw.mockResolvedValue([{ id: 'D' }])
  db.drawingTaskPart.findMany.mockResolvedValue([])
  db.drawingTask.findUniqueOrThrow.mockImplementation(async () => ({ ...task }))
  db.drawingTask.update.mockImplementation(async ({ data }) => Object.assign(task, data))
  db.release.count.mockResolvedValue(0)
  db.alert.updateMany.mockResolvedValue({ count: 1 })
})
it('clears the old design warning within the design completion transaction', async () => {
  await markDrawn('D', new Date('2026-10-01'), { userId: 'designer', isAdmin: false })
  expect(task.status).toBe('DRAWN')
  expect(db.alert.updateMany).toHaveBeenCalledWith({ where: { activeKey: { in: ['W7:drawing:D'] }, status: 'ACTIVE' }, data: { status: 'CLEARED', activeKey: null } })
})
it('does not retain a drawing-in-progress reason after completion; customer delay remains distinct', () => {
  const completed = { ...task, status: 'DRAWN' as const, planDate: new Date('2026-09-20'), drawnDate: new Date('2026-10-01'), needsCustomerConfirm: true, customerPlanDate: new Date('2026-10-02'), now: new Date('2026-10-29'), offDays: [] }
  const result = judgeW7(completed, DEFAULT_THRESHOLDS.W7)
  expect(result.trigger).toBe('CONFIRM_OVERDUE')
  expect(w7Summary(result, completed, 'designer')).not.toContain('仍未完成设计')
})

it('suppresses historical payment reasons after all payments are paid, retaining unpaid and nonpayment reasons', async () => {
  const { currentDelayReason } = await import('../../server/services/purchases/constants')
  expect(currentDelayReason('PAYMENT', ['PAID'])).toBeNull()
  expect(currentDelayReason('PAYMENT', ['PAID', 'ON_HOLD'])).toBe('PAYMENT')
  expect(currentDelayReason('PAYMENT', [])).toBe('PAYMENT')
  expect(currentDelayReason('SUPPLIER', ['PAID'])).toBe('SUPPLIER')
})
