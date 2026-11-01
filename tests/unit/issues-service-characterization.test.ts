import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls, serviceDb } from '../helpers/service-db'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/flow/flow', () => ({ lockStep: async (_tx: unknown, id: string) => { serviceCalls.push(['lockStep', id]) }, restoreBlockedStep: async (_tx: unknown, id: string) => { serviceCalls.push(['restoreBlockedStep', id]); return id } }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map([['owner', '负责人']]), supplier: new Map([['supplier', '供应商']]), process: new Map([['process', '车削']]) }) }))
vi.mock('../../server/services/auth/departments', () => ({ loadDeptIndex: async () => new Map(), representativeDeptId: () => 'dept', resolveDeptName: () => '技术部', resolveDeptNames: async () => new Map([['dept', '技术部']]), deptIdsResolvingTo: () => ['dept'] }))

import * as issues from '../../server/services/issues/issues'
const now = new Date('2026-11-01T04:00:00Z')
const actor = { userId: 'owner', isAdmin: false }
const issue = { id: 'issue', issueNo: 'YC-261101-001', workOrderNumber: 'WO', title: '标题', refType: 'STEP', refId: 'step', category: 'OUTSOURCE_QUALITY', description: '说明', photos: ['photo'], reporterId: 'owner', source: 'ALERT', sourceKey: 'ALERT:alert', responsibleDeptId: 'dept', responsibleUserId: 'owner', responsibleSupplierId: 'supplier', dueDate: null, status: 'OPEN', createdAt: new Date('2026-10-20'), updatedAt: now, logs: [{ id: 'log', fromStatus: null, toStatus: 'OPEN', note: '生成', actorId: null, createdAt: now }] }

beforeEach(() => {
  resetServiceDb(); vi.useFakeTimers(); vi.setSystemTime(now)
  returns('issue.findUnique', issue)
  returns('issue.findMany', [issue])
  returns('issue.findFirst', { issueNo: 'YC-261101-009' })
  returns('issue.create', issue)
  returns('issue.updateMany', { count: 1 })
  returns('issue.count', 0)
  returns('issueLog.create', {})
  returns('qmsWorkOrder.findFirst', { workOrderNumber: 'WO' })
  returns('part.findUnique', { workOrderNumber: 'WO' })
  returns('part.findMany', [{ id: 'part', name: '工件' }])
  returns('qmsSupplier.findFirst', { id: 'supplier' })
  returns('qmsUser.findFirst', { id: 'new-owner' })
  returns('qmsUser.findUnique', { departmentId: 'dept' })
  returns('notifyRole.findFirst', { userId: 'owner' })
  returns('notifyRole.findMany', [{ role: 'DEPT_HEAD', department: '技术部', userId: 'owner' }])
  returns('qmsDepartment.findMany', [{ id: 'dept', name: '技术部', isDeleted: false }, { id: 'new-dept', name: '生产部', isDeleted: false }])
  returns('workOrderExt.findMany', [{ workOrderNumber: 'WO', projectManagerId: 'owner' }])
  returns('routeStep.findMany', [{ id: 'step', part: { id: 'part', name: '工件' }, processId: 'process', status: 'BLOCKED' }])
  returns('alert.findMany', [{ refId: 'issue', level: 'RED' }])
  returns('alert.findUnique', { rule: 'W3', level: 'RED' })
  returns('alert.updateMany', { count: 1 })
  returns('threshold.findMany', [])
  returns('offDay.findMany', [])
  returns('uploadFile.updateMany', { count: 1 })
})
afterEach(() => vi.useRealTimers())

