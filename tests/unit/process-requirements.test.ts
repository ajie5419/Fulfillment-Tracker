import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls, serviceDb } from '../helpers/service-db'

vi.mock('../../server/services/purchases/purchases', () => ({
  lockParts: vi.fn(async (_tx, ids) => { serviceCalls.push(['lockParts', ids]) }),
  refreshPartReady: vi.fn(async (_tx, id, create) => { serviceCalls.push(['refreshPartReady', id, create]) }),
}))
import { lockProcessRequirementWork, settleProcessRequirementWork } from '../../server/services/process/requirements'
import { refreshPartReady } from '../../server/services/purchases/purchases'

const tx = serviceDb as Prisma.TransactionClient
const now = new Date('2026-11-10T08:00:00Z')
beforeEach(() => {
  resetServiceDb()
  vi.useFakeTimers()
  vi.setSystemTime(now)
  returns('$queryRaw', [])
  returns('drawingTask.update', {})
  returns('processDocLog.create', {})
  returns('processDocLog.findMany', [])
  returns('reminder.updateMany', { count: 1 })
})
afterEach(() => vi.useRealTimers())

describe('process requirement lifecycle', () => {
  it('returns only newly sent ready notices, excluding revocations and unchanged parts', async () => {
    expect(await settleProcessRequirementWork(tx, { taskIds: [], partIds: [] }, 'editor')).toBe(0)
    vi.mocked(refreshPartReady).mockResolvedValueOnce('sent').mockResolvedValueOnce('revoked').mockResolvedValueOnce(null).mockResolvedValueOnce('sent')
    expect(await settleProcessRequirementWork(tx, { taskIds: [], partIds: ['a', 'b', 'c', 'd'] }, 'editor')).toBe(2)
  })

  it('locks all nodes and tasks before template deletion but settles only changed requirements', async () => {
    returns('drawingTask.findMany', [
      { id: 'task-t', planNodeId: 'enabled', parts: [{ partId: 'part-t' }] },
      { id: 'task-f', planNodeId: 'disabled', parts: [{ partId: 'part-f' }] },
    ])
    const work = await lockProcessRequirementWork(tx, ['enabled', 'disabled'], ['disabled'])
    expect(work).toEqual({ taskIds: ['task-f'], partIds: ['part-f'] })
    expect(serviceCalls.map(call => call[0])).toEqual(['drawingTask.findMany', 'lockParts', '$queryRaw', '$queryRaw', 'drawingTask.findMany'])
    expect(serviceCalls[1]).toEqual(['lockParts', ['part-f', 'part-t']])
    const sql = method('$queryRaw').mock.calls.map(call => call[0].join('?'))
    expect(sql[0]).toContain('FROM drawing_task')
    expect(sql[1]).toContain('FROM plan_node')
    expect(method('$queryRaw').mock.calls[0]?.[1].values).toEqual(['task-f', 'task-t'])
  })

  it('rejects new links discovered after locking instead of acquiring another part lock out of order', async () => {
    method('drawingTask.findMany')
      .mockResolvedValueOnce([{ id: 'task', planNodeId: 'node', parts: [] }])
      .mockResolvedValueOnce([{ id: 'task', planNodeId: 'node', parts: [{ partId: 'added-part' }] }])
    await expect(lockProcessRequirementWork(tx, ['node'])).rejects.toThrow('节点关联任务已变化')
    expect(serviceCalls.filter(call => call[0] === 'lockParts')).toEqual([['lockParts', []]])
  })

  it('reopens issued documents for review before recalculating ready notices and retains history', async () => {
    returns('drawingTask.findMany', [{ id: 'task', materialStatus: 'ISSUED', processStatus: 'ISSUED' }])
    await settleProcessRequirementWork(tx, { taskIds: ['task'], partIds: ['part'] }, 'editor', true)
    expect(method('drawingTask.update').mock.calls.map(call => call[0].data)).toEqual([
      { materialStatus: 'REVISING', materialAt: now, materialBy: 'editor' },
      { processStatus: 'REVISING', processAt: now, processBy: 'editor' },
    ])
    expect(method('processDocLog.create').mock.calls.map(call => call[0].data)).toEqual(['MATERIAL', 'PROCESS'].map(kind => ({
      taskId: 'task', kind, fromStatus: 'ISSUED', toStatus: 'REVISING', note: '重新启用工艺处理，原已下发文档需复核', actorId: 'editor', createdAt: now,
    })))
    expect(serviceCalls.findIndex(call => call[0] === 'refreshPartReady')).toBeGreaterThan(serviceCalls.findLastIndex(call => call[0] === 'processDocLog.create'))
    expect(method('processDocLog.deleteMany')).not.toHaveBeenCalled()
  })

  it('does not invent document states for tasks without issued documents', async () => {
    returns('drawingTask.findMany', [])
    await settleProcessRequirementWork(tx, { taskIds: ['task'], partIds: [] }, 'editor', true)
    expect(method('drawingTask.findMany')).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ materialStatus: 'ISSUED' }, { processStatus: 'ISSUED' }] }) }))
    expect(method('drawingTask.update')).not.toHaveBeenCalled()
    expect(method('processDocLog.create')).not.toHaveBeenCalled()
  })

  it.each(['B', null])('only restores the latest revision release %s and keeps historical A retired', async (currentRelease) => {
    method('drawingTask.findMany')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ componentName: '当前复核任务', processLogs: [{ releaseId: currentRelease, toStatus: 'REVISING' }] }])
    returns('processDocLog.findMany', [{ releaseId: 'A' }, { releaseId: 'B' }])
    method('release.findUnique').mockImplementation(async ({ where }) => ({ id: where.id, releaseNo: where.id, workOrderNumber: 'WO' }))
    await settleProcessRequirementWork(tx, { taskIds: ['task'], partIds: [] }, 'editor', true)
    const updates = method('reminder.updateMany').mock.calls.map(call => call[0])
    expect(updates.find(update => update.where.dedupeKey.startsWith === 'PROCESS_REVISE:A:')).toEqual({
      where: { kind: 'PROCESS', dedupeKey: { startsWith: 'PROCESS_REVISE:A:' }, readAt: null }, data: { readAt: now },
    })
    const latest = updates.find(update => update.where.dedupeKey.startsWith === 'PROCESS_REVISE:B:')
    expect(latest.data.readAt).toEqual(currentRelease ? null : now)
    expect(method('reminder.createMany')).not.toHaveBeenCalled()
    expect(method('drawingTask.findMany').mock.calls[1]?.[0].select.processLogs).toMatchObject({
      where: { kind: 'MATERIAL' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1,
    })
  })
})
