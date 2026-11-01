import { describe, expect, it, vi } from 'vitest'
import { canSee, resolveScope, scopeWorkOrders } from '../../server/utils/auth'

describe('可见范围搬移前现状', () => {
  it.each([
    { name: '管理员', admin: true, role: false, managed: ['WO'], all: true },
    { name: '有任意通知角色', admin: false, role: true, managed: ['WO'], all: true },
    { name: '普通用户', admin: false, role: false, managed: [], all: true },
    { name: '纯项目经理', admin: false, role: false, managed: ['WO', 'OTHER', 'WO'], all: false },
  ])('$name', async ({ admin, role, managed, all }) => {
    const db = {
      notifyRole: { findFirst: vi.fn(async () => role ? { id: 'role' } : null) },
      workOrderExt: { findMany: vi.fn(async () => managed.map(workOrderNumber => ({ workOrderNumber }))) },
    }
    const scope = await resolveScope('u', admin, db as never)
    expect(scope.all).toBe(all)
    expect(canSee(scope, null)).toBe(true)
    expect(canSee(scope, 'WO')).toBe(true)
    expect(canSee(scope, 'HIDDEN')).toBe(all)
    expect(scopeWorkOrders(scope)).toEqual(all ? undefined : ['WO', 'OTHER'])
    expect(db.notifyRole.findFirst).toHaveBeenCalledTimes(admin ? 0 : 1)
    if (!admin) expect(db.workOrderExt.findMany).toHaveBeenCalledWith({ where: { projectManagerId: 'u' }, select: { workOrderNumber: true } })
  })
})
