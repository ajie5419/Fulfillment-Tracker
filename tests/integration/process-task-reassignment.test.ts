import { execFileSync } from 'node:child_process'
import type { MaterialListStatus, PrismaClient, ProcessDocStatus } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)

describe.skipIf(!DB)('design task reassignment reconciles process requirements', () => {
  const WO = 'TEST-PROCESS-REASSIGNMENT'
  const ACTOR = 'test-process-reassign-editor'
  const OWNER = 'test-process-reassign-worker'
  const PROCESS = 'test-process-reassign-cut'
  const DAY = new Date('2026-11-01T00:00:00.000Z')
  let db: PrismaClient
  let drawings: typeof import('../../server/services/drawings/drawings')
  let readiness: typeof import('../../server/services/purchases/purchases')
  let sequence = 0

  async function clean() {
    const parts = await db.part.findMany({ where: { workOrderNumber: WO }, select: { id: true } })
    await db.todo.deleteMany({ where: { refType: 'part', refId: { in: parts.map(part => part.id) } } })
    await db.reminder.deleteMany({ where: { userId: ACTOR } })
    await db.release.deleteMany({ where: { workOrderNumber: WO } })
    await db.drawingTask.deleteMany({ where: { workOrderNumber: WO } })
    await db.planNode.deleteMany({ where: { workOrderNumber: WO } })
    await db.workOrderPlan.deleteMany({ where: { workOrderNumber: WO } })
    await db.part.deleteMany({ where: { workOrderNumber: WO } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: WO } })
    await db.qmsProcess.deleteMany({ where: { id: PROCESS } })
    await db.qmsUser.deleteMany({ where: { id: { in: [ACTOR, OWNER] } } })
  }

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    drawings = await import('../../server/services/drawings/drawings')
    readiness = await import('../../server/services/purchases/purchases')
    await clean()
    await db.qmsWorkOrder.create({ data: { workOrderNumber: WO, customerName: 'Reassignment test', quantity: 1, deliveryDate: DAY, status: 'IN_PROGRESS', updatedAt: DAY } })
    await db.qmsProcess.create({ data: { id: PROCESS, name: 'Cut', updatedAt: DAY } })
    await db.qmsUser.createMany({ data: [ACTOR, OWNER].map(id => ({ id, username: id, realName: id, status: 'ACTIVE', updatedAt: DAY })) })
  })
  afterAll(async () => {
    if (!db) return
    await clean()
    await db.$disconnect()
  })

  const node = (requiresProcess: boolean) => db.planNode.create({ data: {
    workOrderNumber: WO, seq: ++sequence, name: `Policy ${sequence}`, dept: 'TECH', requiresProcess, planDate: DAY,
  } })
  const readyWhere = (partId: string) => ({ refType: 'part', refId: partId, action: 'READY_TO_START' })
  const readyCount = (partId: string) => db.todo.count({ where: { ...readyWhere(partId), status: 'OPEN' } })
  const documents = (id: string) => db.drawingTask.findUniqueOrThrow({ where: { id }, select: {
    status: true, materialStatus: true, materialAt: true, materialBy: true,
    processStatus: true, processAt: true, processBy: true,
  } })

  async function fixture(requiresProcess: boolean | null, states: { materialStatus?: MaterialListStatus; processStatus?: ProcessDocStatus } = {}) {
    const source = requiresProcess === null ? null : await node(requiresProcess)
    const part = await db.part.create({ data: {
      workOrderNumber: WO, name: `Part ${++sequence}`, quantity: 1,
      steps: { create: { seq: 1, processId: PROCESS, mode: 'SELF', ownerId: OWNER } },
    } })
    const task = await db.drawingTask.create({ data: {
      workOrderNumber: WO, componentName: `Drawing ${sequence}`, ownerId: ACTOR, planDate: DAY,
      planNodeId: source?.id ?? null, drawnDate: DAY, drawnBy: ACTOR, status: 'DONE',
      materialStatus: states.materialStatus ?? 'NOT_STARTED', processStatus: states.processStatus ?? 'NONE',
      materialAt: states.materialStatus ? DAY : null, materialBy: states.materialStatus ? ACTOR : null,
      processAt: states.processStatus ? DAY : null, processBy: states.processStatus ? ACTOR : null,
      parts: { create: { partId: part.id } },
    } })
    await db.release.create({ data: {
      releaseNo: `TEST-REASSIGN-${sequence}`, type: 'DRAWING', workOrderNumber: WO,
      description: 'Released drawing fixture', issuerId: ACTOR, drawingTaskId: task.id,
    } })
    if (states.materialStatus) await db.processDocLog.create({ data: { taskId: task.id, kind: 'MATERIAL', fromStatus: 'DRAFTING', toStatus: states.materialStatus, actorId: ACTOR, createdAt: DAY } })
    if (states.processStatus) await db.processDocLog.create({ data: { taskId: task.id, kind: 'PROCESS', fromStatus: 'DRAFTING', toStatus: states.processStatus, actorId: ACTOR, createdAt: DAY } })
    await db.$transaction(tx => readiness.refreshPartReady(tx, part.id, true), { isolationLevel: 'ReadCommitted' })
    return { task, part, source }
  }

  it.each([true, null])('reconciles true → false → true and standalone default policy: %s', async originalPolicy => {
    const { task, part, source } = await fixture(originalPolicy)
    const excluded = await node(false)
    expect(await readyCount(part.id)).toBe(0)
    const originalDocuments = await documents(task.id)
    expect(await drawings.updateTask(task.id, { planNodeId: excluded.id }, ACTOR)).toMatchObject({ status: 'DONE', readySent: 1 })
    expect(await readyCount(part.id)).toBe(1)
    await drawings.updateTask(task.id, { planNodeId: excluded.id, note: 'Same policy save' }, ACTOR)
    expect(await db.todo.count({ where: readyWhere(part.id) })).toBe(1)
    await drawings.updateTask(task.id, { planNodeId: source?.id ?? null }, ACTOR)
    expect(await readyCount(part.id)).toBe(0)
    expect(await documents(task.id)).toEqual(originalDocuments)
  })

  it('requires a new document review when an excluded task becomes manufacturing work', async () => {
    const { task, part } = await fixture(false, { materialStatus: 'ISSUED', processStatus: 'ISSUED' })
    const required = await node(true)
    expect(await readyCount(part.id)).toBe(1)
    const logCount = await db.processDocLog.count({ where: { taskId: task.id } })
    expect(await drawings.updateTask(task.id, { planNodeId: required.id }, ACTOR)).toMatchObject({ readySent: 0 })
    expect(await readyCount(part.id)).toBe(0)
    expect(await db.todo.count({ where: readyWhere(part.id) })).toBe(1)
    expect(await documents(task.id)).toMatchObject({ status: 'DONE', materialStatus: 'REVISING', processStatus: 'REVISING', materialBy: ACTOR, processBy: ACTOR })
    expect(await db.processDocLog.count({ where: { taskId: task.id } })).toBe(logCount + 2)
    const reviews = await db.processDocLog.findMany({ where: { taskId: task.id, toStatus: 'REVISING' } })
    expect(reviews.every(log => log.actorId === ACTOR && log.releaseId === null)).toBe(true)
  })

  it.each([true, false])('same-policy reassignment preserves issued documents and their audit history: %s', async policy => {
    const { task, part } = await fixture(policy, { materialStatus: 'ISSUED', processStatus: 'ISSUED' })
    const target = await node(policy)
    const originalDocuments = await documents(task.id)
    const originalLogs = await db.processDocLog.findMany({ where: { taskId: task.id }, orderBy: { id: 'asc' } })
    const originalTodos = await db.todo.findMany({ where: readyWhere(part.id) })
    expect(await drawings.updateTask(task.id, { planNodeId: target.id }, ACTOR)).toMatchObject({ readySent: 0 })
    expect(await documents(task.id)).toEqual(originalDocuments)
    expect(await db.processDocLog.findMany({ where: { taskId: task.id }, orderBy: { id: 'asc' } })).toEqual(originalLogs)
    expect(await db.todo.findMany({ where: readyWhere(part.id) })).toEqual(originalTodos)
  })

  it('retires and restores the current process revision reminder when its task is reassigned', async () => {
    const { task, source } = await fixture(true, { materialStatus: 'REVISING' })
    const excluded = await node(false)
    const change = await db.release.create({ data: {
      releaseNo: `TEST-REASSIGN-CHANGE-${sequence}`, type: 'CHANGE', workOrderNumber: WO,
      description: 'Current material revision', issuerId: ACTOR,
    } })
    await db.processDocLog.create({ data: {
      taskId: task.id, kind: 'MATERIAL', fromStatus: 'ISSUED', toStatus: 'REVISING', releaseId: change.id,
      actorId: ACTOR, createdAt: new Date(+DAY + 1),
    } })
    const reminder = await db.reminder.create({ data: {
      userId: ACTOR, kind: 'PROCESS', title: 'Current revision', level: 'YELLOW',
      link: `/process?wo=${WO}`, dedupeKey: `PROCESS_REVISE:${change.id}:${ACTOR}`,
    } })
    await drawings.updateTask(task.id, { planNodeId: excluded.id }, ACTOR)
    expect((await db.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).readAt).toBeInstanceOf(Date)
    await drawings.updateTask(task.id, { planNodeId: source?.id ?? null }, ACTOR)
    expect(await db.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).toMatchObject({ readAt: null, createdAt: reminder.createdAt })
    expect(await documents(task.id)).toMatchObject({ status: 'DONE', materialStatus: 'REVISING' })
  })
})
