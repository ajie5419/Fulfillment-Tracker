import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'
import { DEFAULT_THRESHOLDS, type ScanRule } from '../../server/services/alerts/rules'

const dependencies = vi.hoisted(() => ({ plans: vi.fn(), monitored: vi.fn(), closed: vi.fn(), lease: vi.fn() }))
vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/flow/flow', () => ({ ARRANGE_SEND: 'ARRANGE_SEND', ARRANGE_START: 'ARRANGE_START' }))
vi.mock('../../server/services/flow/responsible', () => ({ resolveStepResponsibles: async (_db: unknown, steps: unknown[]) => steps.map(() => 'owner') }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map([['owner', '负责人']]), process: new Map([['process', '车削']]), supplier: new Map([['supplier', '供应商']]) }) }))
vi.mock('../../server/services/auth/departments', async (original) => ({ ...await original<object>(), resolveDeptNames: async () => new Map([['dept', '技术部']]), userDeptNames: async () => new Map([['owner', '技术部']]) }))
vi.mock('../../server/services/kitting/kitting', () => ({ NODE_LINKS: {}, dueWindowWhere: () => ({ window: true }), incompleteWhere: () => ({ incomplete: true }), loadKitCounts: async () => new Map([['node', { total: 2, ready: 1 }]]) }))
vi.mock('../../server/services/plan/plan', () => ({ loadPlans: dependencies.plans }))
vi.mock('../../server/services/monitoring/status', () => ({ loadMonitoredEntities: dependencies.monitored }))
vi.mock('../../server/services/workorder/active', () => ({ closedWorkOrders: dependencies.closed }))
vi.mock('../../server/services/jobs/lease', () => ({ withLease: dependencies.lease }))
vi.mock('../../server/services/issues/issues', async () => {
  const { serviceDb } = await import('../helpers/service-db')
  return { issueTransaction: (run: (db: object) => Promise<unknown>) => Reflect.get(serviceDb, '$transaction')(run) }
})
vi.mock('../../server/services/issues/convert', () => ({ convertAlertInTx: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['convertAlertInTx', ...args]); return {} } }))

import { collectTargets, recipientsFor, scanRules } from '../../server/services/alerts/scan'

const now = new Date('2026-11-01T04:00:00Z')
const start = new Date('2026-10-20T00:00:00Z')
const step = { id: 'step', partId: 'part', part: { name: '工件', workOrderNumber: 'WO' }, seq: 2, processId: 'process', supplierId: 'supplier', mode: 'EXTERNAL_OUTSOURCE', status: 'OUT', promisedReturnDate: start, dueDate: start, holdClearedAt: null }
const release = { id: 'release', type: 'CHANGE', releaseNo: 'FF-1', version: 'A', issuerId: 'issuer', workOrderNumber: 'WO', createdAt: start }
const node = { id: 'node', name: '节点', dept: 'TECH', workOrderNumber: 'WO', planDate: start, needDate: start, createdAt: start, ownerId: null, confirmStatus: 'PENDING' }

beforeEach(() => {
  resetServiceDb()
  vi.useFakeTimers(); vi.setSystemTime(now)
  dependencies.plans.mockResolvedValue(new Map())
  dependencies.monitored.mockResolvedValue([])
  dependencies.closed.mockReset().mockResolvedValue(new Set())
  dependencies.lease.mockImplementation(async (_name, _ms, run) => ({ skipped: false, value: await run() }))
  for (const model of ['unmatchedInspection', 'routeStep', 'todo', 'issue', 'release', 'releaseReceipt', 'purchaseLine', 'drawingTask', 'assemblyNode', 'workOrderExt', 'alert', 'threshold', 'offDay']) returns(`${model}.findMany`, [])
  returns('notifyRole.findMany', [{ role: 'DEPT_HEAD', department: '技术部', userId: 'head' }, { role: 'PROJECT_DEPT_HEAD', userId: 'pdh' }, { role: 'LEADER', userId: 'leader' }, { role: 'FINANCE', userId: 'finance' }])
  returns('qmsWorkOrder.findMany', [{ workOrderNumber: 'WO' }])
})
afterEach(() => vi.useRealTimers())

