import { beforeEach, expect, it, vi } from 'vitest'
import type { Issue } from '@prisma/client'
import { method, resetServiceDb, returns } from '../helpers/service-db'
import { matchesRow, queryRows } from '../helpers/prisma-rows'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map() }) }))
vi.mock('../../server/services/issues/loaders', async () => {
  const { judgeIssueOverdue } = await import('../../server/services/issues/overdue')
  const { DEFAULT_THRESHOLDS } = await import('../../server/services/alerts/rules')
  const { issuePermissions } = await import('../../server/services/issues/calculation')
  return { decorate: async (rows: Issue[], actor: { userId: string; isAdmin: boolean }, now: Date) => rows.map((r) => ({ ...r,
    ...judgeIssueOverdue({ ...r, now, offDays: ['2026-11-01'] }, DEFAULT_THRESHOLDS.W4),
    can: issuePermissions(r, { actor, roles: [], deptName: new Map(), pmOf: new Map() }),
  })) }
})
import { listIssues, listIssuesPage } from '../../server/services/issues/queries'
import { listReleases, listReleasesPage } from '../../server/services/releases/queries'
import { listComments, listCommentsPage } from '../../server/services/comments/comments'

const now = new Date('2026-11-02T04:00:00Z')
const actor = { userId: 'viewer', isAdmin: false }
const issues = Array.from({ length: 9 }, (_, i) => ({
  id: `issue-${i}`, workOrderNumber: 'WO', status: ['OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED'][i % 4],
  createdAt: new Date('2026-10-31T04:00:00Z'), dueDate: i % 2 ? new Date('2026-10-30') : null,
  responsibleUserId: i % 3 ? 'viewer' : null, reporterId: i % 3 ? null : 'viewer', responsibleDeptId: null,
}))

function table(name: string, rows: object[]) {
  method(`${name}.findMany`).mockImplementation(async (q) => queryRows(rows, q))
  method(`${name}.count`).mockImplementation(async ({ where }) => rows.filter((r) => matchesRow(r, where)).length)
}
beforeEach(() => {
  resetServiceDb()
  returns('notifyRole.findMany', [])
  returns('workOrderExt.findMany', [])
  returns('qmsDepartment.findMany', [])
  returns('deptMapping.findMany', [])
  returns('threshold.findMany', [])
  returns('offDay.findMany', [{ date: new Date('2026-11-01') }])
  table('issue', issues)
})

it.each([{}, { mine: 'todo' as const }, { overdue: true }, { mine: 'todo' as const, overdue: true }, { status: 'CLOSED' as const }])('异常真分页与全量结果严格一致：%j', async (filter) => {
  const all = await listIssues(filter, actor, now)
  method('issue.findMany').mockClear()
  const pages = await Promise.all([1, 2, 3].map((page) => listIssuesPage(filter, actor, now, { page, pageSize: 3 })))
  expect(pages.map((p) => p.total)).toEqual([all.length, all.length, all.length])
  const ids = pages.flatMap((p) => p.rows.map((r) => r.id))
  expect(ids).toEqual(all.map((r) => r.id))
  expect(new Set(ids).size).toBe(all.length)
  expect(method('issue.findMany').mock.calls.every(([q]) => q.take <= 3)).toBe(true)
})

it('发放超过旧的 200 条上限：三页读取集合等于全量，时间戳相同也不重复', async () => {
  const releases = Array.from({ length: 207 }, (_, i) => ({ id: `release-${String(i).padStart(3, '0')}`, createdAt: now, partIds: [], issuerId: 'viewer', receipts: [] }))
  table('release', releases)
  returns('routeStep.groupBy', [])
  const all = await listReleases({}, 'viewer')
  const pages = await Promise.all([1, 2, 3].map((page) => listReleasesPage({}, 'viewer', { page, pageSize: 100 })))
  const ids = pages.flatMap((p) => p.rows.map((r) => r.id))
  expect(ids).toEqual(all.map((r) => r.id))
  expect(new Set(ids).size).toBe(207)
  expect(pages.map((p) => p.total)).toEqual([207, 207, 207])
})

it('留言三页与全量相等，条数是对象全量；空页仍返回 total', async () => {
  table('comment', Array.from({ length: 9 }, (_, i) => ({ id: `c-${i}`, refType: 'part', refId: 'part', createdAt: now, body: `${i}`, authorId: 'viewer', mentionIds: [] })))
  const all = await listComments('part', 'part')
  const pages = await Promise.all([1, 2, 3].map((page) => listCommentsPage('part', 'part', { page, pageSize: 3 })))
  const ids = pages.flatMap((p) => p.rows.map((r) => r.id))
  expect(ids).toEqual(all.map((r) => r.id))
  expect(new Set(ids).size).toBe(9)
  expect(await listCommentsPage('part', 'part', { page: 4, pageSize: 3 })).toMatchObject({ rows: [], total: 9, page: 4, pageSize: 3 })
})
