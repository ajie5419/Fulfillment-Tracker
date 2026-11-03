import { beforeEach, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
import { completeNode } from '../../server/services/plan/commands'

const now = new Date('2026-11-02T04:00:00Z')
const node = { id: 'parent', workOrderNumber: 'WO', manualDoneAt: null }
beforeEach(() => {
  resetServiceDb()
  returns('planNode.findUnique', node)
  returns('planNode.findUniqueOrThrow', node)
  returns('workOrderPlan.upsert', {})
  returns('workOrderPlan.findUniqueOrThrow', { status: 'DRAFT' })
  returns('workOrderPlan.findUnique', { status: 'DRAFT' })
  returns('$queryRaw', [{ id: 'parent' }])
  returns('planNode.update', node)
  returns('alert.updateMany', { count: 0 })
  returns('planNode.findMany', [])
})

it('先锁计划再锁节点，锁后重读子节点，新增未完成子节点必须拦截', async () => {
  let planLocked = false
  method('$queryRaw').mockImplementation(async (sql: TemplateStringsArray) => {
    serviceCalls.push(['lock', sql.join('?')])
    if (sql.join('').includes('work_order_plan')) planLocked = true
    return [{ id: 'parent' }]
  })
  method('planNode.findMany').mockImplementation(async ({ where }) => {
    serviceCalls.push(['read.children', planLocked])
    if (!planLocked) return [] // 模拟锁前无子节点，等待计划锁期间新增一个
    if (where.parentId) return [{ id: 'new-child', name: '新子节点', workOrderNumber: 'WO' }]
    return [{ ...node, planDate: now, parentId: null }, { id: 'new-child', workOrderNumber: 'WO', name: '新子节点', parentId: 'parent', planDate: now }]
  })
  returns('workOrderPlan.findMany', [])
  returns('qmsWorkOrder.findMany', [{ workOrderNumber: 'WO', deliveryDate: now }])
  for (const model of ['drawingTask', 'purchaseLine', 'routeStep', 'assemblyNode', 'planTask', 'planNodeDep']) returns(`${model}.findMany`, [])
  await expect(completeNode('parent', null, 'actor', now)).rejects.toThrow('还有子节点没完成：新子节点')
  expect(serviceCalls.filter(([kind]) => kind === 'lock').map(([, sql]) => sql)).toEqual([
    expect.stringContaining('work_order_plan'), expect.stringContaining('plan_node'),
  ])
  expect(serviceCalls.filter(([kind]) => kind === 'read.children').every(([, locked]) => locked)).toBe(true)
  expect(method('planNode.update')).not.toHaveBeenCalled()
  expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
})

it('没有子节点时也必须在计划锁之后读取才能写完成', async () => {
  await completeNode('parent', null, 'actor', now)
  const lock = serviceCalls.findIndex(([name, sql]) => name === '$queryRaw' && String(sql).includes('work_order_plan'))
  const read = serviceCalls.findIndex(([name]) => name === 'planNode.findMany')
  expect(lock).toBeGreaterThan(-1)
  expect(read).toBeGreaterThan(lock)
  expect(method('planNode.update')).toHaveBeenCalledOnce()
})
