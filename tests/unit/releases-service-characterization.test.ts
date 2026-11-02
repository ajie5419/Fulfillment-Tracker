import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb, isDeadlock: (e: { code?: string }) => e.code === 'P2034' }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map([['owner', '负责人']]), process: new Map([['process', '车削']]), supplier: new Map() }), departmentNames: async () => new Map([['dept', '技术部']]), userDepartmentNames: async () => new Map([['owner', '技术部']]) }))
vi.mock('../../server/services/auth/departments', () => ({ loadDeptIndex: async () => new Map(), resolveDeptName: () => '技术部' }))
vi.mock('../../server/services/drawings/drawings', () => ({
  lockTask: async (_tx: unknown, id: string) => { serviceCalls.push(['lockTask', id]); return { id, status: 'DRAWN', parts: [{ partId: 'part' }] } },
  assertReleasable: (...args: unknown[]) => { serviceCalls.push(['assertReleasable', ...args]) },
  settleTask: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['settleTask', ...args]); return { status: 'RELEASED' } },
}))
vi.mock('../../server/services/process/process', () => ({
  lockMaterialChangeParts: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['lockMaterialChangeParts', ...args]) },
  markRevisingByChange: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['markRevisingByChange', ...args]); return { revising: 1, notified: true } },
  markRevisingByVoid: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['markRevisingByVoid', ...args]) },
}))
vi.mock('../../server/services/purchases/purchases', () => ({ lockParts: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['lockParts', ...args]) }, refreshPartReady: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['refreshPartReady', ...args]) } }))
vi.mock('../../server/services/bom/excel', () => ({ XLSX_MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', applyTechBom: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['applyTechBom', ...args]); return { created: ['part'], matched: ['matched'], revisionFilled: 1, skipped: 0, purchasePlanId: 'purchase-plan', purchasePlanItems: 1 } } }))

import * as releases from '../../server/services/releases/releases'
const now = new Date('2026-11-01T04:00:00Z')
const actor = { userId: 'owner', isAdmin: false }
const rel = { id: 'release', releaseNo: 'FF-261101-001', type: 'CHANGE', status: 'ACTIVE', workOrderNumber: 'WO', partIds: ['part', 'missing'], issuerId: 'owner', drawingTaskId: 'task', bomFileId: 'bom', version: 'A', description: '说明', createdAt: now, changeConfirmedAt: null, changeConfirmedBy: null, changeConfirmNote: null }
const receipt = { id: 'receipt', userId: 'owner', status: 'PENDING', reason: null, actedAt: null, release: rel }
const step = { id: 'step', partId: 'part', seq: 1, status: 'PENDING', mode: 'SELF', processId: 'process', supplierId: null, holdReleaseId: 'release' }
const part = { id: 'part', name: '工件', drawingNo: 'D1', workOrderNumber: 'WO', revision: 'A', quantity: 2, steps: [step] }

beforeEach(() => {
  resetServiceDb(); vi.useFakeTimers(); vi.setSystemTime(now)
  returns('release.findUnique', { ...rel, receipts: [receipt] })
  returns('release.findUniqueOrThrow', rel)
  returns('release.findMany', [{ ...rel, receipts: [receipt] }])
  returns('release.findFirst', { releaseNo: 'FF-261101-009' })
  returns('release.create', rel)
  returns('release.update', rel)
  returns('release.count', 2)
  returns('releaseReceipt.findUniqueOrThrow', receipt)
  returns('releaseReceipt.findMany', [receipt])
  returns('releaseReceipt.findFirst', { id: 'receipt' })
  returns('releaseReceipt.count', 0)
  returns('releaseReceipt.createMany', { count: 1 })
  returns('releaseReceipt.update', receipt)
  returns('releaseReceipt.updateMany', { count: 1 })
  returns('part.findMany', [part])
  returns('part.count', 1)
  returns('qmsUser.findMany', [{ id: 'owner', departmentId: 'dept' }])
  returns('qmsWorkOrder.findFirst', { workOrderNumber: 'WO' })
  returns('qmsWorkOrder.findUnique', { projectName: '项目', customerName: '客户' })
  returns('qmsWorkOrder.count', 1)
  returns('notifyRole.findMany', [{ userId: 'owner', role: 'DEPT_HEAD', department: '技术部' }])
  returns('routeStep.findMany', [step, { ...step, id: 'started', status: 'OUT' }])
  returns('routeStep.findFirst', { id: 'step' })
  returns('routeStep.updateMany', { count: 1 })
  returns('routeStep.groupBy', [{ holdReleaseId: 'release', _count: { _all: 1 } }])
  returns('routeStep.count', 1)
  returns('todo.findMany', [{ id: 'todo', ownerId: 'owner', status: 'OPEN', createdAt: now }])
  returns('todo.findFirst', { id: 'todo' })
  returns('todo.count', 0)
  returns('todo.createMany', { count: 1 })
  returns('todo.updateMany', { count: 1 })
  returns('alert.updateMany', { count: 1 })
  returns('uploadFile.updateMany', { count: 1 })
  returns('uploadFile.findMany', [{ id: 'bom', mime: 'xlsx', size: 20 }, { id: 'attachment', mime: 'pdf', size: 10 }])
  returns('purchasePlan.update', {})
  returns('drawingTaskPart.createMany', { count: 1 })
  returns('reminder.createMany', { count: 1 })
  returns('$queryRaw', [{ id: 'release' }, { id: 'older' }])
})
afterEach(() => vi.useRealTimers())

describe('releases service 搬移前特征', () => {
  it.each(['list', 'detail', 'receipts-pending', 'receipts-done', 'todos', 'stats', 'view'] as const)('%s 固定查询与完整 DTO', async action => {
    const operations = {
      list: () => releases.listReleases({ workOrderNumber: 'WO', type: 'CHANGE', progress: 'MINE_PENDING', mine: 'received', visibleWorkOrders: ['WO'] }, 'owner'),
      detail: () => releases.getRelease('release', actor),
      'receipts-pending': () => releases.listMyReceipts('owner', 'pending'),
      'receipts-done': () => releases.listMyReceipts('owner', 'done'),
      todos: () => releases.describeReleaseTodos([{ action: 'SIGN_RELEASE', refType: 'receipt', refId: 'receipt' }, { action: 'CONFIRM_CHANGE', refType: 'release', refId: 'release' }]),
      stats: () => releases.releaseStats({ visibleWorkOrders: [], mine: 'issued' }, 'owner'),
      view: () => releases.assertCanViewRelease('release', 'viewer', () => false),
    }
    expect({ result: await operations[action](), calls: serviceCalls }).toMatchSnapshot()
  })

  it.each(['CHANGE', 'DRAWING'] as const)('%s 新建的锁、编号、数量校验、待办与跨领域调用顺序', async type => {
    expect({ result: await releases.createRelease({ type, workOrderNumber: 'WO', partIds: ['part'], description: '  说明  ', userIds: ['owner'], attachmentIds: ['attachment'], drawingTaskId: 'task', ...(type === 'DRAWING' ? { bom: { fileId: 'bom', rows: [] } } : {}) }, 'owner'), calls: serviceCalls }).toMatchSnapshot()
  })

  it.each(['sign', 'reject', 'void', 'confirm'] as const)('%s 状态流转及副作用顺序', async action => {
    if (action === 'void') returns('release.findMany', [{ id: 'older', partIds: ['part'] }])
    const operations = { sign: () => releases.signReceipt('receipt', 'owner'), reject: () => releases.rejectReceipt('receipt', 'owner', '  原因  '), void: () => releases.voidRelease('release', actor), confirm: () => releases.confirmChange('release', actor, '  已通知  ') }
    expect({ result: await operations[action](), calls: serviceCalls }).toMatchSnapshot()
  })

  it('校验顺序：空说明、附件上限、接收人、BOM 类型；签收先权限再状态', async () => {
    await expect(releases.createRelease({ type: 'CHANGE', workOrderNumber: 'WO', description: ' ', attachmentIds: Array.from({ length: 30 }, (_, i) => String(i)) }, 'owner')).rejects.toThrow('请填写说明')
    await expect(releases.createRelease({ type: 'CHANGE', workOrderNumber: 'WO', description: '说明', attachmentIds: Array.from({ length: 30 }, (_, i) => String(i)) }, 'owner')).rejects.toThrow('附件最多')
    await expect(releases.createRelease({ type: 'CHANGE', workOrderNumber: 'WO', description: '说明', bom: { fileId: 'bom', rows: [] } }, 'owner')).rejects.toThrow('请选择接收人')
    returns('releaseReceipt.findUniqueOrThrow', { ...receipt, status: 'SIGNED', release: { ...rel, status: 'VOID' } })
    await expect(releases.signReceipt('receipt', 'other')).rejects.toThrow('只能签收发给自己的发放单')
    await expect(releases.signReceipt('receipt', 'owner')).rejects.toThrow('发放单已作废')
    expect(serviceCalls).toMatchSnapshot()
  })

  it('附件绑定数量不足时整事务失败', async () => {
    returns('uploadFile.updateMany', { count: 0 })
    await expect(releases.createRelease({ type: 'DRAWING', workOrderNumber: 'WO', description: '说明', userIds: ['owner'], attachmentIds: ['attachment'] }, 'owner')).rejects.toThrow('附件无效或已被使用')
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
    expect(serviceCalls).toMatchSnapshot()
  })

  it('编号唯一键冲突重跑完整事务，其他错误直接向上传播', async () => {
    method('release.create').mockRejectedValueOnce({ code: 'P2002', meta: { target: 'releaseNo' } })
    const result = await releases.createRelease({ type: 'DRAWING', workOrderNumber: 'WO', description: '说明', userIds: ['owner'] }, 'owner')
    expect(result.releaseNo).toBe(rel.releaseNo)
    expect(serviceCalls.filter(call => String(call[0]).startsWith('transaction.'))).toEqual([['transaction.begin'], ['transaction.rollback'], ['transaction.begin'], ['transaction.commit']])
    method('release.findMany').mockRejectedValueOnce(new Error('read failed'))
    await expect(releases.listReleases({}, 'owner')).rejects.toThrow('read failed')
  })
})
