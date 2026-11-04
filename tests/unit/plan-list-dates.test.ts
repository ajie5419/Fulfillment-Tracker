import { beforeEach, expect, it, vi } from 'vitest'
import type { RoleContext } from '../../server/services/auth/permissions'
import { resetServiceDb, returns } from '../helpers/service-db'

const stubs = vi.hoisted(() => ({ loadPlans: vi.fn() }))
vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/plan/plan', () => ({ loadPlans: stubs.loadPlans }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map() }) }))
import { listPlans, listPlansPage } from '../../server/services/plan/list'

const ctx: RoleContext = { userId: 'viewer', isAdmin: true, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set() }
const now = new Date('2026-11-10T04:00:00Z')

beforeEach(() => {
  resetServiceDb()
  stubs.loadPlans.mockReset()
  returns('qmsWorkOrder.findMany', [{ workOrderNumber: 'WO', deliveryDate: new Date('2026-12-01T00:00:00Z'), status: 'IN_PROGRESS' }])
  returns('qmsWorkOrder.count', 1)
  returns('workOrderExt.findMany', [])
  returns('workOrderPlan.findMany', [])
})

const plan = (publishedAt: Date | null, status = 'PUBLISHED') => ({
  status, publishedAt, nodes: [{ id: 'node', confirmStatus: 'PENDING' }],
  forecast: { nodes: [{ done: false, taskCount: 0 }], sourceNodes: 0, dateConflicts: [], expectedDelivery: '2026-12-01', deliveryDelayDays: 0 },
})

it.each([
  ['2026-11-03T15:59:59.999Z', '2026-11-03'],
  ['2026-11-03T16:00:00.000Z', '2026-11-04'],
  ['2026-11-03T16:30:00.000Z', '2026-11-04'],
  ['2026-11-03T23:59:59.999Z', '2026-11-04'],
  ['2026-11-04T00:00:00.000Z', '2026-11-04'],
])('全量和分页列表将发布时间 %s 显示为上海日 %s，查询日期不影响发布日', async (publishedAt, publishedDay) => {
  stubs.loadPlans.mockResolvedValue(new Map([['WO', plan(new Date(publishedAt))]]))
  const all = await listPlans(undefined, ctx, now)
  const page = await listPlansPage(undefined, ctx, now)
  for (const result of [all, page]) {
    expect(result.rows[0]).toMatchObject({ publishedDay, deliveryDate: '2026-12-01', status: 'PUBLISHED' })
  }
})

it.each([
  { status: 'DRAFT', publishedAt: new Date('2026-11-03T16:30:00Z') },
  { status: 'PUBLISHED', publishedAt: null },
])('状态 $status、发布时间 $publishedAt 时不凭空补发布日', async ({ status, publishedAt }) => {
  stubs.loadPlans.mockResolvedValue(new Map([['WO', plan(publishedAt, status)]]))
  expect((await listPlans(undefined, ctx, now)).rows[0]?.publishedDay).toBeNull()
  expect((await listPlansPage(undefined, ctx, now)).rows[0]?.publishedDay).toBeNull()
})
