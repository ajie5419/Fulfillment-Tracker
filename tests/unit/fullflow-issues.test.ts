import { expect, it, vi } from 'vitest'
vi.mock('../../server/utils/prisma', () => ({ prisma: {} }))
import { issuePermissions } from '../../server/services/issues/issues'
const issue = { status: 'OPEN' as const, responsibleDeptId: 'dept', responsibleUserId: null, reporterId: 'reporter', workOrderNumber: 'WO' }
const ctx = (userId: string, roles: any[] = []) => ({ actor: { userId, isAdmin: false }, roles, deptName: new Map([['dept', '技术部']]), pmOf: new Map<string, string | null>() })
it('lets reporter and responsible department head accept an unassigned issue', () => {
  expect(issuePermissions(issue, ctx('reporter')).accept).toBe(true)
  expect(issuePermissions(issue, ctx('head', [{ role: 'DEPT_HEAD', department: '技术部' }])).accept).toBe(true)
  expect(issuePermissions(issue, ctx('other')).accept).toBe(false)
})
it('keeps the assigned handler path and blocks an unrelated reporter once assigned', () => {
  const assigned = { ...issue, responsibleUserId: 'handler' }
  expect(issuePermissions(assigned, ctx('handler')).accept).toBe(true)
  expect(issuePermissions(assigned, ctx('reporter')).accept).toBe(false)
  expect(issuePermissions({ ...assigned, status: 'ACCEPTED' }, ctx('handler')).accept).toBe(false)
  expect(issuePermissions({ ...assigned, status: 'ACCEPTED' }, ctx('handler')).resolve).toBe(true)
})
