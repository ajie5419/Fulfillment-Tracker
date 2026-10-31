import type { Issue } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cockpitMetrics, mergeCockpitItems } from '../../shared/board-cockpit'
import { DEFAULT_THRESHOLDS, judgeW4 } from '../../server/services/alerts/rules'
import { judgeIssueOverdue } from '../../server/services/issues/overdue'

const db = vi.hoisted(() => ({
  qmsWorkOrder: { findMany: vi.fn() }, workOrderExt: { findMany: vi.fn() },
  issue: { findMany: vi.fn(), count: vi.fn() }, issueLog: { findMany: vi.fn() },
  notifyRole: { findMany: vi.fn() }, qmsDepartment: { findMany: vi.fn() }, deptMapping: { findMany: vi.fn() },
  threshold: { findMany: vi.fn() }, offDay: { findMany: vi.fn() }, alert: { findMany: vi.fn() },
  routeStep: { findMany: vi.fn() }, release: { groupBy: vi.fn() }, purchaseLine: { groupBy: vi.fn() },
  drawingTask: { groupBy: vi.fn() }, assemblyNode: { groupBy: vi.fn(), findMany: vi.fn() },
}))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))
vi.mock('../../server/services/flow/flow', () => ({ lockStep: vi.fn(), restoreBlockedStep: vi.fn() }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map(), process: new Map(), supplier: new Map() }) }))
vi.mock('../../server/services/sync/status', () => ({ syncOverview: async () => ({ lastSyncAt: null, oldest: null, errors: [] }) }))
vi.mock('../../server/services/plan/plan', () => ({ loadPlans: async () => new Map() }))
vi.mock('../../server/services/monitoring/status', () => ({ loadMonitoredEntities: async () => [] }))

import { listIssues } from '../../server/services/issues/issues'
import { getBoard } from '../../server/services/issues/board'
import { getOverview } from '../../server/services/issues/overview'

const now = new Date('2026-10-28T04:00:00Z')
const day = (value: string) => new Date(`${value}T00:00:00Z`)
const actor = { userId: 'viewer', isAdmin: false }
let stored: Issue

beforeEach(() => {
  vi.resetAllMocks()
  stored = {
    id: 'issue', issueNo: 'YC-test', workOrderNumber: 'WO', title: null, refType: null, refId: null,
    category: 'OTHER', description: '测试异常', photos: [], reporterId: 'viewer', source: 'MANUAL',
    responsibleDeptId: 'dept', responsibleUserId: null, responsibleSupplierId: null,
    dueDate: day('2026-10-30'), status: 'OPEN', escalationLevel: 0, sourceKey: null,
    createdAt: new Date(+now - 3600_000), updatedAt: now,
  }
  db.qmsWorkOrder.findMany.mockResolvedValue([{ workOrderNumber: 'WO', projectName: '测试', customerName: '客户', status: 'IN_PROGRESS', deliveryDate: day('2026-12-31') }])
  db.issue.findMany.mockImplementation(async ({ where }) => !where.status?.in || where.status.in.includes(stored.status) ? [stored] : [])
  db.issue.count.mockResolvedValue(0)
  db.issueLog.findMany.mockResolvedValue([])
  db.workOrderExt.findMany.mockResolvedValue([])
  db.notifyRole.findMany.mockResolvedValue([])
  db.qmsDepartment.findMany.mockResolvedValue([{ id: 'dept', name: '质量部', parentId: null }])
  db.deptMapping.findMany.mockResolvedValue([])
  db.threshold.findMany.mockResolvedValue([])
  db.offDay.findMany.mockResolvedValue([])
  db.alert.findMany.mockResolvedValue([])
  db.routeStep.findMany.mockResolvedValue([])
  db.release.groupBy.mockResolvedValue([])
  db.purchaseLine.groupBy.mockResolvedValue([])
  db.drawingTask.groupBy.mockResolvedValue([])
  db.assemblyNode.groupBy.mockResolvedValue([])
  db.assemblyNode.findMany.mockResolvedValue([])
})

