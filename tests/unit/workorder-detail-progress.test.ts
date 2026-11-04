import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoleContext } from '../../server/services/auth/permissions'
import { forecastPlan } from '../../server/services/plan/forecast'
import type { NodeFacts } from '../../server/services/plan/estimate-types'
import { resetServiceDb, returns } from '../helpers/service-db'

const stubs = vi.hoisted(() => ({ getPlan: vi.fn() }))
vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/plan/plan', () => ({ getPlan: stubs.getPlan }))
vi.mock('../../server/services/alerts/reminders', () => ({ listAlerts: async () => [] }))
vi.mock('../../server/services/issues/issues', () => ({ listIssues: async () => [] }))
vi.mock('../../server/services/kitting/kitting', () => ({ NODE_LINKS: {}, loadKits: vi.fn() }))

import { getWorkOrderDetail } from '../../server/services/workorder/detail'

const now = new Date('2026-11-01T04:00:00Z')
const ctx: RoleContext = { userId: 'owner', isAdmin: true, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set() }
const completed: NodeFacts = { id: 'A', planDay: '2026-11-01', manualDoneDay: '2026-10-31', tasks: [] }
const pending: NodeFacts = { id: 'B', planDay: '2026-11-06', preds: ['A'], manualDoneDay: null, tasks: [] }

beforeEach(() => {
  resetServiceDb()
  returns('qmsWorkOrder.findUnique', { workOrderNumber: 'WO', deliveryDate: new Date('2026-11-20') })
  returns('workOrderPlan.findUnique', { createdAt: now, publishedAt: now })
  returns('assemblyNode.findMany', [])
  returns('workOrderExt.findUnique', null)
})

describe('工单详情完成数与计划日期核实解耦', () => {
  it.each([null, '2026-11-02'])('后续开始日 %s 不影响已完成数，冲突仍独立返回', async (startDay) => {
    const forecast = forecastPlan([completed, { ...pending, startDay }], '2026-11-20', '2026-11-01')
    stubs.getPlan.mockResolvedValue({
      ...forecast,
      workOrder: { projectManagerName: '项目经理' },
      plan: { status: 'PUBLISHED' },
      canEdit: true,
      nodes: forecast.nodes.map((entry, seq) => ({
        ...entry, seq, name: entry.id, dept: 'PROJECT', deptText: '项目部',
        planDate: seq === 0 ? completed.planDay : pending.planDay,
        expectedDate: entry.expectedDay, actualDate: entry.actualDay, baselineDate: null,
        confirmText: null, alertLevel: null,
      })),
      unlinked: { drawing: 0, purchase: 0, step: 0, assembly: 0, total: 0 },
    })
    const detail = await getWorkOrderDetail('WO', ctx, ctx, undefined, now)
    expect(detail?.progress).toMatchObject({ total: 2, done: 1 })
    expect(detail?.nodes[0]).toMatchObject({ done: true, state: 'DONE', actualDate: '2026-10-31' })
    if (startDay) {
      expect(detail?.dateConflicts).toEqual([])
      expect(detail?.nodes[1]?.state).toBe('ON_TRACK')
    } else {
      expect(detail?.dateConflicts).toEqual([expect.objectContaining({ nodeId: 'B', code: 'MISSING_START' })])
      expect(detail?.nodes[1]?.state).toBe('REVIEW')
      expect(detail?.expectedDelivery).toBeNull()
    }
  })
})
