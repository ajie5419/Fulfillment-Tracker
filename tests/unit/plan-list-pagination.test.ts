import { beforeEach, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns } from '../helpers/service-db'
import { queryRows, matchesRow } from '../helpers/prisma-rows'
import type { RoleContext } from '../../server/services/auth/permissions'
vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/plan/plan', () => ({ loadPlans: async () => new Map() }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map() }) }))
import { listPlans, listPlansPage } from '../../server/services/plan/list'

const ctx: RoleContext = { userId: 'viewer', isAdmin: true, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set() }
beforeEach(() => resetServiceDb())
it('项目计划三页与全量集合相等，交期相同以工单主键排序，汇总不变成当前页', async () => {
  const stored = Array.from({ length: 9 }, (_, i) => ({ workOrderNumber: `WO-${i}`, deliveryDate: new Date('2026-12-01'), status: 'IN_PROGRESS', isDeleted: false }))
  method('qmsWorkOrder.findMany').mockImplementation(async (q) => queryRows(stored, q))
  method('qmsWorkOrder.count').mockImplementation(async ({ where }) => stored.filter((r) => matchesRow(r, where)).length)
  returns('workOrderExt.findMany', [])
  returns('workOrderPlan.findMany', [])
  const all = await listPlans(undefined, ctx)
  const pages = await Promise.all([1, 2, 3].map((page) => listPlansPage(undefined, ctx, new Date(), { page, pageSize: 3 })))
  const keys = pages.flatMap((p) => p.rows.map((r) => r.workOrderNumber))
  expect(keys).toEqual(all.rows.map((r) => r.workOrderNumber))
  expect(new Set(keys).size).toBe(9)
  expect(pages.every((p) => p.total === 9)).toBe(true)
  expect(all.summary.total).toBe(9)
})
