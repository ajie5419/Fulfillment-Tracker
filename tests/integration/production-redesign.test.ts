/**
 * 生产管理重设计第一批：生产调度列表的"可以开工 / 卡住"口径、批量编排（一个事务、规则同单道修改）、批量套模板。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  finish: typeof import('../../server/services/flow/finish')
  workshop: typeof import('../../server/services/flow/workshop')
  templates: typeof import('../../server/services/templates/templates')
}

describe.skipIf(!DB)('生产管理重设计（第一批）', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-PRD-1'
  const DONE_WO = 'T-PRD-CLOSED'
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`)

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      steps: await import('../../server/services/flow/steps'),
      flow: await import('../../server/services/flow/flow'),
      finish: await import('../../server/services/flow/finish'),
      workshop: await import('../../server/services/flow/workshop'),
      templates: await import('../../server/services/templates/templates'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    const wos = [WO, DONE_WO]
    await db.todo.deleteMany()
    await db.flowEvent.deleteMany({ where: { step: { part: { workOrderNumber: { in: wos } } } } })
    await db.purchaseLine.deleteMany({ where: { workOrderNumber: { in: wos } } })
    await db.routeStep.deleteMany({ where: { part: { workOrderNumber: { in: wos } } } })
    await db.part.deleteMany({ where: { workOrderNumber: { in: wos } } })
    await db.routeTemplate.deleteMany({ where: { name: '重设计测试模板' } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { in: wos } } })
    await db.qmsSupplier.deleteMany({ where: { id: { in: ['PRD-OUT', 'PRD-TEAM'] } } })
    await db.qmsProcess.deleteMany({ where: { id: { in: ['PRD-CUT', 'PRD-PAINT'] } } })
    await db.qmsUser.deleteMany({ where: { id: { in: ['prd-a', 'prd-b'] } } })

    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [
        { workOrderNumber: WO, customerName: '测试客户', quantity: 1, deliveryDate: day('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now },
        { workOrderNumber: DONE_WO, customerName: '测试客户', quantity: 1, deliveryDate: day('2026-12-31'), status: 'COMPLETED', updatedAt: now },
      ],
    })
    await db.qmsSupplier.createMany({
      data: [
        { id: 'PRD-OUT', name: '涂装厂', updatedAt: now },
        { id: 'PRD-TEAM', name: '下料班', kind: 'TEAM', updatedAt: now },
      ],
    })
    await db.qmsProcess.createMany({
      data: [
        { id: 'PRD-CUT', name: '下料', supplierSource: 'Supplier', updatedAt: now },
        { id: 'PRD-PAINT', name: '涂装', supplierSource: 'Supplier', updatedAt: now },
      ],
    })
    await db.qmsUser.createMany({
      data: [
        { id: 'prd-a', username: 'pa', realName: '甲', departmentId: 'D', roleId: 'r', status: 'ACTIVE', updatedAt: now },
        { id: 'prd-b', username: 'pb', realName: '乙', departmentId: 'D', roleId: 'r', status: 'ACTIVE', updatedAt: now },
      ],
    })
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  /** 下料（自制）→ 涂装（厂外） */
  async function makePart(name: string, wo = WO) {
    const part = await s.steps.createPart(wo, { name, quantity: 2 })
    const cut = await s.steps.addStep(part.id, { processId: 'PRD-CUT', mode: 'SELF', ownerId: 'prd-a' }, 'prd-a')
    const paint = await s.steps.addStep(part.id, { processId: 'PRD-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'PRD-OUT', ownerId: 'prd-a' }, 'prd-a')
    return { part, cut, paint }
  }
  const rowOf = async (stepId: string) => (await s.workshop.listProduction({ workOrderNumber: WO })).rows.find((r) => r.stepId === stepId)

  it('可以开工：第一道缺料算卡住并写明原因，料到齐后变可以开工；后面的道等上一道做完（排队中不列出）', async () => {
    const { part, cut, paint } = await makePart('缺料件')
    const line = await db.purchaseLine.create({ data: { workOrderNumber: WO, partId: part.id, materialName: '钢板', quantity: 1, needDate: day('2026-11-20') } })
    expect(await rowOf(cut.id)).toMatchObject({ column: 'stuck', stuckKind: 'MATERIAL' })
    expect((await rowOf(cut.id))!.stuckText).toContain('1 项')
    expect(await rowOf(paint.id)).toBeUndefined() // 上一道没做完：排队中，不进看板
    await db.purchaseLine.update({ where: { id: line.id }, data: { status: 'ARRIVED', arrivedDate: day('2026-11-18'), arrivedAt: new Date() } })
    expect(await rowOf(cut.id)).toMatchObject({ column: 'ready', stuckKind: null })

    await s.flow.startStep({ stepId: cut.id, actorId: 'prd-a', source: 'PC' })
    expect(await rowOf(cut.id)).toMatchObject({ column: 'working' })
  })

  it('只看我的、已完工工单不列出、未排工序的工件计数', async () => {
    const { cut } = await makePart('乙的件')
    await s.steps.updateStep(cut.id, { ownerId: 'prd-b' })
    const mine = await s.workshop.listProduction({ workOrderNumber: WO, ownerId: 'prd-b' })
    expect(mine.rows.map((r) => r.stepId)).toEqual([cut.id])

    const closed = await makePart('已完工工单的件', DONE_WO)
    const all = await s.workshop.listProduction({})
    expect(all.rows.some((r) => r.partId === closed.part.id)).toBe(false)

    const before = (await s.workshop.listProduction({ workOrderNumber: WO })).unroutedParts
    await s.steps.createPart(WO, { name: '没排工序的件', quantity: 1 })
    expect((await s.workshop.listProduction({ workOrderNumber: WO })).unroutedParts).toBe(before + 1)
  })

  it('批量编排：班组只设到自制工序、外协厂只设到外协工序；已完成的不改；一道不合规整批不改并写明哪道', async () => {
    const a = await makePart('批量A')
    const b = await makePart('批量B')
    const r = await s.steps.batchUpdateSteps({ partIds: [a.part.id, b.part.id], set: { supplierId: 'PRD-TEAM', ownerId: 'prd-b' } })
    expect(r).toMatchObject({ updated: 4, skipped: 2 }) // 4 道都改了负责人；2 道涂装是外协，不设班组
    const steps = await db.routeStep.findMany({ where: { partId: { in: [a.part.id, b.part.id] } }, orderBy: [{ partId: 'asc' }, { seq: 'asc' }] })
    expect(steps.every((x) => x.ownerId === 'prd-b')).toBe(true)
    expect(steps.filter((x) => x.mode === 'SELF').every((x) => x.supplierId === 'PRD-TEAM')).toBe(true)
    expect(steps.filter((x) => x.mode !== 'SELF').every((x) => x.supplierId === 'PRD-OUT')).toBe(true)

    // 只改某道工序
    const onlyPaint = await s.steps.batchUpdateSteps({ partIds: [a.part.id], processId: 'PRD-PAINT', set: { dueDate: day('2026-12-01') } })
    expect(onlyPaint.updated).toBe(1)

    // 应开工日晚于要求完成日：整批回滚，报错带工件和工序
    await expect(s.steps.batchUpdateSteps({ partIds: [a.part.id, b.part.id], set: { planStartDate: day('2026-12-10'), ownerId: 'prd-a' } })).rejects.toThrow(/批量A · 第 2 道 涂装/)
    const after = await db.routeStep.findMany({ where: { partId: { in: [a.part.id, b.part.id] } } })
    expect(after.every((x) => x.ownerId === 'prd-b' && x.planStartDate === null)).toBe(true)

    // 已完成的工序不动
    await s.flow.startStep({ stepId: b.cut.id, actorId: 'prd-a', source: 'PC' })
    await s.finish.finishStep({ stepId: b.cut.id, actorId: 'prd-a', source: 'PC' })
    const r2 = await s.steps.batchUpdateSteps({ partIds: [b.part.id], set: { ownerId: 'prd-a' } })
    expect(r2.updated).toBe(1)
    expect((await db.routeStep.findUnique({ where: { id: b.cut.id } }))!.ownerId).toBe('prd-b')
  })

  it('批量套模板：没排工序的套上，已有工序链的跳过', async () => {
    const tpl = await s.templates.createTemplate({ name: '重设计测试模板', steps: [{ processId: 'PRD-CUT', mode: 'SELF' }, { processId: 'PRD-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'PRD-OUT' }] }, 'prd-a')
    const empty1 = await s.steps.createPart(WO, { name: '空件1', quantity: 1 })
    const empty2 = await s.steps.createPart(WO, { name: '空件2', quantity: 1 })
    const routed = await makePart('已排件')
    const r = await s.templates.applyTemplateBatch([empty1.id, empty2.id, routed.part.id], tpl.id, 'prd-a')
    expect(r).toMatchObject({ applied: 2, skipped: 1, template: '重设计测试模板' })
    expect(await db.routeStep.count({ where: { partId: empty1.id } })).toBe(2)
    expect(await db.routeStep.count({ where: { partId: routed.part.id } })).toBe(2)
  })
})
