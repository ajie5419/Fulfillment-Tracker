import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceCalls, serviceDb } from '../helpers/service-db'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/drawings/drawings', async original => ({
  ...await original<typeof import('../../server/services/drawings/drawings')>(),
  settleTask: vi.fn(async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['settleTask', ...args]) }),
}))
vi.mock('../../server/services/process/process', () => ({
  markRevisingByVoid: vi.fn(async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['markRevisingByVoid', ...args]) }),
}))
vi.mock('../../server/services/purchases/purchases', () => ({
  purchaseTx: vi.fn(),
  lockParts: async (_tx: unknown, ...args: unknown[]) => { serviceCalls.push(['lockParts', ...args]) },
  refreshPartReady: vi.fn(),
}))

import { lockTask, settleTask } from '../../server/services/drawings/drawings'
import { FlowError } from '../../server/services/flow/errors'
import { markRevisingByVoid } from '../../server/services/process/process'
import { voidRelease } from '../../server/services/releases/commands'

const now = new Date('2026-11-01T04:00:00Z')
const actor = { userId: 'issuer', isAdmin: false }
const release = { id: 'release', releaseNo: 'FF-261101-001', type: 'DRAWING', status: 'ACTIVE', issuerId: actor.userId, drawingTaskId: 'task' }
const task = { id: 'task', status: 'DONE', parts: [{ partId: 'part' }] }

beforeEach(() => {
  resetServiceDb()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(now)
  returns('release.findUnique', { drawingTaskId: 'task' })
  returns('release.findUniqueOrThrow', release)
  returns('releaseReceipt.findMany', [{ id: 'pending-receipt' }])
  returns('releaseReceipt.updateMany', { count: 1 })
  returns('todo.updateMany', { count: 1 })
  returns('alert.updateMany', { count: 1 })
  returns('routeStep.findMany', [])
  returns('release.update', { ...release, status: 'VOID' })
  returns('drawingTaskPart.findMany', [{ partId: 'part' }])
  returns('drawingTask.findUniqueOrThrow', task)
  returns('$queryRaw', [{ id: 'task' }])
})
afterEach(() => vi.useRealTimers())

function expectNoVoidWrites() {
  for (const name of ['releaseReceipt.updateMany', 'todo.updateMany', 'alert.updateMany', 'routeStep.updateMany', 'release.update']) {
    expect(method(name), name).not.toHaveBeenCalled()
  }
  expect(markRevisingByVoid).not.toHaveBeenCalled()
  expect(settleTask).not.toHaveBeenCalled()
  expect(serviceCalls.at(-1)).toEqual(['transaction.rollback'])
  expect(serviceCalls.some(call => call[0] === 'transaction.commit')).toBe(false)
}

describe('发放单作废：只容忍关联设计任务确实不存在', () => {
  it('任务锁查询为空时仍完成作废，不回打工艺、不重算任务', async () => {
    method('$queryRaw').mockResolvedValueOnce([])

    await expect(voidRelease('release', actor)).resolves.toEqual({ cancelled: 1, holdsCleared: 0 })

    expect(method('releaseReceipt.updateMany')).toHaveBeenCalledWith({ where: { id: { in: ['pending-receipt'] } }, data: { status: 'CANCELLED', actedAt: now } })
    expect(method('release.update')).toHaveBeenCalledWith({ where: { id: 'release' }, data: { status: 'VOID' } })
    expect(markRevisingByVoid).not.toHaveBeenCalled()
    expect(settleTask).not.toHaveBeenCalled()
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })

  it.each([
    ['锁等待失败', new Error('Lock wait timeout exceeded')],
    ['数据库查询失败', Object.assign(new Error('Query failed'), { code: 'P2010' })],
    ['同文案的其他领域错误', new FlowError('设计任务不存在')],
    ['其他对象的 NOT_FOUND', new FlowError('其他对象不存在', 'NOT_FOUND')],
  ])('%s 原样向上传播并回滚，不执行作废写入', async (_label, failure) => {
    method('$queryRaw').mockRejectedValueOnce(failure)

    await expect(voidRelease('release', actor)).rejects.toBe(failure)

    expect(method('release.findUniqueOrThrow')).not.toHaveBeenCalled()
    expectNoVoidWrites()
  })

  it('锁任务前读取关联工件失败也回滚，不执行作废写入', async () => {
    const failure = new Error('Connection closed')
    method('drawingTaskPart.findMany').mockRejectedValueOnce(failure)

    await expect(voidRelease('release', actor)).rejects.toBe(failure)

    expect(method('$queryRaw')).not.toHaveBeenCalled()
    expectNoVoidWrites()
  })

  it('没有关联任务时不锁任务，照常作废且不重算', async () => {
    returns('release.findUnique', { drawingTaskId: null })
    returns('release.findUniqueOrThrow', { ...release, drawingTaskId: null })

    await expect(voidRelease('release', actor)).resolves.toEqual({ cancelled: 1, holdsCleared: 0 })

    expect(method('drawingTaskPart.findMany')).not.toHaveBeenCalled()
    expect(method('release.update')).toHaveBeenCalledWith({ where: { id: 'release' }, data: { status: 'VOID' } })
    expect(markRevisingByVoid).not.toHaveBeenCalled()
    expect(settleTask).not.toHaveBeenCalled()
    expect(serviceCalls[1]).toEqual(['transaction.begin'])
    expect(serviceCalls.at(-1)).toEqual(['transaction.commit'])
  })

  it('锁任务成功时保持先作废、再回打工艺、再重算任务的顺序', async () => {
    await expect(voidRelease('release', actor)).resolves.toEqual({ cancelled: 1, holdsCleared: 0 })

    expect(markRevisingByVoid).toHaveBeenCalledTimes(1)
    expect(vi.mocked(markRevisingByVoid).mock.calls[0]?.[0]).toBe(serviceDb)
    expect(vi.mocked(markRevisingByVoid).mock.calls[0]?.slice(1)).toEqual([task, release, actor.userId, now])
    expect(settleTask).toHaveBeenCalledTimes(1)
    expect(vi.mocked(settleTask).mock.calls[0]?.[0]).toBe(serviceDb)
    expect(vi.mocked(settleTask).mock.calls[0]?.slice(1)).toEqual([{ status: 'DONE', partIds: ['part'] }, 'task'])
    const effects = serviceCalls.map(call => call[0]).filter(name => ['release.update', 'markRevisingByVoid', 'settleTask', 'transaction.commit'].includes(String(name)))
    expect(effects).toEqual(['release.update', 'markRevisingByVoid', 'settleTask', 'transaction.commit'])
    expect(serviceCalls[1]).toEqual(['transaction.begin', { isolationLevel: 'ReadCommitted' }])
  })

  it('lockTask 的不存在错误仍是无 code 的 FlowError，保持其他调用方的旧错误映射', async () => {
    returns('$queryRaw', [])
    const failure = await lockTask(serviceDb as Prisma.TransactionClient, 'missing').catch(error => error)

    expect(failure).toBeInstanceOf(FlowError)
    expect(failure).toMatchObject({ name: 'FlowError', message: '设计任务不存在' })
    expect(failure.code).toBeUndefined()
  })
})
