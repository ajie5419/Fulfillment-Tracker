import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { getTestDatabaseUrl } from '../helpers/test-database'
import { parseDay } from '../../shared/dates'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
describe.skipIf(!DB)('design task split and assignment', () => {
  let db: PrismaClient
  let plan: typeof import('../../server/services/plan/plan')
  let drawings: typeof import('../../server/services/drawings/drawings')
  let todos: typeof import('../../server/services/flow/todos')
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    const { ensureDemoIdentity } = await import('../../server/services/dev/demo-identity')
    await db.$transaction((tx) => ensureDemoIdentity(tx))
    plan = await import('../../server/services/plan/plan')
    drawings = await import('../../server/services/drawings/drawings')
    todos = await import('../../server/services/flow/todos')
  })
  afterAll(async () => { await db?.$disconnect() })
  it('shares one assigned record across plan, design list and workbench, with live lifecycle changes', async () => {
    const wo = 'DEMO-SPLIT-TEST'
    await db.qmsWorkOrder.create({ data: { workOrderNumber: wo, customerName: 'Test', quantity: 1, status: 'OPEN', deliveryDate: parseDay('2026-12-31'), updatedAt: new Date() } })
    const n = await plan.createNode(wo, { name: '结构图纸', dept: 'TECH', planDate: parseDay('2026-12-01') }, 'u-005')
    expect((await plan.planOptions(wo)).nodes.find((row) => row.id === n.id)).toMatchObject({ code: '1' })
    await plan.publishPlan(wo, 'u-005')
    await plan.confirmNode(n.id, 'u-011')
    const input = { workOrderNumber: wo, planNodeId: n.id, componentName: '车架', ownerId: 'u-008', startDate: parseDay('2026-11-01'), planDate: parseDay('2026-12-01') }
    await expect(drawings.createTask({ ...input, startDate: parseDay('2026-12-02') }, 'u-011')).rejects.toThrow('开始日')
    const task = await drawings.createTask(input, 'u-011')
    const state = async () => (await plan.loadPlans({ workOrderNumbers: [wo] })).get(wo)?.forecast.nodes.find((row) => row.id === n.id)
    await expect(plan.completeNode(n.id, null, 'u-011')).rejects.toThrow('自动完成')
    expect(await state()).toMatchObject({ done: false })
    expect(task.startDate).toEqual(input.startDate)
    const data = (await plan.loadPlans({ workOrderNumbers: [wo] })).get(wo)
    expect(data?.tasks).toHaveLength(1)
    expect(data?.tasks[0]).toMatchObject({ id: task.id, nodeId: n.id, kind: 'drawing', owner: { id: 'u-008' } })
    expect(await db.planTask.count({ where: { workOrderNumber: wo } })).toBe(0)
    const mine = await drawings.listTasks({ ownerId: 'u-008', view: 'open' }, { userId: 'u-008', isAdmin: false })
    expect(mine.rows.map((t) => t.id)).toContain(task.id)
    expect(mine.rows.find((t) => t.id === task.id)?.planNode).toMatchObject({ code: '1' })
    expect(mine.stats).toMatchObject({ pending: 1, drawn: 0, customerPending: 0, done: 0, cancelled: 0 })
    expect(await todos.listMyTodos('u-008', [])).toMatchObject([{ refId: task.id, refType: 'drawing', ownerId: 'u-008', dueDay: '2026-12-01' }])
    await drawings.updateTask(task.id, { ownerId: 'u-011' }, 'u-011')
    expect(await todos.listMyTodos('u-008', [])).toEqual([])
    expect((await todos.listMyTodos('u-011', [])).some((t) => t.refId === task.id)).toBe(true)
    await drawings.markDrawn(task.id, parseDay('2026-11-01'), { userId: 'u-011', isAdmin: false })
    expect(await state()).toMatchObject({ done: true, doneBy: 'AUTO', actualDay: '2026-11-01' })
    expect((await todos.listMyTodos('u-011', [])).some((t) => t.refId === task.id)).toBe(false)
    await drawings.undoDrawn(task.id, { userId: 'u-011', isAdmin: false })
    expect(await state()).toMatchObject({ done: false, actualDay: null })
    expect((await todos.listMyTodos('u-011', [])).some((t) => t.refId === task.id)).toBe(true)
    await drawings.updateTask(task.id, { cancelled: true }, 'u-011')
    expect((await drawings.listTasks({ ownerId: 'u-011', view: 'pending' }, { userId: 'u-011', isAdmin: false })).stats).toMatchObject({ pending: 0, cancelled: 1 })
    expect(await state()).toMatchObject({ done: false })
    const second = await drawings.createTask({ ...input, componentName: 'Second' }, 'u-011')
    await drawings.markDrawn(second.id, parseDay('2026-11-02'), { userId: 'u-008', isAdmin: false })
    expect(await state()).toMatchObject({ done: true, doneBy: 'AUTO' })
    await drawings.createTask({ ...input, componentName: 'Third' }, 'u-011')
    expect(await state()).toMatchObject({ done: false })
    expect((await todos.listMyTodos('u-011', [])).some((t) => t.refId === task.id)).toBe(false)
  })
})
