/**
 * 外协主链路（R3）：真实 MySQL 上直接调用服务层。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { PrismaClient, StepMode } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  match: typeof import('../../server/services/flow/match')
  todos: typeof import('../../server/services/flow/todos')
  errors: typeof import('../../server/services/flow/errors')
}

describe.skipIf(!DB)('外协主链路', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-1'
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`)

  beforeAll(async () => {
    // 专用测试库：建表到最新迁移，再清空本测试用到的表
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB // 服务层用 server/utils/prisma 的全局客户端
    s = {
      steps: await import('../../server/services/flow/steps'),
      flow: await import('../../server/services/flow/flow'),
      match: await import('../../server/services/flow/match'),
      todos: await import('../../server/services/flow/todos'),
      errors: await import('../../server/services/flow/errors'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await db.flowEvent.deleteMany()
    await db.todo.deleteMany()
    await db.alert.deleteMany()
    await db.issue.deleteMany()
    await db.unmatchedInspection.deleteMany()
    await db.routeStep.deleteMany()
    await db.part.deleteMany()
    await db.qmsInspection.deleteMany()
    await db.qmsWorkOrder.deleteMany()
    await db.qmsSupplier.deleteMany()
    await db.qmsProcess.deleteMany()
    await db.qmsUser.deleteMany()

    const now = new Date()
    await db.qmsWorkOrder.create({
      data: { workOrderNumber: WO, customerName: '测试客户', quantity: 1, deliveryDate: day('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now },
    })
    await db.qmsSupplier.createMany({
      data: [
        { id: 'S-WELD', name: '组焊厂', updatedAt: now },
        { id: 'S-PAINT', name: '涂装厂', updatedAt: now },
      ],
    })
    await db.qmsProcess.createMany({
      data: [
        { id: 'P-WELD', name: '组焊', supplierSource: 'Supplier', updatedAt: now },
        { id: 'P-PAINT', name: '涂装', supplierSource: 'Supplier', updatedAt: now },
        { id: 'P-ASSY', name: '装配', supplierSource: 'Supplier', updatedAt: now },
      ],
    })
    await db.qmsUser.createMany({
      data: [
        { id: 'u-out', username: 'out', realName: '外协专员', departmentId: 'D-PROD', roleId: 'r', status: 'ACTIVE', updatedAt: now },
        { id: 'u-pm', username: 'pm', realName: '生产经理', departmentId: 'D-PROD', roleId: 'r', status: 'ACTIVE', updatedAt: now },
      ],
    })
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  let seqNo = 0
  /** 建一个工件：组焊（厂外，u-out）→ 涂装（厂外，u-pm）→ 装配（自制，u-pm） */
  async function makePart(quantity = 1, chain?: { processId: string; mode: StepMode; supplierId?: string; ownerId?: string }[]) {
    seqNo++
    const part = await s.steps.createPart(WO, { name: `主梁-${seqNo}`, quantity, qmsPartId: `BOM-${seqNo}` })
    const steps = []
    for (const c of chain ?? [
      { processId: 'P-WELD', mode: 'EXTERNAL_OUTSOURCE' as const, supplierId: 'S-WELD' },
      { processId: 'P-PAINT', mode: 'EXTERNAL_OUTSOURCE' as const, supplierId: 'S-PAINT', ownerId: 'u-pm' },
      { processId: 'P-ASSY', mode: 'SELF' as const, ownerId: 'u-pm' },
    ]) {
      steps.push(await s.steps.addStep(part.id, c, 'u-out'))
    }
    return { part, steps }
  }

  // 报检提交时间要晚于工件登记时间（批量匹配只看工件登记之后的报检），用相对时间避免日期写死后过期
  const SUBMITTED_AT = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000)

  async function inspect(over: { partId?: string | null; partName?: string; processName?: string; processId?: string | null; supplierId?: string | null; quantity?: number; submittedAt?: Date }) {
    const id = `T-INS-${randomBytes(4).toString('hex')}`
    await db.qmsInspection.create({
      data: {
        id,
        requestNo: id,
        workOrderNumber: WO,
        partId: over.partId ?? null,
        partName: over.partName ?? '',
        processId: over.processId ?? null,
        processName: over.processName ?? '组焊',
        supplierId: over.supplierId ?? null,
        quantity: over.quantity ?? 1,
        status: 'SUBMITTED',
        inspectionResult: 'PASS',
        submittedAt: over.submittedAt ?? SUBMITTED_AT,
        updatedAt: new Date(),
      },
    })
    return id
  }

  const send = (stepId: string, supplierId: string) =>
    s.flow.sendStep({ stepId, supplierId, promisedReturnDate: day('2026-10-25'), actorId: 'u-out', source: 'MOBILE' })
  const stepOf = (id: string) => db.routeStep.findUniqueOrThrow({ where: { id } })
  const partOf = (id: string) => db.part.findUniqueOrThrow({ where: { id } })
  const todosOf = (stepId: string) => db.todo.findMany({ where: { refType: 'step', refId: stepId } })

  it('发出 → 报检匹配成功 → 步骤完成，下一道生成且只生成一条"安排发出"待办', async () => {
    const { part, steps } = await makePart()
    const [weld, paint] = steps
    expect(weld!.ownerId).toBe('u-out') // 负责人默认是创建人
    await db.todo.create({ data: { ownerId: 'u-out', action: 'ARRANGE_SEND', refType: 'step', refId: weld!.id } })

    await send(weld!.id, 'S-WELD')
    expect((await stepOf(weld!.id)).status).toBe('OUT')
    expect((await partOf(part.id)).currentStepId).toBe(weld!.id)
    expect((await todosOf(weld!.id)).map((t) => t.status)).toEqual(['DONE']) // 发出即关闭本步骤的安排发出待办
    const sendEv = await db.flowEvent.findFirstOrThrow({ where: { stepId: weld!.id, type: 'SEND' } })
    expect(sendEv.qty).toBe(1)

    // 预先放一条该步骤的 W3 活动预警，返厂时应被消除
    const alert = await db.alert.create({
      data: { rule: 'W3', refType: 'step', refId: weld!.id, level: 'YELLOW', firstAt: new Date(), levelAt: new Date(), activeKey: `W3:step:${weld!.id}` },
    })

    const insId = await inspect({ partId: part.qmsPartId, supplierId: 'S-WELD' })
    const results = await s.match.matchPendingInspections()
    expect(results.find((r) => r.inspectionId === insId)).toMatchObject({ status: 'matched', stepId: weld!.id, stepDone: true, todoCreated: true })

    const done = await stepOf(weld!.id)
    expect(done.status).toBe('DONE')
    expect(done.finishedAt?.toISOString()).toBe(SUBMITTED_AT.toISOString()) // 取报检提交时间
    const p = await partOf(part.id)
    expect(p.currentStepId).toBe(paint!.id)
    expect(p.status).toBe('ACTIVE')
    const next = await todosOf(paint!.id)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ action: 'ARRANGE_SEND', ownerId: 'u-pm', status: 'OPEN' })
    expect(await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })

    const ev = await db.flowEvent.findUniqueOrThrow({ where: { qmsInspectionId: insId } })
    expect(ev).toMatchObject({ type: 'RETURN', source: 'QMS_INSPECTION', qty: 1, stepId: weld!.id })

    // 待办列表带上展示信息
    const mine = await s.todos.listMyTodos('u-pm')
    expect(mine.find((t) => t.refId === paint!.id)).toMatchObject({ title: '安排发出：主梁-1 · 涂装', step: { workOrderNumber: WO } })
  })

  it('批量匹配只看工件登记之后的报检：登记前的历史报检不匹配、也不进待确认', async () => {
    const { part, steps } = await makePart()
    await send(steps[0]!.id, 'S-WELD')
    const old = await inspect({ partId: part.qmsPartId, supplierId: 'S-WELD', submittedAt: new Date(Date.now() - 86_400_000) })
    expect((await s.match.matchPendingInspections()).find((r) => r.inspectionId === old)).toBeUndefined()
    expect(await db.flowEvent.findUnique({ where: { qmsInspectionId: old } })).toBeNull()
    expect(await db.unmatchedInspection.findUnique({ where: { qmsInspectionId: old } })).toBeNull()
    expect((await stepOf(steps[0]!.id)).status).toBe('OUT')
  })

  it('同一报检再匹配一次：不产生重复事件和待办', async () => {
    const { part, steps } = await makePart()
    await send(steps[0]!.id, 'S-WELD')
    const insId = await inspect({ partId: part.qmsPartId })
    expect((await s.match.matchInspection(insId)).status).toBe('matched')

    const count = () => Promise.all([db.flowEvent.count(), db.todo.count()])
    const before = await count()
    expect((await s.match.matchInspection(insId)).status).toBe('skipped')
    expect(await s.match.matchPendingInspections()).toEqual([])
    // 直接再调 recordReturn 也是幂等的
    const r = await db.$transaction((tx) =>
      s.flow.recordReturn(tx, { stepId: steps[0]!.id, qty: 1, source: 'QMS_INSPECTION', qmsInspectionId: insId, occurredAt: new Date() }),
    )
    expect(r.duplicate).toBe(true)
    expect(await count()).toEqual(before)
  })

  it('分批返厂：第一次就生成下工序待办，全部数量返回才完成', async () => {
    const { part, steps } = await makePart(3)
    const [weld, paint] = steps
    await send(weld!.id, 'S-WELD')

    const first = await s.match.matchInspection(await inspect({ partId: part.qmsPartId, quantity: 1 }))
    expect(first).toMatchObject({ status: 'matched', stepDone: false, todoCreated: true })
    expect((await stepOf(weld!.id)).status).toBe('OUT')
    expect((await partOf(part.id)).currentStepId).toBe(weld!.id)
    expect(await todosOf(paint!.id)).toHaveLength(1)

    // 手工补登 1 件，仍未齐
    await s.flow.manualReturn({ stepId: weld!.id, qty: 1, actorId: 'u-out', source: 'MOBILE' })
    expect((await stepOf(weld!.id)).status).toBe('OUT')

    const last = await s.match.matchInspection(await inspect({ partId: part.qmsPartId, quantity: 1 }))
    expect(last).toMatchObject({ status: 'matched', stepDone: true, todoCreated: false })
    expect((await stepOf(weld!.id)).status).toBe('DONE')
    expect((await partOf(part.id)).currentStepId).toBe(paint!.id)
    expect(await todosOf(paint!.id)).toHaveLength(1)

    // 已完成的步骤再收到返厂：只记事件
    await s.flow.manualReturn({ stepId: weld!.id, qty: 1, actorId: 'u-out', source: 'PC' })
    expect((await stepOf(weld!.id)).status).toBe('DONE')
    expect(await db.flowEvent.count({ where: { stepId: weld!.id, type: 'RETURN_MANUAL' } })).toBe(2)
    expect(await todosOf(paint!.id)).toHaveLength(1)
  })

  it('对不上的进入待确认，人工关联后效果与自动匹配相同', async () => {
    const { part, steps } = await makePart()
    const [weld, paint] = steps
    await send(weld!.id, 'S-WELD')

    // 名称对不上 → NO_CANDIDATE，候选里有同工单在外的步骤
    const noHit = await inspect({ partName: '写错的名字', processName: '组焊' })
    expect(await s.match.matchInspection(noHit)).toMatchObject({ status: 'unmatched', reason: 'NO_CANDIDATE' })
    const row = await db.unmatchedInspection.findUniqueOrThrow({ where: { qmsInspectionId: noHit } })
    const candidates = row.candidates as { stepId: string; partName: string; processName: string; supplierName: string }[]
    expect(candidates.find((c) => c.stepId === weld!.id)).toMatchObject({ partName: part.name, processName: '组焊', supplierName: '组焊厂' })
    expect((await stepOf(weld!.id)).status).toBe('OUT')
    // 已在待确认列表里的不会重复处理
    expect((await s.match.matchInspection(noHit)).status).toBe('skipped')

    await s.match.resolveUnmatched(noHit, weld!.id, 'u-out')
    expect((await stepOf(weld!.id)).status).toBe('DONE')
    expect(await db.unmatchedInspection.findUniqueOrThrow({ where: { qmsInspectionId: noHit } })).toMatchObject({ status: 'RESOLVED', resolvedBy: 'u-out' })
    expect(await db.flowEvent.findUniqueOrThrow({ where: { qmsInspectionId: noHit } })).toMatchObject({ type: 'RETURN', source: 'QMS_INSPECTION', stepId: weld!.id })
    const next = await todosOf(paint!.id)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ action: 'ARRANGE_SEND', ownerId: 'u-pm', status: 'OPEN' })
    expect((await partOf(part.id)).currentStepId).toBe(paint!.id)
    await expect(s.match.resolveUnmatched(noHit, weld!.id, 'u-out')).rejects.toBeInstanceOf(s.errors.FlowError)
  })

  it('两个候选 → MULTIPLE；忽略后不再出现', async () => {
    const { part, steps } = await makePart()
    await send(steps[0]!.id, 'S-WELD')
    await send(steps[1]!.id, 'S-PAINT') // 现场先后不一：前一道没回来也能发
    const id = await inspect({ partId: part.qmsPartId })
    expect(await s.match.matchInspection(id)).toMatchObject({ status: 'unmatched', reason: 'MULTIPLE' })
    await s.match.ignoreUnmatched(id, 'u-out')
    expect((await db.unmatchedInspection.findUniqueOrThrow({ where: { qmsInspectionId: id } })).status).toBe('IGNORED')
    expect((await s.match.listUnmatched()).some((u) => u.qmsInspectionId === id)).toBe(false)
  })

  it('最后一道（自制）开工、完工后工件变为已完成', async () => {
    const { part, steps } = await makePart()
    const [weld, paint, assy] = steps
    await send(weld!.id, 'S-WELD')
    await s.match.matchInspection(await inspect({ partId: part.qmsPartId, supplierId: 'S-WELD' }))
    await send(paint!.id, 'S-PAINT')
    await s.flow.manualReturn({ stepId: paint!.id, qty: 1, actorId: 'u-out', source: 'MOBILE' })
    expect((await stepOf(paint!.id)).status).toBe('DONE')
    const startTodos = await todosOf(assy!.id)
    expect(startTodos).toHaveLength(1)
    expect(startTodos[0]).toMatchObject({ action: 'ARRANGE_START', ownerId: 'u-pm' })

    await expect(s.flow.sendStep({ stepId: assy!.id, promisedReturnDate: day('2026-10-30'), actorId: 'u-pm', source: 'PC' })).rejects.toBeInstanceOf(
      s.errors.FlowError,
    )
    await s.flow.startStep({ stepId: assy!.id, actorId: 'u-pm', source: 'MOBILE' })
    expect((await stepOf(assy!.id)).status).toBe('IN_PROGRESS')
    expect((await todosOf(assy!.id))[0]!.status).toBe('DONE')
    await s.flow.finishStep({ stepId: assy!.id, actorId: 'u-pm', source: 'MOBILE' })
    expect((await stepOf(assy!.id)).status).toBe('DONE')
    expect((await partOf(part.id)).status).toBe('DONE')
  })

  it('撤销的报检：匹配过的进待确认（不回退步骤），没匹配过的忽略', async () => {
    const { part, steps } = await makePart()
    await send(steps[0]!.id, 'S-WELD')
    const matched = await inspect({ partId: part.qmsPartId })
    await s.match.matchInspection(matched)
    await db.qmsInspection.update({ where: { id: matched }, data: { status: 'CANCELLED' } })

    const never = await inspect({ partName: '对不上', processName: '组焊' })
    await db.qmsInspection.update({ where: { id: never }, data: { status: 'CANCELLED' } })

    const results = await s.match.matchPendingInspections()
    expect(results.find((r) => r.inspectionId === matched)).toMatchObject({ status: 'unmatched', reason: 'CANCELLED_AFTER_MATCH' })
    expect(results.find((r) => r.inspectionId === never)).toMatchObject({ status: 'ignored' })
    expect((await stepOf(steps[0]!.id)).status).toBe('DONE')
    expect(await db.unmatchedInspection.findUnique({ where: { qmsInspectionId: never } })).toBeNull()
    // 再跑一轮不会重复写
    const again = await s.match.matchPendingInspections()
    expect(again.find((r) => r.inspectionId === matched)).toBeUndefined()
    await expect(s.match.resolveUnmatched(matched, steps[0]!.id, 'u-out')).rejects.toBeInstanceOf(s.errors.FlowError)
  })

  it('人工关联过的报检被撤销后重新提示；不能关联到别的工单的步骤', async () => {
    const { steps } = await makePart()
    await send(steps[0]!.id, 'S-WELD')
    const id = await inspect({ partName: '写错的名字', processName: '组焊' })
    await s.match.matchInspection(id)

    // 别的工单下的步骤
    await db.qmsWorkOrder.create({
      data: { workOrderNumber: 'T-WO-2', customerName: '另一客户', quantity: 1, deliveryDate: day('2026-12-31'), status: 'IN_PROGRESS', updatedAt: new Date() },
    })
    const other = await s.steps.createPart('T-WO-2', { name: '别的件', quantity: 1 })
    const otherStep = await s.steps.addStep(other.id, { processId: 'P-WELD', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-WELD' }, 'u-out')
    await expect(s.match.resolveUnmatched(id, otherStep.id, 'u-out')).rejects.toThrow('同一工单')
    expect(await db.flowEvent.count({ where: { qmsInspectionId: id } })).toBe(0)

    await s.match.resolveUnmatched(id, steps[0]!.id, 'u-out')
    await db.qmsInspection.update({ where: { id }, data: { status: 'CANCELLED' } })
    const results = await s.match.matchPendingInspections()
    expect(results.find((r) => r.inspectionId === id)).toMatchObject({ status: 'unmatched', reason: 'CANCELLED_AFTER_MATCH' })
    expect(await db.unmatchedInspection.findUniqueOrThrow({ where: { qmsInspectionId: id } })).toMatchObject({ status: 'PENDING', resolvedBy: null })
    expect((await s.match.matchPendingInspections()).find((r) => r.inspectionId === id)).toBeUndefined()
  })

  it('工序链：有流转记录的步骤不能删除、不能调顺序；复制工序链不带日期和状态', async () => {
    const { part, steps } = await makePart()
    await s.steps.updateStep(steps[0]!.id, { dueDate: day('2026-11-01') })
    await send(steps[0]!.id, 'S-WELD')
    await expect(s.steps.deleteStep(steps[0]!.id)).rejects.toThrow('不能删除')
    await expect(s.steps.moveStep(steps[1]!.id, 'up')).rejects.toThrow('不能调整顺序')
    await expect(s.steps.deletePart(part.id)).rejects.toBeInstanceOf(s.errors.FlowError)

    // 没有记录的可以调整、删除
    await s.steps.moveStep(steps[2]!.id, 'up')
    const order = await db.routeStep.findMany({ where: { partId: part.id }, orderBy: { seq: 'asc' } })
    expect(order.map((o) => o.processId)).toEqual(['P-WELD', 'P-ASSY', 'P-PAINT'])

    const target = await s.steps.createPart(WO, { name: '同类件', quantity: 2 })
    expect(await s.steps.copyRoute(target.id, part.id, 'u-pm')).toEqual({ copied: 3 })
    const copied = await db.routeStep.findMany({ where: { partId: target.id }, orderBy: { seq: 'asc' } })
    expect(copied.map((c) => [c.seq, c.processId, c.mode, c.supplierId, c.ownerId, c.status, c.dueDate, c.promisedReturnDate])).toEqual([
      [1, 'P-WELD', 'EXTERNAL_OUTSOURCE', 'S-WELD', 'u-out', 'PENDING', null, null],
      [2, 'P-ASSY', 'SELF', null, 'u-pm', 'PENDING', null, null],
      [3, 'P-PAINT', 'EXTERNAL_OUTSOURCE', 'S-PAINT', 'u-pm', 'PENDING', null, null],
    ])
    await s.steps.deleteStep(copied[1]!.id)
    expect(await db.routeStep.count({ where: { partId: target.id } })).toBe(2)
  })

  it('待办转交：原待办标记已转交，新负责人收到一条', async () => {
    const { part, steps } = await makePart()
    await send(steps[0]!.id, 'S-WELD')
    await s.match.matchInspection(await inspect({ partId: part.qmsPartId }))
    const [todo] = await todosOf(steps[1]!.id)
    const moved = await s.todos.transferTodo(todo!.id, 'u-out')
    expect(moved).toMatchObject({ ownerId: 'u-out', action: 'ARRANGE_SEND', refId: steps[1]!.id, status: 'OPEN' })
    expect((await db.todo.findUniqueOrThrow({ where: { id: todo!.id } })).status).toBe('TRANSFERRED')
    await expect(s.todos.transferTodo(todo!.id, 'u-pm')).rejects.toBeInstanceOf(s.errors.FlowError)
  })
})
