import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { getTestDatabaseUrl } from '../helpers/test-database'
import { parseDay } from '../../shared/dates'
import { CONFIRM_PLAN_NODE } from '../../shared/todo-actions'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
describe.skipIf(!DB)('linked planned dates on MySQL', () => {
  let db: PrismaClient
  let service: typeof import('../../server/services/plan/commands')
  let a: string
  let b: string
  const wo = 'TEST-LINKED-SCHEDULE'
  const head = 'schedule-test-head'

  async function clean() {
    const nodes = await db.planNode.findMany({ where: { workOrderNumber: wo }, select: { id: true } })
    await db.todo.deleteMany({ where: { refType: 'planNode', refId: { in: nodes.map(node => node.id) } } })
    await db.planChangeLog.deleteMany({ where: { workOrderNumber: wo } })
    await db.planNode.deleteMany({ where: { workOrderNumber: wo } })
    await db.workOrderPlan.deleteMany({ where: { workOrderNumber: wo } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: wo } })
    await db.notifyRole.deleteMany({ where: { userId: head } })
  }

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    service = await import('../../server/services/plan/commands')
    db = (await import('../../server/utils/prisma')).prisma
    await clean()
    await db.qmsWorkOrder.create({ data: { workOrderNumber: wo, customerName: 'Schedule test', quantity: 1, deliveryDate: parseDay('2026-12-31'), status: 'IN_PROGRESS', updatedAt: new Date() } })
    await db.notifyRole.create({ data: { userId: head, role: 'DEPT_HEAD', department: 'TECH' } })
    a = (await service.createNode(wo, { name: 'Purchase plan', dept: 'TECH', startDate: parseDay('2026-11-01'), planDate: parseDay('2026-11-05'), preds: [] }, 'pm')).id
    b = (await service.createNode(wo, { name: 'Purchase and inspection', dept: 'TECH', startDate: parseDay('2026-11-06'), planDate: parseDay('2026-11-08'), preds: [a] }, 'pm')).id
  })
  afterAll(async () => {
    if (!db) return
    try {
      await clean()
    } finally {
      await db.$disconnect()
    }
  })

  it('previews without writes, rejects a stale preview, then commits dates and published confirmations atomically', async () => {
    const input = { linkedDates: true, planDate: parseDay('2026-11-10') }
    const before = await db.planNode.findMany({ where: { workOrderNumber: wo }, orderBy: { seq: 'asc' } })
    const preview = (await service.updateNode(a, { ...input, preview: true }, 'pm')).preview!
    expect(preview.changes.find((c) => c.id === b)).toMatchObject({ start: '2026-11-11', finish: '2026-11-13' })
    expect(await db.planNode.findMany({ where: { workOrderNumber: wo }, orderBy: { seq: 'asc' } })).toEqual(before)
    expect(await db.planChangeLog.count({ where: { workOrderNumber: wo } })).toBe(0)
    await db.planNode.update({ where: { id: b }, data: { note: 'changed after preview' } })
    await expect(service.updateNode(a, { ...input, previewToken: preview.token }, 'pm')).rejects.toThrow('重新预览')
    expect((await db.planNode.findUniqueOrThrow({ where: { id: a } })).planDate).toEqual(parseDay('2026-11-05'))
    const refreshed = (await service.updateNode(a, { ...input, preview: true }, 'pm')).preview!
    await service.updateNode(a, { ...input, previewToken: refreshed.token }, 'pm')
    expect(await db.planNode.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ startDate: parseDay('2026-11-11'), planDate: parseDay('2026-11-13') })

    await service.publishPlan(wo, 'pm')
    // Other suites may leave legitimate department heads; each recipient must get one fresh confirmation.
    const confirmation = { ownerId: head, refType: 'planNode', refId: b, action: CONFIRM_PLAN_NODE }
    const publishedTodos = await db.todo.findMany({ where: { ...confirmation, status: 'OPEN' } })
    expect(publishedTodos).toHaveLength(1)
    await db.planNode.updateMany({ where: { workOrderNumber: wo }, data: { confirmStatus: 'CONFIRMED' } })
    const publishedInput = { linkedDates: true, planDate: parseDay('2026-11-15'), reason: 'Updated material requirements' }
    const next = (await service.updateNode(a, { ...publishedInput, preview: true }, 'pm')).preview!
    const logsBefore = await db.planChangeLog.count({ where: { workOrderNumber: wo } })
    expect((await db.planNode.findUniqueOrThrow({ where: { id: b } })).confirmStatus).toBe('CONFIRMED')
    await service.updateNode(a, { ...publishedInput, previewToken: next.token }, 'pm')
    expect(await db.planNode.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ startDate: parseDay('2026-11-16'), planDate: parseDay('2026-11-18'), baselineDate: parseDay('2026-11-13'), confirmStatus: 'PENDING' })
    expect(await db.planChangeLog.count({ where: { workOrderNumber: wo } })).toBe(logsBefore + 3)
    const openTodos = await db.todo.findMany({ where: { refType: 'planNode', refId: b, action: CONFIRM_PLAN_NODE, status: 'OPEN' }, select: { ownerId: true } })
    expect(openTodos.filter(todo => todo.ownerId === head)).toHaveLength(1)
    expect(new Set(openTodos.map(todo => todo.ownerId)).size).toBe(openTodos.length)
    expect(await db.todo.count({ where: { id: { in: publishedTodos.map(todo => todo.id) }, status: 'CANCELLED' } })).toBe(1)

    await db.planNode.update({ where: { id: b }, data: { manualDoneAt: new Date(), manualDoneBy: 'head', actualDate: parseDay('2026-11-18') } })
    const completed = (await service.updateNode(a, { ...publishedInput, planDate: parseDay('2026-11-20'), preview: true }, 'pm')).preview!
    expect(completed.skipped).toContain('Purchase and inspection')
    expect(completed.changes.some((c) => c.id === b)).toBe(false)
  })
})
