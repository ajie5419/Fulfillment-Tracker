import { beforeEach, expect, it, vi } from 'vitest'
import type { Issue, NotifyRole } from '@prisma/client'
import { resetServiceDb, returns } from '../helpers/service-db'
import { matchesRow } from '../helpers/prisma-rows'
vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
import { actionableIssueWhere, overdueIssueWhere } from '../../server/services/issues/paging'
import { judgeIssueOverdue } from '../../server/services/issues/overdue'
import { issuePermissions } from '../../server/services/issues/calculation'
import { DAY_MS, DEFAULT_THRESHOLDS } from '../../server/services/alerts/rules'

beforeEach(() => resetServiceDb())
it.each([0, 1, 2, 5])('超期数据库条件与现有规则等价：黄阈值 %i 天，停工日和毫秒边界', (yellowDays) => {
  const now = new Date('2026-11-02T16:00:00Z')
  const offDays = ['2026-11-01', '2026-11-02', '2026-11-02', '2026-11-03']
  const threshold = { ...DEFAULT_THRESHOLDS.W4, yellowDays }
  const where = overdueIssueWhere(now, offDays, threshold)
  for (const status of ['OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED'] as const) {
    for (let delta = -10; delta <= 1; delta++) for (const ms of [-1, 0, 1]) {
      const createdAt = new Date(+now + delta * DAY_MS + ms)
      for (const dueDate of [null, new Date('2026-10-30'), new Date('2026-11-02'), new Date('2026-11-04')]) {
        expect(matchesRow({ status, createdAt, dueDate }, where)).toBe(judgeIssueOverdue({ status, createdAt, dueDate, now, offDays }, threshold).overdue)
      }
    }
  }
})

it.each(['ordinary', 'head', 'pm', 'pdh', 'admin'])('待办数据库条件与逐条权限等价：%s', async (role) => {
  const actor = { userId: 'viewer', isAdmin: role === 'admin' }
  const roles = (role === 'head' ? [{ role: 'DEPT_HEAD', department: '技术部' }] : role === 'pdh' ? [{ role: 'PROJECT_DEPT_HEAD' }] : []) as NotifyRole[]
  returns('notifyRole.findMany', roles)
  returns('workOrderExt.findMany', role === 'pm' ? [{ workOrderNumber: 'OWN' }] : [])
  returns('qmsDepartment.findMany', [{ id: 'tech', name: '技术部', parentId: null }, { id: 'child', name: '技术科', parentId: 'tech' }, { id: 'other', name: '其他部门', parentId: null }])
  returns('deptMapping.findMany', [])
  const where = await actionableIssueWhere(actor)
  const ctx = { actor, roles, pmOf: new Map(role === 'pm' ? [['OWN', 'viewer']] : []), deptName: new Map([['tech', '技术部'], ['child', '技术科'], ['other', '其他部门']]) }
  for (const status of ['OPEN', 'ACCEPTED', 'RESOLVED', 'CLOSED'] as const) {
    for (const workOrderNumber of ['OWN', 'OTHER']) for (const responsibleDeptId of [null, 'tech', 'child', 'other']) {
      for (const responsibleUserId of [null, 'viewer', 'other']) for (const reporterId of [null, 'viewer', 'other']) {
        const row: Pick<Issue, 'status' | 'workOrderNumber' | 'responsibleDeptId' | 'responsibleUserId' | 'reporterId'> = { status, workOrderNumber, responsibleDeptId, responsibleUserId, reporterId }
        const can = issuePermissions(row, ctx)
        expect(matchesRow(row, where)).toBe(can.accept || can.resolve || can.close)
      }
    }
  }
})
