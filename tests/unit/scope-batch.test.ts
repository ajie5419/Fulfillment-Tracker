import { beforeEach, expect, it, vi } from 'vitest'
import { method, resetServiceDb, returns, serviceDb } from '../helpers/service-db'
import type { Prisma } from '@prisma/client'

vi.mock('../../server/utils/prisma', async () => ({ prisma: (await import('../helpers/service-db')).serviceDb }))
vi.mock('../../server/services/flow/names', () => ({ loadNames: async () => ({ user: new Map() }) }))
import { canSee, resolveScope, resolveScopes } from '../../server/services/auth/scope'
import { resolveStepResponsibles } from '../../server/services/flow/responsible'
import { addComment } from '../../server/services/comments/comments'

const db = serviceDb as Prisma.TransactionClient
const people = ['admin', 'role', 'pm', 'ordinary', 'role', 'pm']
const managed = [{ projectManagerId: 'pm', workOrderNumber: 'OWN' }, { projectManagerId: 'role', workOrderNumber: 'OTHER' }, { projectManagerId: 'admin', workOrderNumber: 'OTHER' }]
beforeEach(() => {
  resetServiceDb()
  method('notifyRole.findFirst').mockImplementation(async ({ where }) => where.userId === 'role' ? { id: 'r' } : null)
  returns('notifyRole.findMany', [{ userId: 'role' }])
  method('workOrderExt.findMany').mockImplementation(async ({ where }) => managed.filter((r) => typeof where.projectManagerId === 'string' ? r.projectManagerId === where.projectManagerId : where.projectManagerId.in.includes(r.projectManagerId)))
})

it('批量 scope 与逐人版本严格等价：管理员、任意角色、纯项目经理、普通用户和重复输入', async () => {
  const expected = await Promise.all(people.map((id) => resolveScope(id, id === 'admin', db)))
  method('workOrderExt.findMany').mockClear()
  const scopes = await resolveScopes(people, ['admin'], db)
  for (const [i, id] of people.entries()) {
    expect(scopes.get(id)).toEqual(expected[i])
    for (const wo of [null, 'OWN', 'OTHER', 'HIDDEN']) expect(canSee(scopes.get(id)!, wo)).toBe(canSee(expected[i]!, wo))
  }
  expect(method('notifyRole.findMany')).toHaveBeenCalledOnce()
  expect(method('workOrderExt.findMany')).toHaveBeenCalledOnce()
})

it('空批次和全管理员不查询数据库', async () => {
  expect(await resolveScopes([], [], db)).toEqual(new Map())
  expect(await resolveScopes(['admin'], ['admin'], db)).toEqual(new Map([['admin', { all: true }]]))
  expect(method('notifyRole.findMany')).not.toHaveBeenCalled()
  expect(method('workOrderExt.findMany')).not.toHaveBeenCalled()
})

it('同一批班组长与逐人可见判断一致，查询数固定', async () => {
  returns('teamLeader.findMany', people.map((userId, i) => ({ userId, supplierId: `team-${i}` })))
  const steps = people.map((_, i) => ({ ownerId: null, mode: 'SELF' as const, supplierId: `team-${i}`, workOrderNumber: 'HIDDEN' }))
  const single = await Promise.all(people.map(async (id) => canSee(await resolveScope(id, false, db), 'HIDDEN') ? id : null))
  method('workOrderExt.findMany').mockClear()
  expect(await resolveStepResponsibles(db, steps)).toEqual(single)
  expect(method('notifyRole.findMany')).toHaveBeenCalledOnce()
  expect(method('workOrderExt.findMany')).toHaveBeenCalledOnce()
})

it('@ 多人复用事务中的批量 scope；不可见者不能收提醒', async () => {
  returns('$queryRaw', [])
  returns('part.findUnique', { workOrderNumber: 'HIDDEN', name: '工件' })
  returns('qmsUser.count', 4)
  await expect(addComment({ refType: 'part', refId: 'part', body: '留言', mentionIds: people }, 'author', ['admin'])).rejects.toThrow('pm 看不到工单 HIDDEN')
  expect(method('notifyRole.findMany')).toHaveBeenCalledOnce()
  expect(method('workOrderExt.findMany')).toHaveBeenCalledOnce()
  expect(method('notifyRole.findFirst')).not.toHaveBeenCalled()
  expect(method('comment.create')).not.toHaveBeenCalled()
})
