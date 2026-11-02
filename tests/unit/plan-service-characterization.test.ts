import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'
import type { RoleContext } from '../../server/services/auth/permissions'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/flow/names', () => ({
  MODE_TEXT: { SELF: '自制', EXTERNAL_OUTSOURCE: '外协' },
  loadNames: vi.fn(async () => ({ user: new Map([['owner', '负责人']]), process: new Map([['process', '车削']]), supplier: new Map() })),
}))
vi.mock('../../server/services/kitting/kitting', () => ({ NODE_LINKS: { parts: { select: { partId: true } }, purchases: { select: { purchaseLineId: true } } }, loadKitCounts: vi.fn(async () => new Map([['kit', { total: 2, ready: 1 }]])) }))

import * as plan from '../../server/services/plan/plan'
const now = new Date('2026-11-01T04:00:00Z')
const d = (value: string) => new Date(`${value}T00:00:00Z`)
const ctx: RoleContext = { userId: 'owner', isAdmin: false, roles: [], deptHeadOf: [], businessDept: null, pmOf: new Set() }
const node = (id = 'n1', fields = {}) => ({
  id, workOrderNumber: 'WO 1', seq: 1, name: '节点', dept: 'TECH', planDate: d('2026-11-02'), startDate: null,
  baselineDate: null, parentId: null, phase: '设计', customDeps: false, actualDate: null, manualDoneAt: null,
  manualDoneBy: null, confirmStatus: 'PENDING', confirmedBy: null, confirmedAt: null, rejectReason: null,
  note: null, createdAt: now, ...fields,
})
const n = node()

beforeEach(() => {
  resetServiceDb()
  vi.useFakeTimers(); vi.setSystemTime(now)
  returns('alert.updateMany', { count: 1 })
  returns('todo.updateMany', { count: 1 })
  returns('todo.createMany', { count: 1 })
  returns('workOrderPlan.findMany', [{ workOrderNumber: 'WO 1', status: 'PUBLISHED', publishedAt: now }])
  returns('workOrderPlan.findUnique', { status: 'PUBLISHED', publishedAt: now, publishedBy: 'owner', templateName: '模板' })
  returns('workOrderPlan.findUniqueOrThrow', { status: 'PUBLISHED' })
  returns('workOrderPlan.upsert', {})
  returns('workOrderPlan.update', {})
  returns('qmsWorkOrder.findFirst', { workOrderNumber: 'WO 1', deliveryDate: d('2026-11-03') })
  returns('qmsWorkOrder.findUnique', { projectName: '项目', customerName: '客户' })
  returns('qmsWorkOrder.findMany', [{ workOrderNumber: 'WO 1', deliveryDate: d('2026-11-03') }])
  returns('planNode.findMany', [n])
  returns('planNode.findUnique', n)
  returns('planNode.findUniqueOrThrow', n)
  returns('planNode.update', n)
  returns('planNode.updateMany', { count: 1 })
  returns('planNode.count', 0)
  returns('planNodeDep.findMany', [])
  for (const model of ['drawingTask', 'purchaseLine', 'routeStep', 'assemblyNode', 'planTask', 'planChangeLog', 'alert']) returns(`${model}.findMany`, [])
  for (const model of ['drawingTask', 'purchaseLine', 'routeStep', 'assemblyNode']) returns(`${model}.count`, 1)
  returns('workOrderExt.findUnique', { projectManagerId: 'owner' })
  returns('todo.findMany', [{ refId: 'n1' }])
  returns('notifyRole.findMany', [{ userId: 'head' }, { userId: 'head' }])
  returns('$queryRaw', [{ id: 'n1' }])
})
afterEach(() => vi.useRealTimers())

