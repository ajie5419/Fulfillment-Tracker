/**
 * 生产管理补全（10-26）：派工到班组、部分完工 / 报废转异常、应开工日（待办截止日）、外协随件发料。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  finish: typeof import('../../server/services/flow/finish')
  todos: typeof import('../../server/services/flow/todos')
  working: typeof import('../../server/services/flow/working')
  transit: typeof import('../../server/services/flow/transit')
  templates: typeof import('../../server/services/templates/templates')
}

describe.skipIf(!DB)('生产管理补全', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-PROD-1'
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`)

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      steps: await import('../../server/services/flow/steps'),
      flow: await import('../../server/services/flow/flow'),
      finish: await import('../../server/services/flow/finish'),
      todos: await import('../../server/services/flow/todos'),
      working: await import('../../server/services/flow/working'),
      transit: await import('../../server/services/flow/transit'),
      templates: await import('../../server/services/templates/templates'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.issue.deleteMany()
    await db.notifyRole.deleteMany()
    await db.flowEvent.deleteMany()
    await db.todo.deleteMany()
    await db.unmatchedInspection.deleteMany()
    await db.routeStep.deleteMany()
    await db.part.deleteMany()
    await db.routeTemplate.deleteMany()
    await db.qmsInspection.deleteMany()
    await db.qmsWorkOrder.deleteMany()
    await db.qmsSupplier.deleteMany()
    await db.qmsProcess.deleteMany()
    await db.qmsUser.deleteMany()

    const now = new Date()
    const { PRODUCTION_DEPT } = await import('../../server/services/releases/constants')
    await db.qmsWorkOrder.create({ data: { workOrderNumber: WO, customerName: '测试客户', quantity: 1, deliveryDate: day('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now } })
    await db.qmsSupplier.createMany({
      data: [
        { id: 'S-OUT', name: '外协厂', updatedAt: now },
        { id: 'T-WELD', name: '焊接一班', kind: 'TEAM', updatedAt: now },
      ],
    })
    await db.qmsProcess.createMany({
      data: [
        { id: 'P-CUT', name: '下料', supplierSource: 'Supplier', updatedAt: now },
        { id: 'P-WELD', name: '组焊', supplierSource: 'Supplier', updatedAt: now },
        { id: 'P-PAINT', name: '涂装', supplierSource: 'Supplier', updatedAt: now },
      ],
    })
    await db.qmsUser.createMany({
      data: [
        { id: 'u-worker', username: 'w', realName: '班长', departmentId: 'D-PROD', roleId: 'r', status: 'ACTIVE', updatedAt: now },
        { id: 'u-head', username: 'h', realName: '生产经理', departmentId: 'D-PROD', roleId: 'r', status: 'ACTIVE', updatedAt: now },
      ],
    })
    await db.notifyRole.create({ data: { role: 'DEPT_HEAD', userId: 'u-head', department: PRODUCTION_DEPT } })
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  let n = 0
  /** 下料（自制，派焊接一班）→ 组焊（自制）→ 涂装（厂外外协） */
  async function makePart(quantity: number) {
    const part = await s.steps.createPart(WO, { name: `件-${++n}`, quantity })
    const cut = await s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', supplierId: 'T-WELD', ownerId: 'u-worker' }, 'u-head')
    const weld = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'SELF', ownerId: 'u-worker' }, 'u-head')
    const paint = await s.steps.addStep(part.id, { processId: 'P-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-OUT', ownerId: 'u-worker' }, 'u-head')
    return { part, cut, weld, paint }
  }
  const act = (stepId: string) => ({ stepId, actorId: 'u-worker', source: 'MOBILE' as const })

  it('派工到班组：自制工序可选厂内班组，外协厂不行；自制和外协互改时原班组 / 外协厂清空', async () => {
    const { cut, paint } = await makePart(1)
    expect(cut.supplierId).toBe('T-WELD')
    await expect(s.steps.addStep(cut.partId, { processId: 'P-WELD', mode: 'SELF', supplierId: 'S-OUT' }, 'u-head')).rejects.toThrow('只能派给厂内班组')
    await expect(s.steps.updateStep(cut.id, { supplierId: 'S-OUT' })).rejects.toThrow('只能派给厂内班组')
    const self = await s.steps.updateStep(paint.id, { mode: 'SELF' })
    expect(self.supplierId).toBeNull()
    // 反过来：派了班组的自制工序改成外协，班组不能留着当外协厂
    await s.steps.updateStep(paint.id, { supplierId: 'T-WELD' })
    expect((await s.steps.updateStep(paint.id, { mode: 'EXTERNAL_OUTSOURCE' })).supplierId).toBeNull()
    // 加工中列表带班组
    await s.flow.startStep(act(cut.id))
    const row = (await s.working.listWorking({})).find((r) => r.stepId === cut.id)
    expect(row).toMatchObject({ supplierId: 'T-WELD', supplierName: '焊接一班', doneQty: 0 })
  })

  it('部分完工：计入已完成数量、步骤继续加工；第一次就给下一道发待办；剩下的做完再完工', async () => {
    const { cut, weld } = await makePart(10)
    await s.flow.startStep(act(cut.id))
    await expect(s.finish.finishStep({ ...act(cut.id), qty: 4 })).rejects.toThrow('还差 6 件')
    await expect(s.finish.finishStep({ ...act(cut.id), qty: 11 })).rejects.toThrow('超过剩余数量')
    await expect(s.finish.finishStep({ ...act(cut.id), qty: 0, rest: 'CONTINUE' })).rejects.toThrow('至少 1 件')

    const r1 = await s.finish.finishStep({ ...act(cut.id), qty: 4, rest: 'CONTINUE' })
    expect(r1).toMatchObject({ stepDone: false, todoCreated: true, issueNo: null })
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: cut.id } })).status).toBe('IN_PROGRESS')
    expect(await db.todo.count({ where: { refType: 'step', refId: weld.id, status: 'OPEN' } })).toBe(1)
    expect((await s.working.listWorking({})).find((r) => r.stepId === cut.id)?.doneQty).toBe(4)

    // 不填数量 = 剩余 6 件全部完工
    const r2 = await s.finish.finishStep(act(cut.id))
    expect(r2.stepDone).toBe(true)
    const events = await db.flowEvent.findMany({ where: { stepId: cut.id }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => [e.type, e.qty])).toEqual([['START', 10], ['REPORT', 4], ['FINISH', 6]])
    expect(await db.todo.count({ where: { refType: 'step', refId: weld.id } })).toBe(1) // 不重复发
  })

  it('报废：完成的记完工、报废的不计数量，步骤完成；自动生成"车间"异常给生产部负责人', async () => {
    const { cut, weld } = await makePart(5)
    const r = await s.finish.finishStep({ ...act(cut.id), qty: 3, rest: 'SCRAP', note: '切割尺寸超差' })
    expect(r.stepDone).toBe(true)
    expect(r.issueNo).toMatch(/^YC-/)
    const step = await db.routeStep.findUniqueOrThrow({ where: { id: cut.id }, include: { part: true } })
    expect(step.status).toBe('DONE')
    expect(step.part.currentStepId).toBe(weld.id)
    const events = await db.flowEvent.findMany({ where: { stepId: cut.id }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => [e.type, e.qty, e.note])).toEqual([['SCRAP', 2, '切割尺寸超差'], ['FINISH', 3, null]])
    const issue = await db.issue.findUniqueOrThrow({ where: { issueNo: r.issueNo! } })
    expect(issue).toMatchObject({ source: 'SCRAP', category: 'WORKSHOP', refType: 'STEP', refId: cut.id, responsibleUserId: 'u-head', reporterId: 'u-worker', workOrderNumber: WO })
    expect(issue.description).toContain('报废 2 件')
    expect(issue.description).toContain('焊接一班')
    expect(issue.sourceKey).toBe(`SCRAP:${events[0]!.id}`)
    // 已完成数量只算完工的 3 件
    const parts = await s.steps.listParts(WO)
    expect(parts.flatMap((p) => p.steps).find((x) => x.id === cut.id)?.returnedQty).toBe(3)

    // 全部报废（完成 0 件）也可以
    const { cut: cut2 } = await makePart(2)
    const r2 = await s.finish.finishStep({ ...act(cut2.id), qty: 0, rest: 'SCRAP' })
    expect(r2.stepDone).toBe(true)
    expect(r2.issueNo).not.toBe(r.issueNo)
  })

  it('应开工日：不能晚于要求完成日；"安排开工"待办的截止日取应开工日', async () => {
    const { cut, weld } = await makePart(1)
    await expect(s.steps.updateStep(weld.id, { planStartDate: day('2026-11-10'), dueDate: day('2026-11-05') })).rejects.toThrow('应开工日不能晚于要求完成日')
    await s.steps.updateStep(weld.id, { planStartDate: day('2026-11-03'), dueDate: day('2026-11-08') })
    await expect(s.steps.updateStep(weld.id, { planStartDate: day('2026-11-09') })).rejects.toThrow('应开工日不能晚于要求完成日')
    await s.finish.finishStep(act(cut.id))
    const todo = (await s.todos.listMyTodos('u-worker')).find((t) => t.refType === 'step' && t.refId === weld.id)
    expect(todo?.dueDay).toBe('2026-11-03')
  })

  it('套用模板：应开工日 = 上一道的要求完成日；自制可带默认班组', async () => {
    const rows = s.templates.routeFromTemplate(
      [
        { processId: 'P-CUT', mode: 'SELF', supplierId: 'T-WELD', defaultDays: 2 },
        { processId: 'P-WELD', mode: 'SELF', defaultDays: null },
        { processId: 'P-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-OUT', defaultDays: 5 },
      ],
      '2026-11-01',
    )
    const d = (x: Date | null) => x?.toISOString().slice(0, 10) ?? null
    expect(rows.map((r) => [r.supplierId, d(r.planStartDate), d(r.dueDate)])).toEqual([
      ['T-WELD', '2026-11-01', '2026-11-03'],
      [null, '2026-11-03', null],
      ['S-OUT', '2026-11-03', '2026-11-08'],
    ])
    await expect(s.templates.createTemplate({ name: '错的', steps: [{ processId: 'P-CUT', mode: 'SELF', supplierId: 'S-OUT' }] }, 'u-head')).rejects.toThrow('只能派给厂内班组')
  })

  it('外协随件发料：发出时登记，在途列表里能看到', async () => {
    const { cut, weld, paint } = await makePart(1)
    await s.finish.finishStep(act(cut.id))
    await s.finish.finishStep(act(weld.id))
    await s.flow.sendStep({ stepId: paint.id, promisedReturnDate: day('2026-12-01'), note: ' 油漆 2 桶 ', actorId: 'u-worker', source: 'MOBILE' })
    const row = (await s.transit.listTransit({ workOrderNumber: WO })).find((r) => r.stepId === paint.id)
    expect(row?.sendNote).toBe('油漆 2 桶')
  })
})
