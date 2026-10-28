import type { Issue, NotifyRole, Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  issue: { findMany: vi.fn() },
  notifyRole: { findMany: vi.fn() },
  workOrderExt: { findMany: vi.fn() },
  qmsDepartment: { findMany: vi.fn() },
  deptMapping: { findMany: vi.fn() },
  threshold: { findMany: vi.fn() },
  offDay: { findMany: vi.fn() },
  alert: { findMany: vi.fn() },
}))
vi.mock('../../server/utils/prisma', () => ({ prisma: db }))
vi.mock('../../server/services/flow/flow', () => ({ lockStep: vi.fn(), restoreBlockedStep: vi.fn() }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map(), process: new Map(), supplier: new Map() }) }))

import { listIssues } from '../../server/services/issues/issues'

const now = new Date('2026-10-28T04:00:00Z')
const actor = { userId: 'viewer', isAdmin: false }
let stored: Issue[]
let roles: NotifyRole[]
let managers: Record<string, string>

function issue(index: number, fields: Partial<Issue> = {}): Issue {
  return {
    id: `issue-${String(index).padStart(5, '0')}`, issueNo: `YC-${index}`, workOrderNumber: 'WO',
    refType: null, refId: null, category: 'OTHER', description: `Issue ${index}`, photos: [],
    reporterId: 'other', source: 'MANUAL', responsibleDeptId: null, responsibleUserId: 'other',
    responsibleSupplierId: null, dueDate: null, status: 'OPEN', escalationLevel: 0, sourceKey: null,
    createdAt: new Date(+now - index * 1000), updatedAt: now, ...fields,
  }
}

/** Evaluate the Prisma predicates used by the real service, including its batch boundary. */
function matches(row: Issue, where: Prisma.IssueWhereInput): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') {
      const clauses = condition as Prisma.IssueWhereInput | Prisma.IssueWhereInput[]
      return (Array.isArray(clauses) ? clauses : [clauses]).every((w) => matches(row, w))
    }
    if (key === 'OR') return (condition as Prisma.IssueWhereInput[]).some((w) => matches(row, w))
    const value = row[key as keyof Issue]
    if (condition instanceof Date) return value instanceof Date && +value === +condition
    if (condition === null || typeof condition !== 'object') return value === condition
    return Object.entries(condition).every(([op, expected]) => {
      if (op === 'in') return (expected as unknown[]).includes(value)
      if (op === 'equals') return value === expected
      if (op === 'lt') return value instanceof Date ? +value < +new Date(expected as Date) : String(value) < String(expected)
      throw new Error(`Unsupported test predicate ${key}.${op}`)
    })
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  stored = []
  roles = []
  managers = {}
  db.issue.findMany.mockImplementation(async ({ where, orderBy, take }) => stored.filter((r) => matches(r, where)).sort((a, b) => {
    for (const order of orderBy) {
      const [key, direction] = Object.entries(order)[0]! as ['createdAt' | 'id', string]
      const av = a[key], bv = b[key]
      const diff = av < bv ? -1 : av > bv ? 1 : 0
      if (diff) return direction === 'desc' ? -diff : diff
    }
    return 0
  }).slice(0, take))
  db.notifyRole.findMany.mockImplementation(async () => roles)
  db.workOrderExt.findMany.mockImplementation(async ({ where }) => where.workOrderNumber.in.map((workOrderNumber: string) => ({ workOrderNumber, projectManagerId: managers[workOrderNumber] ?? null })))
  db.qmsDepartment.findMany.mockResolvedValue([
    { id: 'department', name: '技术科', parentId: null, isDeleted: false },
    { id: 'team', name: '设计班组', parentId: 'department', isDeleted: false },
  ])
  db.deptMapping.findMany.mockResolvedValue([{ qmsDepartmentId: 'department', businessDept: 'TECH' }])
  db.threshold.findMany.mockResolvedValue([])
  db.offDay.findMany.mockResolvedValue([])
  db.alert.findMany.mockResolvedValue([])
})