describe('alerts scan 搬移前特征', () => {
  it.each(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11'] as ScanRule[])('%s 固定查询、命中集合、级别与完整文案', async (rule) => {
    returns('unmatchedInspection.findMany', [{ qmsInspectionId: 'inspection', createdAt: start }])
    returns('qmsInspection.findMany', [{ id: 'inspection', partName: '工件', processName: '车削', workOrderNumber: 'WO', supplierId: 'supplier' }])
    returns('todo.findMany', [{ refId: rule === 'W9' ? 'node' : rule === 'W5' ? 'release' : 'step', ownerId: 'owner', status: 'OPEN', createdAt: start }])
    returns('routeStep.findMany', [step])
    if (rule === 'W2') method('routeStep.findMany').mockImplementationOnce(async (...args) => { serviceCalls.push(['routeStep.findMany', ...args]); return [step] }).mockImplementationOnce(async (...args) => { serviceCalls.push(['routeStep.findMany', ...args]); return [{ ...step, id: 'previous', seq: 1, status: 'DONE' }] })
    returns('issueLog.findMany', [{ issue: { refId: 'previous' }, createdAt: new Date('2026-10-21') }])
    returns('issue.findMany', [{ id: 'issue', issueNo: 'YC-1', status: 'OPEN', category: 'DESIGN', workOrderNumber: 'WO', responsibleUserId: null, responsibleDeptId: 'dept', createdAt: start, dueDate: start }])
    returns('releaseReceipt.findMany', [{ id: 'receipt', userId: 'owner', createdAt: start, release }])
    returns('release.findMany', [release, { ...release, id: 'rejected' }])
    returns('routeStep.groupBy', [{ holdReleaseId: 'rejected', _count: { _all: 1 } }])
    returns('releaseReceipt.groupBy', [])
    returns('purchaseLine.findMany', [{ id: 'purchase', workOrderNumber: 'WO', materialName: '钢板', spec: '10mm', needDate: start, promisedDate: start, buyerId: null, delayReason: 'PAYMENT', payments: [{ payment: { status: 'ON_HOLD', blocksDelivery: true } }] }])
    returns('drawingTask.findMany', [{ id: 'drawing', workOrderNumber: 'WO', componentName: '设计图', status: 'PENDING', ownerId: null, planDate: start, drawnDate: null }])
    returns('assemblyNode.findMany', [node])
    returns('workOrderExt.findMany', [{ workOrderNumber: 'WO', projectManagerId: 'pm' }])
    dependencies.plans.mockResolvedValue(new Map([['WO', { workOrderNumber: 'WO', publishedAt: start, deliveryDay: '2026-10-21', nodes: [node], forecast: { expectedDelivery: '2026-11-01', deliveryDelayDays: 11, nodes: [{ id: 'node', source: true, done: false, selfDelayDays: 12, selfExpectedDay: '2026-11-01', selfDriver: 'today', delayDays: 12, expectedDay: '2026-11-01', taskCount: 0, children: [] }] } }]]))
    dependencies.monitored.mockResolvedValue([{ entityType: 'step', id: 'step', key: 'cycle', workOrderNumber: 'WO', ownerIds: ['owner'], deptNames: ['生产部'], since: start, level: 'RED', name: '工序', status: 'OUT', statusText: '在外加工', days: 12, link: '/parts', cycleKey: 'cycle' }])
    const result = await collectTargets(now, structuredClone(DEFAULT_THRESHOLDS), ['2026-10-25'], rule)
    expect({ result, calls: serviceCalls, closedInput: dependencies.closed.mock.calls }).toMatchSnapshot()
  })

  it('工单关闭后只保留 W1/W4，only 不传时按规则顺序合并', async () => {
    returns('unmatchedInspection.findMany', [{ qmsInspectionId: 'inspection', createdAt: start }])
    returns('qmsInspection.findMany', [{ id: 'inspection', workOrderNumber: 'WO' }])
    returns('issue.findMany', [{ id: 'issue', issueNo: 'YC-1', category: 'OTHER', workOrderNumber: 'WO', status: 'OPEN', createdAt: start, dueDate: null }])
    returns('routeStep.findMany', [step])
    dependencies.closed.mockResolvedValue(new Set(['WO']))
    expect((await collectTargets(now, DEFAULT_THRESHOLDS, [])).map(t => [t.rule, t.key])).toEqual([['W1', 'W1:unmatched:inspection'], ['W4', 'W4:issue:issue']])
  })

  it('通知阶梯保持去重与插入顺序', () => {
    const target = { ownerIds: ['owner', 'owner'], workOrderNumber: 'WO', watcherIds: ['watcher'], deptNames: ['技术部'] }
    const ctx = { roles: [{ id: 'head-role', role: 'DEPT_HEAD' as const, department: '技术部', userId: 'head' }, { id: 'pdh-role', role: 'PROJECT_DEPT_HEAD' as const, department: null, userId: 'pdh' }], deptOf: new Map<string, string>(), pmOf: new Map([['WO', 'pm']]) }
    expect(['REMIND', 'YELLOW', 'RED'].map(level => recipientsFor(level as 'REMIND' | 'YELLOW' | 'RED', target, ctx))).toEqual([['owner'], ['owner', 'watcher', 'head', 'pm'], ['owner', 'watcher', 'head', 'pm', 'pdh']])
  })

  it('执行器：创建、加锁、升级、提醒、转异常、清理按原序执行', async () => {
    returns('unmatchedInspection.findMany', [{ qmsInspectionId: 'new', createdAt: start }, { qmsInspectionId: 'old', createdAt: start }, { qmsInspectionId: 'converted', createdAt: start }])
    returns('qmsInspection.findMany', ['new', 'old', 'converted'].map(id => ({ id, workOrderNumber: 'WO' })))
    const existing = { id: 'old-alert', activeKey: 'W1:unmatched:old', status: 'ACTIVE', level: 'REMIND' }
    returns('alert.findMany', [existing, { id: 'converted-alert', activeKey: 'W1:unmatched:converted', status: 'CONVERTED' }, { id: 'gone', activeKey: 'gone', status: 'ACTIVE' }, { id: 'gone-converted', activeKey: 'gone-converted', status: 'CONVERTED' }])
    const created = { id: 'new-alert', status: 'ACTIVE', level: 'RED' }
    returns('alert.create', created)
    method('alert.findUnique').mockImplementation(async (...args: unknown[]) => { serviceCalls.push(['alert.findUnique', ...args]); return JSON.stringify(args).includes('new-alert') ? created : existing })
    returns('$queryRaw', [{ id: 'locked' }])
    returns('alert.update', { ...existing, level: 'RED' })
    returns('alert.updateMany', { count: 1 })
    returns('reminder.createMany', { count: 2 })
    expect({ result: await scanRules(now), calls: serviceCalls }).toMatchSnapshot()
  })

  it('租约未获得直接跳过；查询失败向上传播', async () => {
    dependencies.lease.mockResolvedValueOnce({ skipped: true })
    expect(await scanRules(now)).toEqual({ skipped: true, created: 0, escalated: 0, cleared: 0, reminders: 0, active: 0, converted: 0 })
    expect(serviceCalls).toEqual([])
    method('unmatchedInspection.findMany').mockRejectedValue(new Error('read failed'))
    await expect(scanRules(now)).rejects.toThrow('read failed')
  })
})