describe('统一超期定义及真实消费路径', () => {
  it.each([
    { name: '待受理超时、未过解决日', status: 'OPEN', createdAt: new Date(+now - 2 * 86_400_000), dueDate: day('2026-10-30'), overdue: true, days: 0, color: 'YELLOW' },
    { name: '待受理超时、无解决日', status: 'OPEN', createdAt: new Date(+now - 2 * 86_400_000), dueDate: null, overdue: true, days: 0, color: 'YELLOW' },
    { name: '已过解决日', status: 'ACCEPTED', dueDate: day('2026-10-27'), overdue: true, days: 1, color: 'YELLOW' },
    { name: '解决日已过红阈值', status: 'OPEN', dueDate: day('2026-10-25'), overdue: true, days: 3, color: 'RED' },
    { name: '待确认', status: 'RESOLVED', dueDate: day('2026-10-20'), overdue: false, days: 0, color: 'GREEN' },
    { name: '已关闭', status: 'CLOSED', dueDate: day('2026-10-20'), overdue: false, days: 0, color: 'GREEN' },
    { name: '两者皆未超', status: 'OPEN', dueDate: day('2026-10-30'), overdue: false, days: 0, color: 'GREEN' },
    { name: '解决日当天', status: 'ACCEPTED', dueDate: day('2026-10-28'), overdue: false, days: 0, color: 'GREEN' },
    { name: '处理中无解决日、创建再久也不算', status: 'ACCEPTED', createdAt: day('2026-01-01'), dueDate: null, overdue: false, days: 0, color: 'GREEN' },
    { name: '可配置黄阈值前已过解决日', status: 'ACCEPTED', dueDate: day('2026-10-27'), yellowDays: 2, overdue: true, days: 1, color: 'YELLOW' },
    { name: '待受理黄阈值未满', status: 'OPEN', createdAt: new Date(+now - 86_400_000), yellowDays: 2, overdue: false, days: 0, color: 'GREEN' },
    { name: '解决日后都是停工日', status: 'ACCEPTED', dueDate: day('2026-10-27'), offDays: ['2026-10-28'], overdue: false, days: 0, color: 'GREEN' },
  ] as const)('$name：列表、看板、总览、部门统计和驾驶舱一致', async (sample) => {
    const { name, overdue, days, color, ...fields } = sample
    const custom = fields as { yellowDays?: number; offDays?: readonly string[] }
    Object.assign(stored, fields)
    const threshold = { ...DEFAULT_THRESHOLDS.W4, yellowDays: custom.yellowDays ?? DEFAULT_THRESHOLDS.W4.yellowDays }
    db.threshold.findMany.mockResolvedValue([{ rule: 'W4', ...threshold }])
    db.offDay.findMany.mockResolvedValue((custom.offDays ?? []).map((date) => ({ date: day(date) })))
    const judged = judgeIssueOverdue({ ...stored, now, offDays: custom.offDays ?? [] }, threshold)
    expect(judged).toEqual({ overdue, overdueDays: days, color: color === 'GREEN' ? null : color })
    const list = await listIssues({}, actor, now)
    expect(list[0]).toMatchObject({ overdue, overdueDays: days })
    expect(await listIssues({ overdue: true }, actor, now)).toHaveLength(Number(overdue))
    const board = await getBoard(undefined, now)
    expect(board.rows[0]).toMatchObject({ overdueIssues: Number(overdue), overdueCount: Number(overdue), color })
    const overview = await getOverview(now)
    expect(overview.summary.overdueIssues).toBe(Number(overdue))
    expect(overview.stages.find((s) => s.key === 'issue')!.count).toBe(Number(overdue))
    expect(overview.byDept.reduce((count, d) => count + d.overdue, 0)).toBe(Number(overdue))
    expect(cockpitMetrics(overview, null)[1].value).toBe(Number(overdue))
    expect(mergeCockpitItems({ redWorkOrders: [], issues: list, stagnation: [] })).toHaveLength(Number(overdue))
  })

  it('边界仍按北京时间、满阈值时刻及停工日计算', () => {
    const input = { status: 'OPEN' as const, createdAt: new Date('2026-10-26T02:00:00Z'), dueDate: null, offDays: ['2026-10-27'] }
    expect(judgeIssueOverdue({ ...input, now: new Date('2026-10-28T01:59:59Z') }, DEFAULT_THRESHOLDS.W4).overdue).toBe(false)
    expect(judgeIssueOverdue({ ...input, now: new Date('2026-10-28T02:00:00Z') }, DEFAULT_THRESHOLDS.W4).overdue).toBe(true)
    const due = { ...input, status: 'ACCEPTED' as const, dueDate: day('2026-10-28'), offDays: [] }
    expect(judgeIssueOverdue({ ...due, now: new Date('2026-10-28T15:59:59Z') }, DEFAULT_THRESHOLDS.W4).overdueDays).toBe(0)
    expect(judgeIssueOverdue({ ...due, now: new Date('2026-10-28T16:00:00Z') }, DEFAULT_THRESHOLDS.W4).overdueDays).toBe(1)
  })

  it('只读统计与 W4 通知级别独立，保留扫描写入的 alertLevel', async () => {
    stored.status = 'ACCEPTED'
    stored.dueDate = day('2026-10-27')
    const threshold = { ...DEFAULT_THRESHOLDS.W4, yellowDays: 2 }
    db.threshold.findMany.mockResolvedValue([{ rule: 'W4', ...threshold }])
    db.alert.findMany.mockResolvedValue([{ refId: stored.id, level: 'RED' }])
    expect(judgeW4({ ...stored, now, offDays: [] }, threshold).level).toBeNull()
    expect((await listIssues({}, actor, now))[0]).toMatchObject({ overdue: true, overdueDays: 1, alertLevel: 'RED' })
  })
})
