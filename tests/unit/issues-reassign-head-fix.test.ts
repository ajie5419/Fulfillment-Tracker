import { beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/flow/flow', () => ({ lockStep: vi.fn(), restoreBlockedStep: vi.fn() }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map([['old-owner', '原负责人'], ['production-head', '生产负责人'], ['specified-owner', '指定负责人']]) }) }))

import { reassignIssue } from '../../server/services/issues/commands'

const actor = { userId: 'admin', isAdmin: true }
const issue = { id: 'issue', status: 'OPEN', category: 'DESIGN', workOrderNumber: 'WO', responsibleDeptId: 'tech', responsibleUserId: 'old-owner', responsibleSupplierId: null, dueDate: null }
const departments = [
  { id: 'tech', name: '技术部', parentId: null, isDeleted: false },
  { id: 'manufacturing', name: '制造中心', parentId: null, isDeleted: false },
  { id: 'office', name: '机加工一室', parentId: 'manufacturing', isDeleted: false },
  { id: 'team', name: '机加工班组', parentId: null, isDeleted: false },
  { id: 'production', name: '生产部', parentId: null, isDeleted: false },
  { id: 'unmapped', name: '档案室', parentId: null, isDeleted: false },
]

beforeEach(() => {
  resetServiceDb()
  returns('issue.findUnique', issue)
  returns('issue.updateMany', { count: 1 })
  returns('issueLog.create', {})
  returns('notifyRole.findMany', [])
  returns('workOrderExt.findMany', [])
  returns('qmsDepartment.findMany', departments)
  returns('deptMapping.findMany', [
    { qmsDepartmentId: 'manufacturing', businessDept: 'PRODUCTION' },
    { qmsDepartmentId: 'team', businessDept: 'PRODUCTION' },
  ])
  returns('qmsUser.findFirst', { id: 'production-head' })
  // 只有业务大部门名下有负责人，按 QMS 原名查询必须查不到。
  method('notifyRole.findFirst').mockImplementation(async (args: { where: { role: string; department: string } }) => {
    serviceCalls.push(['notifyRole.findFirst', args])
    return args.where.role === 'DEPT_HEAD' && args.where.department === '生产部' ? { userId: 'production-head' } : null
  })
})

describe('异常改派：按业务部门换算查默认负责人', () => {
  it.each([
    ['直接对照到生产部的班组', 'team'],
    ['沿上级对照到生产部的科室', 'office'],
    ['原名称就是生产部的部门', 'production'],
  ])('%s 能找到业务部门负责人', async (_label, responsibleDeptId) => {
    await expect(reassignIssue('issue', actor, { responsibleDeptId })).resolves.toEqual({ ok: true })

    expect(method('issue.updateMany')).toHaveBeenCalledWith({ where: { id: 'issue', status: 'OPEN' }, data: { status: 'OPEN', responsibleDeptId, responsibleUserId: 'production-head' } })
    expect(method('notifyRole.findFirst')).toHaveBeenCalledWith({ where: { role: 'DEPT_HEAD', department: '生产部' }, orderBy: { id: 'asc' }, select: { userId: true } })
    expect(method('issueLog.create')).toHaveBeenCalledWith({ data: expect.objectContaining({ note: expect.stringContaining('责任人 原负责人 → 生产负责人') }) })
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })

  it('未对照且没有负责人的部门保持空责任人，不阻断改派', async () => {
    await expect(reassignIssue('issue', actor, { responsibleDeptId: 'unmapped' })).resolves.toEqual({ ok: true })

    expect(method('issue.updateMany')).toHaveBeenCalledWith({ where: { id: 'issue', status: 'OPEN' }, data: { status: 'OPEN', responsibleDeptId: 'unmapped', responsibleUserId: null } })
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })

  it('清空责任部门时也清空默认责任人，不查部门负责人', async () => {
    await expect(reassignIssue('issue', actor, { responsibleDeptId: null })).resolves.toEqual({ ok: true })

    expect(method('notifyRole.findFirst')).not.toHaveBeenCalled()
    expect(method('issue.updateMany')).toHaveBeenCalledWith({ where: { id: 'issue', status: 'OPEN' }, data: { status: 'OPEN', responsibleDeptId: null, responsibleUserId: null } })
  })

  it.each(['specified-owner', null])('显式指定责任人 %s 时不使用新部门默认负责人', async responsibleUserId => {
    returns('qmsUser.findFirst', { id: responsibleUserId })

    await expect(reassignIssue('issue', actor, { responsibleDeptId: 'team', responsibleUserId })).resolves.toEqual({ ok: true })

    expect(method('notifyRole.findFirst')).not.toHaveBeenCalled()
    expect(method('issue.updateMany')).toHaveBeenCalledWith({ where: { id: 'issue', status: 'OPEN' }, data: { status: 'OPEN', responsibleDeptId: 'team', responsibleUserId } })
  })
})
