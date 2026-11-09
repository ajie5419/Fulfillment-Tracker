import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { getTestDatabaseUrl } from '../helpers/test-database'
import { parseDay } from '../../shared/dates'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
describe.skipIf(!DB)('isolated demo identity and missing plan delivery', () => {
  let db: PrismaClient
  let repair: typeof import('../../server/services/dev/repair-isolated-demo').repairIsolatedDemo
  let reset: typeof import('../../server/services/dev/demo').resetDemo
  let plan: typeof import('../../server/services/plan/plan')
  const wo = 'DEMO-IDENTITY-TEST'
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    repair = (await import('../../server/services/dev/repair-isolated-demo')).repairIsolatedDemo
    reset = (await import('../../server/services/dev/demo')).resetDemo
    plan = await import('../../server/services/plan/plan')
  })
  afterAll(async () => { await db?.$disconnect() })

  it('restores the broken identity, repairs only missing pending todos, and preserves identities through reset', async () => {
    await repair()
    await db.qmsWorkOrder.create({ data: { workOrderNumber: wo, quantity: 1, status: 'OPEN', customerName: 'Test', deliveryDate: parseDay('2026-12-31'), updatedAt: new Date() } })
    const ids: string[] = []
    for (const name of ['pending', 'accepted', 'rejected', 'completed']) {
      ids.push((await plan.createNode(wo, { name, dept: 'TECH', planDate: parseDay('2026-12-01'), preds: [] }, 'u-005')).id)
    }
    // Reproduce the old reset: login survives but its department and roles vanish.
    await db.notifyRole.deleteMany()
    await db.deptMapping.deleteMany()
    await db.qmsDepartment.deleteMany()
    expect((await plan.publishPlan(wo, 'u-005')).todos).toBe(0)
    await db.planNode.update({ where: { id: ids[1] }, data: { confirmStatus: 'CONFIRMED', confirmedBy: 'u-011', confirmedAt: new Date() } })
    await db.planNode.update({ where: { id: ids[2] }, data: { confirmStatus: 'REJECTED', rejectReason: 'Test rejection' } })
    await db.planNode.update({ where: { id: ids[3] }, data: { manualDoneAt: new Date(), actualDate: parseDay('2026-12-01'), manualDoneBy: 'u-011' } })
    const before = await db.planNode.findMany({ where: { workOrderNumber: wo }, orderBy: { id: 'asc' } })
    expect(await repair()).toEqual({ created: 1 })
    expect(await db.notifyRole.findFirst({ where: { userId: 'u-011', role: 'DEPT_HEAD' } })).toMatchObject({ department: '技术部' })
    expect(await db.deptMapping.findUnique({ where: { qmsDepartmentId: 'DEMO-DEPT-TECH' } })).toMatchObject({ businessDept: 'TECH' })
    expect(await db.todo.findMany({ where: { refId: { in: ids } } })).toMatchObject([{ ownerId: 'u-011', refId: ids[0], status: 'OPEN', action: 'CONFIRM_PLAN_NODE' }])
    expect(await repair()).toEqual({ created: 0 })
    expect(await db.planNode.findMany({ where: { workOrderNumber: wo }, orderBy: { id: 'asc' } })).toEqual(before)
    const roles = await db.notifyRole.findMany({ orderBy: { id: 'asc' } })
    const departments = await db.qmsDepartment.findMany({ orderBy: { id: 'asc' } })
    const mappings = await db.deptMapping.findMany({ orderBy: { qmsDepartmentId: 'asc' } })
    await reset(undefined, { preserveUsers: true })
    expect(await db.planNode.count({ where: { workOrderNumber: wo } })).toBe(0)
    expect(await db.todo.count({ where: { refId: { in: ids } } })).toBe(0)
    expect(await db.notifyRole.findMany({ orderBy: { id: 'asc' } })).toEqual(roles)
    expect(await db.qmsDepartment.findMany({ orderBy: { id: 'asc' } })).toEqual(departments)
    expect(await db.deptMapping.findMany({ orderBy: { qmsDepartmentId: 'asc' } })).toEqual(mappings)
    expect(await repair()).toEqual({ created: 0 })
    await db.qmsWorkOrder.create({ data: { workOrderNumber: wo, quantity: 1, status: 'OPEN', customerName: 'Test', deliveryDate: parseDay('2026-12-31'), updatedAt: new Date() } })
    const next = await plan.createNode(wo, { name: 'new plan after reset', dept: 'TECH', planDate: parseDay('2026-12-01') }, 'u-005')
    expect((await plan.publishPlan(wo, 'u-005')).todos).toBe(1)
    expect(await db.todo.findFirst({ where: { refId: next.id, ownerId: 'u-011' } })).toMatchObject({ status: 'OPEN' })
  })
})
