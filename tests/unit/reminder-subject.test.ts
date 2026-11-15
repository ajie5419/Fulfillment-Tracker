import { beforeEach, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  reminder: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  alert: { findMany: vi.fn() },
  drawingTask: { findMany: vi.fn() },
}))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))
import { listReminders } from '../../server/services/alerts/reminders'

beforeEach(() => {
  vi.resetAllMocks()
  db.reminder.findFirst.mockResolvedValue(null)
  db.reminder.count.mockResolvedValue(2)
  db.reminder.findMany.mockImplementation(async ({ where }) => where.kind === 'SYNC_FAIL' ? [] : [
    { id: 'alert-notice', alertId: 'a1', kind: null, level: 'RED', title: 'Late design', createdAt: new Date(), readAt: null },
    { id: 'comment', alertId: null, kind: 'COMMENT', link: '/drawings?id=d1', level: 'REMIND', title: 'Comment', createdAt: new Date(), readAt: null },
  ])
  db.alert.findMany.mockResolvedValue([{ id: 'a1', refType: 'drawing', refId: 'd1', rule: 'W7', status: 'ACTIVE', level: 'RED' }])
  db.drawingTask.findMany.mockResolvedValue([{ id: 'd1', workOrderNumber: 'WO1', status: 'PENDING', planDate: new Date('2026-11-01') }])
})

it('returns persisted alert identity without guessing from notification links, scoped to the signed-in user', async () => {
  const result = await listReminders('owner', new Date('2026-11-15'))
  expect(result.items[0]).toMatchObject({ subject: { type: 'drawing', id: 'd1' }, workOrderNumber: 'WO1', bucket: 'OVERDUE', cleared: false })
  expect(result.items[1]).toMatchObject({ subject: null, link: '/drawings?id=d1' })
  expect(db.reminder.findMany.mock.calls.every(([args]) => args.where.userId === 'owner')).toBe(true)
  expect(db.reminder.count).toHaveBeenCalledWith({ where: { userId: 'owner', readAt: null } })
})

it('keeps a removed alert unassociated instead of inventing a business reference', async () => {
  db.alert.findMany.mockResolvedValue([])
  const result = await listReminders('owner')
  expect(result.items[0]).toMatchObject({ subject: null, link: null })
})
