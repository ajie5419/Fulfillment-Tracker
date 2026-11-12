import { beforeEach, expect, it, vi } from 'vitest'
const findMany = vi.fn()
vi.mock('../../server/utils/prisma', () => ({ prisma: { planNode: { findMany: (...args: unknown[]) => findMany(...args) } } }))
import { planNodeLabels } from '../../server/services/plan/links'

beforeEach(() => findMany.mockReset())
it('uses the full work-order hierarchy for a filtered child and keeps work orders independent', async () => {
  findMany.mockResolvedValueOnce([{ workOrderNumber: 'A' }, { workOrderNumber: 'B' }]).mockResolvedValueOnce([
    { id: 'a1', seq: 1, name: '开工', workOrderNumber: 'A', parentId: null, phase: '开工' },
    { id: 'b1', seq: 1, name: '设计', workOrderNumber: 'B', parentId: null, phase: '设计' },
    { id: 'a2', seq: 2, name: '结构图', workOrderNumber: 'A', parentId: null, phase: '设计' },
    { id: 'a3', seq: 3, name: '采购图', workOrderNumber: 'A', parentId: null, phase: '设计' },
    { id: 'a26', seq: 26, name: '减速机', workOrderNumber: 'A', parentId: 'a3', phase: '设计' },
  ])
  const labels = await planNodeLabels(['a26', 'b1'])
  expect([...labels.keys()].sort()).toEqual(['a26', 'b1'])
  expect(labels.get('a26')).toMatchObject({ seq: 26, code: '2.2.1' })
  expect(labels.get('b1')).toMatchObject({ code: '1.1' })
})
it('does not query when there are no linked nodes', async () => {
  expect((await planNodeLabels([null])).size).toBe(0)
  expect(findMany).not.toHaveBeenCalled()
})