describe('issues service 搬移前特征', () => {
  it.each(['list', 'detail', 'options', 'departments', 'open-steps'] as const)('%s 查询与完整投影', async action => {
    const operations = { list: () => issues.listIssues({ status: 'UNCLOSED', mine: 'todo', overdue: true, visibleWorkOrders: ['WO'] }, actor, now), detail: () => issues.getIssue('issue', actor, now), options: () => issues.issueOptions(), departments: () => issues.myDepartmentIds('owner'), 'open-steps': () => issues.openIssuesOfSteps(['step']) }
    expect({ result: await operations[action](), calls: serviceCalls }).toMatchSnapshot()
  })

  it('手工上报：工单、工件、供应商、默认责任、编号、图片绑定、日志依次执行', async () => {
    expect({ result: await issues.createIssue({ workOrderNumber: 'WO', partId: 'part', category: 'OUTSOURCE_QUALITY', description: '  说明  ', title: ' 标题 ', photoIds: ['photo', 'photo'], responsibleSupplierId: 'supplier' }, 'owner'), calls: serviceCalls }).toMatchSnapshot()
  })

  it('系统异常沿用调用方事务：默认责任、编号、写入、日志，不另开事务', async () => {
    expect({ result: await issues.createSystemIssue(serviceDb as Prisma.TransactionClient, { sourceKey: 'QMS:inspection', source: 'QMS_NONCONFORMING', category: 'OUTSOURCE_QUALITY', workOrderNumber: 'WO', refType: 'STEP', refId: 'step', description: '说明', responsibleUserId: null, responsibleSupplierId: 'supplier', note: 'QMS 不合格' }), calls: serviceCalls }).toMatchSnapshot()
    expect(serviceCalls.some(call => call[0] === 'transaction.begin')).toBe(false)
  })

  it.each(['accept', 'reassign', 'resolve', 'reject', 'close', 'note'] as const)('%s 状态、日志、预警与工序恢复的固定副作用顺序', async action => {
    const status = action === 'resolve' ? 'ACCEPTED' : action === 'reject' || action === 'close' ? 'RESOLVED' : 'OPEN'
    returns('issue.findUnique', { ...issue, status, responsibleUserId: action === 'accept' ? null : 'owner' })
    const operations = { accept: () => issues.acceptIssue('issue', actor, { note: '  已受理  ' }), reassign: () => issues.reassignIssue('issue', actor, { responsibleDeptId: 'new-dept', responsibleUserId: 'new-owner', responsibleSupplierId: null, dueDate: new Date('2026-11-04'), note: '说明' }), resolve: () => issues.resolveIssue('issue', actor, '  已解决  '), reject: () => issues.rejectIssue('issue', actor, '  未解决  '), close: () => issues.closeIssue('issue', actor, '  确认  '), note: () => issues.addIssueNote('issue', actor, '  备注  ') }
    expect({ result: await operations[action](), calls: serviceCalls }).toMatchSnapshot()
  })

  it('状态校验先于权限查询，空处理结果先于事务', async () => {
    await expect(issues.resolveIssue('missing', actor, ' ')).rejects.toThrow('请填写处理结果')
    expect(serviceCalls).toEqual([])
    returns('issue.findUnique', { ...issue, status: 'CLOSED' })
    await expect(issues.acceptIssue('issue', actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(serviceCalls).toMatchSnapshot()
  })

  it('乐观并发失败后不写日志、不消除预警、不恢复 QMS 关联工序', async () => {
    returns('issue.findUnique', { ...issue, status: 'RESOLVED' })
    returns('issue.updateMany', { count: 0 })
    await expect(issues.closeIssue('issue', actor)).rejects.toMatchObject({ code: 'CONFLICT', message: '状态已变化，请刷新' })
    expect(serviceCalls).toMatchSnapshot()
  })

  it('图片绑定数量不足，回滚且不写上报日志', async () => {
    returns('uploadFile.updateMany', { count: 0 })
    await expect(issues.createIssue({ workOrderNumber: 'WO', category: 'OTHER', description: '说明', photoIds: ['photo'] }, 'owner')).rejects.toThrow('照片无效或已被使用')
    expect(serviceCalls).toMatchSnapshot()
  })

  it('编号冲突重跑完整事务；sourceKey 冲突只识别不重试', async () => {
    method('issue.create').mockRejectedValueOnce({ code: 'P2002', meta: { target: 'issueNo' } })
    await issues.createIssue({ workOrderNumber: 'WO', category: 'OTHER', description: '说明' }, 'owner')
    expect(serviceCalls.filter(call => String(call[0]).startsWith('transaction.'))).toEqual([['transaction.begin'], ['transaction.rollback'], ['transaction.begin'], ['transaction.commit']])
    const conflict = { code: 'P2002', meta: { target: 'sourceKey' } }
    expect(issues.isSourceKeyConflict(conflict)).toBe(true)
    await expect(issues.issueTransaction(async () => { throw conflict })).rejects.toEqual(conflict)
  })
})
