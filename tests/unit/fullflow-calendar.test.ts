import { expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ qmsWorkOrder: { findMany: vi.fn() } }))
const plans = vi.hoisted(() => ({ loadPlans: vi.fn() }))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))
vi.mock('../../server/services/plan/plan', () => plans)
import { getCalendar } from '../../server/services/calendar/calendar'
it('places work orders on expected delivery rather than contract or original plan delivery', async () => {
  db.qmsWorkOrder.findMany.mockResolvedValue([{ workOrderNumber: 'WO', deliveryDate: new Date('2026-12-02'), quantity: 1, status: 'IN_PROGRESS' }])
  plans.loadPlans.mockResolvedValue(new Map([['WO', { nodes: [{ id: 'ship', name: '发运', planDate: new Date('2026-12-02') }], forecast: { lastNodeId: 'ship', nodes: [{ id: 'ship', done: false, expectedDay: '2026-12-06' }] }, tasks: [] }]]))
  const data = await getCalendar('month', '2026-12-01', new Date('2026-10-29'))
  expect(data.completions).toHaveLength(1)
  expect(data.completions[0]).toMatchObject({ planDay: '2026-12-02', displayDay: '2026-12-06', deliveryDay: '2026-12-02', expectedDay: '2026-12-06' })
})

it('filters by display day across weeks while keeping planned and overdue tallies on plan day', async () => {
  db.qmsWorkOrder.findMany.mockResolvedValue([{ workOrderNumber: 'WO', deliveryDate: new Date('2026-12-02'), quantity: 2, status: 'IN_PROGRESS' }])
  plans.loadPlans.mockResolvedValue(new Map([['WO', { nodes: [{ id: 'ship', name: '发运', planDate: new Date('2026-12-02') }], forecast: { lastNodeId: 'ship', nodes: [{ id: 'ship', done: false, expectedDay: '2026-12-08' }] }, tasks: [] }]]))
  const now = new Date('2026-12-04T04:00:00Z')
  const planned = await getCalendar('week', '2026-12-02', now)
  expect(planned.completions).toEqual([])
  expect(planned.summary.planned).toEqual({ orders: 1, units: 2 })
  expect(planned.summary.overdue).toEqual({ orders: 1, units: 2 })
  const displayed = await getCalendar('week', '2026-12-08', now)
  expect(displayed.completions[0]).toMatchObject({ displayDay: '2026-12-08', planDay: '2026-12-02', state: 'OVERDUE' })
  expect(displayed.summary.planned).toEqual({ orders: 0, units: 0 })
  expect(displayed.summary.expected).toEqual({ orders: 1, units: 2 })
})
