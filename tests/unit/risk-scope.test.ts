import { beforeEach, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns } from '../helpers/service-db'
import { matchesRow } from '../helpers/prisma-rows'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
import { canReadRiskIssue, canReadRiskTarget, resolveRiskScope, riskIssueWhere } from '../../server/services/auth/risk-scope'

beforeEach(() => {
  resetServiceDb()
  returns('notifyRole.findMany', [])
  returns('workOrderExt.findMany', [])
  returns('qmsDepartment.findMany', [{ id: 'technical', name: 'Renamed department', parentId: null }, { id: 'team', name: 'Renamed team', parentId: 'technical' }])
  returns('deptMapping.findMany', [{ qmsDepartmentId: 'technical', businessDept: 'TECH' }])
})

const issue = { responsibleUserId: 'other', reporterId: 'someone', responsibleDeptId: 'team', workOrderNumber: 'WO' }
const target = { ownerIds: ['other'], watcherIds: ['sender'], departmentKeys: ['TECH'], workOrderNumber: 'WO' }

it.each([
  ['ordinary', [], [], false, false],
  ['unconfigured head', [{ role: 'DEPT_HEAD', department: null }], [], false, false],
  ['finance', [{ role: 'FINANCE' }], [], false, false],
  ['outsource', [{ role: 'OUTSOURCE_COORDINATOR' }], [], false, false],
  ['head', [{ role: 'DEPT_HEAD', department: 'TECH' }], [], false, true],
  ['other head', [{ role: 'DEPT_HEAD', department: 'PURCHASE' }], [], false, false],
  ['manager', [], ['WO'], false, true],
  ['other manager', [], ['OTHER'], false, false],
  ['leader', [{ role: 'LEADER' }], [], false, true],
  ['project head', [{ role: 'PROJECT_DEPT_HEAD' }], [], false, true],
  ['administrator', [], [], true, true],
] as const)('%s has consistent alert, issue detail and SQL visibility', async (_, roles, orders, isAdmin, allowed) => {
  returns('notifyRole.findMany', roles)
  returns('workOrderExt.findMany', orders.map(workOrderNumber => ({ workOrderNumber })))
  const scope = await resolveRiskScope({ userId: 'viewer', isAdmin })
  expect(canReadRiskTarget(scope, target, new Map())).toBe(allowed)
  expect(canReadRiskIssue(scope, issue)).toBe(allowed)
  expect(matchesRow(issue, riskIssueWhere(scope))).toBe(allowed)
  if (isAdmin) expect(method('notifyRole.findMany')).not.toHaveBeenCalled()
})

it('unions department, managed project, ownership and reporting without granting unrelated access', async () => {
  returns('notifyRole.findMany', [{ role: 'DEPT_HEAD', department: 'TECH' }])
  returns('workOrderExt.findMany', [{ workOrderNumber: 'MANAGED' }])
  const scope = await resolveRiskScope({ userId: 'viewer', isAdmin: false })
  const unrelated = { ...issue, responsibleDeptId: null, workOrderNumber: 'OTHER' }
  for (const row of [issue, { ...unrelated, workOrderNumber: 'MANAGED' }, { ...unrelated, responsibleUserId: 'viewer' }, { ...unrelated, reporterId: 'viewer' }]) {
    expect(canReadRiskIssue(scope, row)).toBe(true)
    expect(matchesRow(row, riskIssueWhere(scope))).toBe(true)
  }
  expect(canReadRiskIssue(scope, unrelated)).toBe(false)
  expect(canReadRiskTarget(scope, { ...target, departmentKeys: ['PURCHASE'], workOrderNumber: 'OTHER' }, new Map([['other', 'TECH']]))).toBe(false)
})

it('keeps cross-department handoff watchers and current owners visible, including objects without work orders', async () => {
  const scope = await resolveRiskScope({ userId: 'sender', isAdmin: false })
  expect(canReadRiskTarget(scope, target, new Map())).toBe(true)
  expect(canReadRiskTarget(scope, { ...target, watcherIds: [], workOrderNumber: null }, new Map())).toBe(false)
  expect(canReadRiskTarget(scope, { ...target, ownerIds: ['sender'], watcherIds: [], workOrderNumber: null }, new Map())).toBe(true)
})