describe('issue list completeness', () => {
  it('finds the only actionable issue after 500 newer non-actionable records', async () => {
    stored = Array.from({ length: 501 }, (_, i) => issue(i))
    stored[500]!.responsibleUserId = actor.userId
    const rows = await listIssues({ mine: 'todo' }, actor, now)
    expect(rows.map((r) => r.id)).toEqual([stored[500]!.id])
    expect(rows[0]!.can.accept).toBe(true)
  })

  it('finds an overdue issue beyond the first batch using the real W4 rule', async () => {
    stored = Array.from({ length: 501 }, (_, i) => issue(i))
    stored[500]!.dueDate = new Date('2026-10-25T00:00:00Z')
    const rows = await listIssues({ overdue: true }, actor, now)
    expect(rows.map((r) => r.id)).toEqual([stored[500]!.id])
    expect(rows[0]).toMatchObject({ overdue: true, overdueDays: 3 })
  })

  it.each([0, 499, 500, 501, 1001])('returns all %i matching records, with bounded reads', async (count) => {
    stored = Array.from({ length: count }, (_, i) => issue(i))
    const rows = await listIssues({}, actor, now)
    expect(rows).toHaveLength(count)
    expect(new Set(rows.map((r) => r.id)).size).toBe(count)
    expect(db.issue.findMany.mock.calls.every(([query]) => query.take === 500)).toBe(true)
    expect(db.issue.findMany.mock.calls.length).toBe(Math.floor(count / 500) + 1)
  })

  it('does not skip or repeat records sharing the same timestamp across three batches', async () => {
    stored = Array.from({ length: 1001 }, (_, i) => issue(i, { createdAt: new Date(now) }))
    const rows = await listIssues({}, actor, now)
    expect(rows.map((r) => r.id)).toEqual(stored.map((r) => r.id).reverse())
  })

  it('keeps older overdue issues first and newer closed issues last across batches', async () => {
    stored = Array.from({ length: 501 }, (_, i) => issue(i))
    stored[500]!.dueDate = new Date('2026-10-25T00:00:00Z')
    stored.push(issue(501, { createdAt: new Date(+now + 1000), status: 'CLOSED' }))
    const rows = await listIssues({}, actor, now)
    expect(rows[0]!.id).toBe(stored[500]!.id)
    expect(rows.at(-1)!.id).toBe(stored[501]!.id)
    expect(rows.slice(1, -1).map((r) => r.id)).toEqual(stored.slice(0, 500).map((r) => r.id))
  })

  it.each([
    ['owner', 'OPEN', 'accept'],
    ['owner', 'ACCEPTED', 'resolve'],
    ['department head', 'OPEN', 'accept'],
    ['reporter', 'RESOLVED', 'close'],
    ['project manager', 'RESOLVED', 'close'],
    ['project department head', 'RESOLVED', 'close'],
    ['administrator', 'RESOLVED', 'close'],
  ] as const)('keeps %s permissions on a %s issue beyond the first batch', async (role, status, action) => {
    stored = Array.from({ length: 501 }, (_, i) => issue(i))
    const target = stored[500]!
    target.status = status
    if (role === 'owner') target.responsibleUserId = actor.userId
    if (role === 'reporter') target.reporterId = actor.userId
    if (role === 'department head') {
      target.responsibleDeptId = 'team'
      roles = [{ userId: actor.userId, role: 'DEPT_HEAD', department: '技术部' } as NotifyRole]
    }
    if (role === 'project manager') managers.WO = actor.userId
    if (role === 'project department head') roles = [{ userId: actor.userId, role: 'PROJECT_DEPT_HEAD' } as NotifyRole]
    const rows = await listIssues({ mine: 'todo' }, { ...actor, isAdmin: role === 'administrator' }, now)
    expect(rows.find((r) => r.id === target.id)?.can[action]).toBe(true)
  })

  it('intersects todo and overdue filters without treating reassignment as a todo', async () => {
    stored = Array.from({ length: 503 }, (_, i) => issue(i))
    stored[500]!.responsibleUserId = actor.userId
    stored[500]!.dueDate = new Date('2026-10-25T00:00:00Z')
    stored[501]!.dueDate = new Date('2026-10-25T00:00:00Z')
    stored[502]!.responsibleUserId = actor.userId
    managers.WO = actor.userId
    const rows = await listIssues({ mine: 'todo', overdue: true }, actor, now)
    expect(rows.map((r) => r.id)).toEqual([stored[500]!.id])
  })

  it('honors custom thresholds and off days when filtering a later batch', async () => {
    stored = Array.from({ length: 502 }, (_, i) => issue(i, { status: 'ACCEPTED' }))
    stored[500]!.dueDate = new Date('2026-10-25T00:00:00Z')
    stored[501]!.dueDate = new Date('2026-10-24T00:00:00Z')
    db.threshold.findMany.mockResolvedValue([{ rule: 'W4', remindHours: null, yellowDays: 2, redDays: 5 }])
    db.offDay.findMany.mockResolvedValue([{ date: new Date('2026-10-26') }, { date: new Date('2026-10-27') }])
    const rows = await listIssues({ overdue: true }, actor, now)
    expect(rows.map((r) => r.id)).toEqual([stored[501]!.id])
  })

  it('keeps status, category, department, ownership and visible work-order restrictions on every batch', async () => {
    stored = Array.from({ length: 1001 }, (_, i) => issue(i, { responsibleUserId: actor.userId, responsibleDeptId: 'team', category: 'DESIGN' }))
    const excluded = [
      { workOrderNumber: 'HIDDEN' }, { responsibleDeptId: 'other-dept' }, { category: 'WORKSHOP' },
      { responsibleUserId: 'other' }, { status: 'CLOSED' },
    ] as const
    for (const [index, fields] of excluded.entries()) Object.assign(stored[600 + index]!, fields)
    const rows = await listIssues({ status: 'OPEN', category: 'DESIGN', deptIds: ['team'], mine: 'responsible', visibleWorkOrders: ['WO'], workOrderNumber: 'WO' }, actor, now)
    expect(rows).toHaveLength(996)
    expect(rows.every((r) => r.workOrderNumber === 'WO' && r.responsibleDeptId === 'team' && r.category === 'DESIGN' && r.responsibleUserId === actor.userId && r.status === 'OPEN')).toBe(true)
    for (const [query] of db.issue.findMany.mock.calls) {
      const base = query.where.AND?.[0] ?? query.where
      expect(base.workOrderNumber).toEqual({ in: ['WO'], equals: 'WO' })
    }
  })

  it.each(['empty', 'conflicting'] as const)('does not broaden %s work-order visibility', async (scope) => {
    stored = Array.from({ length: 501 }, (_, i) => issue(i))
    const rows = await listIssues({ visibleWorkOrders: scope === 'empty' ? [] : ['OTHER'], workOrderNumber: 'WO' }, { ...actor, isAdmin: true }, now)
    expect(rows).toEqual([])
  })

  it('keeps the reported filter across batches and excludes closed records from todo', async () => {
    stored = Array.from({ length: 501 }, (_, i) => issue(i, { reporterId: actor.userId, status: 'RESOLVED' }))
    stored.push(issue(501, { reporterId: actor.userId, status: 'CLOSED', responsibleUserId: actor.userId }))
    expect(await listIssues({ mine: 'reported' }, actor, now)).toHaveLength(502)
    const rows = await listIssues({ mine: 'todo' }, actor, now)
    expect(rows).toHaveLength(501)
    expect(rows.every((r) => r.status === 'RESOLVED' && r.can.close)).toBe(true)
    expect(await listIssues({ mine: 'todo', status: 'CLOSED' }, actor, now)).toEqual([])
  })

  it('fails the whole request when a later read fails instead of returning partial success', async () => {
    stored = Array.from({ length: 501 }, (_, i) => issue(i))
    const read = db.issue.findMany.getMockImplementation()!
    db.issue.findMany.mockImplementationOnce(read).mockRejectedValueOnce(new Error('second batch failed'))
    await expect(listIssues({}, actor, now)).rejects.toThrow('second batch failed')
  })

  it('does not depend on the previous boundary record still existing', async () => {
    stored = Array.from({ length: 501 }, (_, i) => issue(i))
    const read = db.issue.findMany.getMockImplementation()!
    db.issue.findMany.mockImplementationOnce(async (query) => {
      const result = await read(query)
      stored = stored.filter((r) => r.id !== result.at(-1)!.id)
      return result
    })
    const rows = await listIssues({}, actor, now)
    expect(rows).toHaveLength(501)
    expect(rows.at(-1)!.id).toBe('issue-00500')
  })
})
