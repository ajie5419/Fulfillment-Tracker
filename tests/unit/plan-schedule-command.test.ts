import { beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls } from '../helpers/service-db'
import { parseDay } from '../../shared/dates'
import type { ScheduleNode } from '../../server/services/plan/schedule'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/plan/schedule-preview', async (original) => ({ ...await original<object>(), scheduleSnapshot: vi.fn() }))
import { scheduleSnapshot } from '../../server/services/plan/schedule-preview'
import { updateNode } from '../../server/services/plan/commands'

const row = { id: 'a', workOrderNumber: 'WO', name: '采购计划', dept: 'TECH', parentId: null, phase: null, seq: 1, planDate: parseDay('2026-11-05'), startDate: parseDay('2026-11-01') }
let snapshot: ScheduleNode[]
let published = false
const input = { planDate: parseDay('2026-11-10'), linkedDates: true }
beforeEach(() => {
  resetServiceDb()
  published = false
  snapshot = [
    { id: 'a', name: '采购计划', parent: null, preds: [], start: '2026-11-01', finish: '2026-11-05', done: false },
    { id: 'b', name: '采购及复验', parent: null, preds: ['a'], start: '2026-11-06', finish: '2026-11-08', done: false },
  ]
  vi.mocked(scheduleSnapshot).mockImplementation(async () => {
    const candidate = method('planNode.update').mock.calls.length > 0
    return { nodes: snapshot.map((n) => ({ ...n, ...(candidate && n.id === 'a' ? { finish: '2026-11-10' } : {}) })), version: { nodes: [], tasks: [], deps: [], status: published ? 'PUBLISHED' : 'DRAFT' } }
  })
  returns('planNode.findUnique', row)
  returns('workOrderPlan.upsert', {})
  method('workOrderPlan.findUniqueOrThrow').mockImplementation(async () => ({ status: published ? 'PUBLISHED' : 'DRAFT' }))
  returns('$queryRaw', [])
  returns('planNode.count', 0)
  returns('planNode.update', { ...row, planDate: input.planDate })
  returns('planNode.findMany', [{ id: 'a' }, { id: 'b' }])
  returns('planChangeLog.create', {})
  returns('notifyRole.findMany', [{ userId: 'head' }])
  returns('todo.createMany', { count: 1 })
  returns('todo.updateMany', { count: 1 })
  returns('alert.updateMany', { count: 1 })
})

describe('linked date command transaction', () => {
  it('rolls back previews without notifications or audit writes, then applies the exact preview', async () => {
    const preview = (await updateNode('a', { ...input, preview: true }, 'pm')).preview!
    expect(preview.changes).toHaveLength(2)
    expect(preview.changes[1]).toMatchObject({ start: '2026-11-11', finish: '2026-11-13' })
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
    expect(method('todo.createMany')).not.toHaveBeenCalled()
    expect(method('planChangeLog.create')).not.toHaveBeenCalled()
    method('planNode.update').mockClear()
    await updateNode('a', { ...input, previewToken: preview.token }, 'pm')
    expect(method('planNode.update')).toHaveBeenCalledWith({ where: { id: 'b' }, data: { startDate: parseDay('2026-11-11'), planDate: parseDay('2026-11-13') } })
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })
  it('rejects absent or stale preview tokens and rolls back the initiating edit', async () => {
    await expect(updateNode('a', input, 'pm')).rejects.toThrow('重新预览')
    expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
    method('planNode.update').mockClear()
    const preview = (await updateNode('a', { ...input, preview: true }, 'pm')).preview!
    method('planNode.update').mockClear()
    snapshot[1]!.finish = '2026-11-09'
    await expect(updateNode('a', { ...input, previewToken: preview.token }, 'pm')).rejects.toThrow('重新预览')
    expect(method('todo.createMany')).not.toHaveBeenCalled()
  })
  it('requires a published reason and logs both dates without truncating it', async () => {
    published = true
    await expect(updateNode('a', { ...input, preview: true }, 'pm')).rejects.toThrow('原因')
    const reason = 'r'.repeat(500)
    const preview = (await updateNode('a', { ...input, reason, preview: true }, 'pm')).preview!
    method('planNode.update').mockClear()
    const result = await updateNode('a', { ...input, reason, previewToken: preview.token }, 'pm')
    expect(result.reconfirm).toBe(true)
    expect(method('planChangeLog.create').mock.calls.map(([arg]) => [arg.data.nodeId, arg.data.kind, arg.data.reason])).toEqual([
      ['b', 'DATE', reason], ['b', 'START', reason], ['a', 'DATE', reason],
    ])
    expect(method('todo.createMany')).toHaveBeenCalledTimes(2)
  })
})