describe('plan service 搬移前特征', () => {
  it('五种任务、层级排序、预测与完整展示 DTO（含权限与预警）', async () => {
    returns('planNode.findMany', [node('n2', { seq: 2, dept: 'PRODUCTION', planDate: d('2026-11-03'), parentId: 'n1', customDeps: true }), n])
    returns('planNodeDep.findMany', [{ nodeId: 'n2', predId: 'n1' }])
    returns('drawingTask.findMany', [{ id: 'drawing', planNodeId: 'n1', componentName: '图纸', status: 'DRAWN', planDate: d('2026-11-01'), drawnDate: d('2026-10-31'), needsCustomerConfirm: true, customerPlanDate: d('2026-11-04'), customerConfirmedDate: null, materialStatus: 'NOT_STARTED', processStatus: 'NONE' }])
    returns('purchaseLine.findMany', [{ id: 'purchase', planNodeId: 'n2', materialName: '钢板', spec: '10mm', status: 'OPEN', needDate: d('2026-11-03'), promisedDate: d('2026-11-05'), arrivedDate: null }])
    returns('routeStep.findMany', [{ id: 'step', planNodeId: 'n2', part: { name: '工件' }, processId: 'process', mode: 'EXTERNAL_OUTSOURCE', status: 'OUT', dueDate: d('2026-11-03'), promisedReturnDate: d('2026-11-04'), finishedAt: null }])
    returns('assemblyNode.findMany', [{ id: 'kit', planNodeId: 'n2', name: '装配', needDate: d('2026-11-02') }])
    returns('planTask.findMany', [{ id: 'task', planNodeId: 'n2', workOrderNumber: 'WO 1', name: '其他任务', ownerId: 'owner', note: '备注', planDate: d('2026-11-02'), doneDate: null }])
    returns('planChangeLog.findMany', [{ id: 'log', nodeId: 'n2', nodeName: '节点', kind: 'DATE', oldDate: d('2026-11-02'), newDate: d('2026-11-03'), reason: '调整', actorId: 'owner', createdAt: now }])
    returns('alert.findMany', [{ activeKey: 'W9:plan:WO 1', level: 'RED' }, { activeKey: 'W9:planConfirm:n1', level: 'YELLOW' }])
    const loaded = await plan.loadPlans({ workOrderNumbers: ['WO 1'] }, now)
    const result = await plan.getPlan('WO 1', ctx, now)
    expect({ loaded, result, calls: serviceCalls }).toMatchSnapshot()
  })

  it('publishedOnly 的空集合直接返回；工单缺失先报错', async () => {
    returns('workOrderPlan.findMany', [])
    expect(await plan.loadPlans({ workOrderNumbers: ['WO 1'], publishedOnly: true }, now)).toEqual(new Map())
    returns('qmsWorkOrder.findUnique', null)
    await expect(plan.getPlan('missing', ctx, now)).rejects.toThrow('工单不存在')
    expect(serviceCalls).toMatchSnapshot()
  })

  it('发布：先锁计划、逐节点锁基线与发送确认、最后发布；汇总节点跳过确认', async () => {
    returns('workOrderPlan.findUniqueOrThrow', { status: 'DRAFT' })
    returns('planNode.findMany', [n, node('n2', { parentId: 'n1' })])
    expect({ result: await plan.publishPlan('WO 1', 'actor'), calls: serviceCalls }).toMatchSnapshot()
  })

  it('已发布节点改日期：锁、校验、写日志、重新确认、汇总、清除延误预警', async () => {
    returns('planChangeLog.create', {})
    returns('planNode.update', node('n1', { planDate: d('2026-11-04') }))
    expect({ result: await plan.updateNode('n1', { planDate: d('2026-11-04'), reason: '  调整  ' }, 'actor'), calls: serviceCalls }).toMatchSnapshot()
  })

  it('模板生成：取消旧任务、逐节点创建、连接前置和上级、汇总后查环', async () => {
    returns('workOrderPlan.findUniqueOrThrow', { status: 'DRAFT' })
    returns('planTemplate.findUnique', { name: '模板', nodes: [{ seq: 1, name: 'A', dept: 'TECH', daysBeforeDelivery: 2, durationDays: 2, predSeqs: [], parentSeq: null, phase: '设计' }, { seq: 2, name: 'B', dept: 'TECH', daysBeforeDelivery: 1, durationDays: null, predSeqs: [1], parentSeq: 1, phase: null }] })
    returns('planNode.deleteMany', { count: 2 })
    returns('planNode.create', n)
    method('planNode.create').mockImplementationOnce(async (...args) => { serviceCalls.push(['planNode.create', ...args]); return { id: 'new1' } })
    returns('planNodeDep.createMany', { count: 1 })
    expect({ result: await plan.generateFromTemplate('WO 1', 'tpl', 'actor'), calls: serviceCalls }).toMatchSnapshot()
  })

  it.each(['create', 'delete', 'confirm', 'reject', 'complete', 'undo'] as const)('%s 命令的完整副作用顺序', async (action) => {
    returns('planNode.create', n)
    returns('planNode.delete', n)
    returns('planChangeLog.create', {})
    returns('planNode.aggregate', { _max: { seq: 1 } })
    returns('reminder.createMany', { count: 1 })
    returns('planNode.findMany', [])
    const operations = {
      create: () => plan.createNode('WO 1', { name: ' 新节点 ', dept: 'TECH', planDate: d('2026-11-04'), reason: '新增' }, 'actor'),
      delete: () => plan.deleteNode('n1', '删除', 'actor'),
      confirm: () => plan.confirmNode('n1', 'actor'),
      reject: () => plan.rejectNode('n1', '  原因  ', 'actor'),
      complete: () => plan.completeNode('n1', null, 'actor', now),
      undo: () => plan.undoCompleteNode('n1'),
    }
    if (action === 'undo') returns('planNode.findUniqueOrThrow', node('n1', { manualDoneAt: now }))
    expect({ result: await operations[action](), calls: serviceCalls }).toMatchSnapshot()
  })

  it('错误校验顺序：调整原因先于开始日和父节点；未来完成日先于查子节点', async () => {
    await expect(plan.createNode('WO 1', { name: '节点', dept: 'TECH', planDate: d('2026-11-02'), startDate: d('2026-11-04'), parentId: 'missing' }, 'actor')).rejects.toThrow('总计划已发布，加节点要写调整原因')
    await expect(plan.completeNode('n1', d('2026-11-02'), 'actor', now)).rejects.toThrow('完成日期不能晚于今天')
    expect(serviceCalls).toMatchSnapshot()
  })
})
