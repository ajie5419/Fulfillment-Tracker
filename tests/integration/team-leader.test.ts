/**
 * 生产管理重设计第二批：班组长。
 *   谁负责（flow/responsible.ts）：负责人优先 → 自制派到班组的班组长 → 原来的兜底；班组长看不到这个工单时不发给他。
 *   下一道"安排开工"、第一道"可以开工"、W10 都按这个口径；改负责人 / 班组 / 班组长时没处理的待办跟着换人。
 *   第一道的待办与生产调度同一条规则（readiness.ts firstStepTodoReady）：缺料缺图、等变更时不发，齐了再发。
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
  leaders: typeof import('../../server/services/flow/team-leaders')
  purchases: typeof import('../../server/services/purchases/purchases')
  scan: typeof import('../../server/services/alerts/scan')
  rules: typeof import('../../server/services/alerts/rules')
  auth: typeof import('../../server/utils/auth')
  todos: typeof import('../../server/services/flow/todos')
  templates: typeof import('../../server/services/templates/templates')
}

describe.skipIf(!DB)('班组长（生产管理重设计第二批）', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-TL-1'
  const OTHER_WO = 'T-TL-2'
  const USERS = ['tl-a', 'tl-b', 'tl-lead', 'tl-lead2', 'tl-pm', 'tl-head']
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`)

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      steps: await import('../../server/services/flow/steps'),
      flow: await import('../../server/services/flow/flow'),
      finish: await import('../../server/services/flow/finish'),
      workshop: await import('../../server/services/flow/workshop'),
      leaders: await import('../../server/services/flow/team-leaders'),
      purchases: await import('../../server/services/purchases/purchases'),
      scan: await import('../../server/services/alerts/scan'),
      rules: await import('../../server/services/alerts/rules'),
      auth: await import('../../server/utils/auth'),
      todos: await import('../../server/services/flow/todos'),
      templates: await import('../../server/services/templates/templates'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    const wos = [WO, OTHER_WO]
    await db.todo.deleteMany()
    await db.reminder.deleteMany({ where: { userId: { in: USERS } } })
    await db.flowEvent.deleteMany({ where: { step: { part: { workOrderNumber: { in: wos } } } } })
    await db.purchaseLine.deleteMany({ where: { workOrderNumber: { in: wos } } })
    await db.part.deleteMany({ where: { workOrderNumber: { in: wos } } })
    await db.workOrderExt.deleteMany({ where: { workOrderNumber: { in: wos } } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { in: wos } } })
    await db.notifyRole.deleteMany({ where: { userId: { in: USERS } } })
    await db.qmsSupplier.deleteMany({ where: { id: { in: ['TL-TEAM', 'TL-TEAM2', 'TL-OUT'] } } })
    await db.routeTemplate.deleteMany({ where: { name: 'TL-模板' } })
    await db.qmsProcess.deleteMany({ where: { id: { in: ['TL-CUT', 'TL-WELD'] } } })
    await db.qmsUser.deleteMany({ where: { id: { in: USERS } } })

    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: wos.map((wo) => ({ workOrderNumber: wo, customerName: '测试客户', quantity: 1, deliveryDate: day('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
    })
    // tl-pm 只是别的工单的项目经理（没有通知角色）→ 只能看 OTHER_WO
    await db.workOrderExt.create({ data: { workOrderNumber: OTHER_WO, projectManagerId: 'tl-pm' } })
    await db.qmsSupplier.createMany({
      data: [
        { id: 'TL-TEAM', name: '组焊班', kind: 'TEAM', updatedAt: now },
        { id: 'TL-TEAM2', name: '没设班组长的班', kind: 'TEAM', updatedAt: now },
        { id: 'TL-OUT', name: '外协厂', updatedAt: now },
      ],
    })
    await db.qmsProcess.createMany({
      data: [
        { id: 'TL-CUT', name: '下料', supplierSource: 'Supplier', updatedAt: now },
        { id: 'TL-WELD', name: '组焊', supplierSource: 'Supplier', updatedAt: now },
      ],
    })
    await db.qmsUser.createMany({ data: USERS.map((id) => ({ id, username: id, realName: id, departmentId: 'D', status: 'ACTIVE', updatedAt: now })) })
    await db.notifyRole.create({ data: { role: 'DEPT_HEAD', userId: 'tl-head', department: '生产部' } })
    await s.leaders.setTeamLeader('TL-TEAM', 'tl-lead', 'tl-head')
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  /** 下料（自制，负责人 tl-a）→ 组焊（自制，派到 team，负责人 owner） */
  async function chain(name: string, team: string | null, owner: string | null, wo = WO) {
    const part = await s.steps.createPart(wo, { name, quantity: 1 })
    const cut = await s.steps.addStep(part.id, { processId: 'TL-CUT', mode: 'SELF', ownerId: 'tl-a' }, 'tl-a')
    const weld = await s.steps.addStep(part.id, { processId: 'TL-WELD', mode: 'SELF', supplierId: team }, 'tl-a')
    await db.routeStep.update({ where: { id: weld.id }, data: { ownerId: owner } }) // addStep 默认负责人是创建人，这里按用例改
    return { part, cut, weld }
  }
  const openTodos = (refId: string) => db.todo.findMany({ where: { refId, status: 'OPEN' }, select: { ownerId: true, action: true } })
  const finish = (stepId: string) => s.finish.finishStep({ stepId, actorId: 'tl-a', source: 'PC' })

  it('下一道没指定负责人、派到班组：上一道完工后"安排开工"发给班组长；指定了负责人时负责人优先', async () => {
    const a = await chain('班组长件', 'TL-TEAM', null)
    await finish(a.cut.id)
    expect(await openTodos(a.weld.id)).toEqual([{ ownerId: 'tl-lead', action: 'ARRANGE_START' }])

    const b = await chain('有负责人件', 'TL-TEAM', 'tl-b')
    await finish(b.cut.id)
    expect(await openTodos(b.weld.id)).toEqual([{ ownerId: 'tl-b', action: 'ARRANGE_START' }])
  })

  it('班组没设班组长、或班组长看不到这个工单：退回原来的兜底（上一道负责人）', async () => {
    const a = await chain('没班组长件', 'TL-TEAM2', null)
    await finish(a.cut.id)
    expect(await openTodos(a.weld.id)).toEqual([{ ownerId: 'tl-a', action: 'ARRANGE_START' }])

    // 班组长换成只看本人工单的项目经理 tl-pm：看不到 WO，不发给他
    await s.leaders.setTeamLeader('TL-TEAM2', 'tl-pm', 'tl-head')
    const b = await chain('看不到的件', 'TL-TEAM2', null)
    await finish(b.cut.id)
    expect(await openTodos(b.weld.id)).toEqual([{ ownerId: 'tl-a', action: 'ARRANGE_START' }])
    // 他自己的工单上照常发给他
    const c = await chain('他能看的件', 'TL-TEAM2', null, OTHER_WO)
    await finish(c.cut.id)
    expect(await openTodos(c.weld.id)).toEqual([{ ownerId: 'tl-pm', action: 'ARRANGE_START' }])
    await s.leaders.setTeamLeader('TL-TEAM2', null, 'tl-head')
  })

  it('改负责人、改班组、换班组长：没处理的待办跟着换人（原待办标已转交）；改回没人负责时回到班组长', async () => {
    const { weld, cut } = await chain('转交件', 'TL-TEAM', null)
    await finish(cut.id)
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-lead', action: 'ARRANGE_START' }])

    await s.steps.updateStep(weld.id, { ownerId: 'tl-b' })
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-b', action: 'ARRANGE_START' }])
    expect(await db.todo.count({ where: { refId: weld.id, ownerId: 'tl-lead', status: 'TRANSFERRED' } })).toBe(1)

    await s.steps.updateStep(weld.id, { ownerId: null })
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-lead', action: 'ARRANGE_START' }])

    // 批量编排改到没班组长的班：按同一口径回到兜底（上一道负责人）；再改回来又转给班组长
    const part = await db.routeStep.findUniqueOrThrow({ where: { id: weld.id }, select: { partId: true } })
    await s.steps.batchUpdateSteps({ partIds: [part.partId], processId: 'TL-WELD', set: { supplierId: 'TL-TEAM2' } })
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-a', action: 'ARRANGE_START' }])
    await s.steps.batchUpdateSteps({ partIds: [part.partId], processId: 'TL-WELD', set: { supplierId: 'TL-TEAM' } })
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-lead', action: 'ARRANGE_START' }])

    // 换班组长：没指定负责人的待开工工序，待办从原班组长转给新班组长
    expect(await s.leaders.setTeamLeader('TL-TEAM', 'tl-lead2', 'tl-head')).toMatchObject({ changed: true })
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-lead2', action: 'ARRANGE_START' }])
    await s.leaders.setTeamLeader('TL-TEAM', 'tl-lead', 'tl-head')
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-lead', action: 'ARRANGE_START' }])
  })

  it('换班组长按"实际在谁手里"转：原班组长看不到工单时待办在兜底的人手里，换成看得到的班组长要转过去；清除班组长转回兜底', async () => {
    await s.leaders.setTeamLeader('TL-TEAM2', 'tl-pm', 'tl-head') // tl-pm 看不到 WO
    const { weld, cut } = await chain('兜底件', 'TL-TEAM2', null)
    await finish(cut.id)
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-a', action: 'ARRANGE_START' }])

    await s.leaders.setTeamLeader('TL-TEAM2', 'tl-lead2', 'tl-head')
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-lead2', action: 'ARRANGE_START' }])
    expect(await db.todo.count({ where: { refId: weld.id, ownerId: 'tl-a', status: 'TRANSFERRED' } })).toBe(1)

    await s.leaders.setTeamLeader('TL-TEAM2', null, 'tl-head')
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-a', action: 'ARRANGE_START' }])
  })

  it('手工转交出去的待办不被改负责人 / 换班组长抢回来', async () => {
    const { weld, cut } = await chain('手工转交件', 'TL-TEAM2', null)
    await finish(cut.id)
    const [t] = await db.todo.findMany({ where: { refId: weld.id, status: 'OPEN' } })
    expect(t!.ownerId).toBe('tl-a') // 兜底
    await s.todos.transferTodo(t!.id, 'tl-b')
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-b', action: 'ARRANGE_START' }])

    // 改负责人：原来"按规则在谁手里"是 tl-a，tl-b 手里的是手工转交的，不动
    await s.steps.updateStep(weld.id, { ownerId: 'tl-lead2' })
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-b', action: 'ARRANGE_START' }])
    await s.steps.updateStep(weld.id, { ownerId: null })
    // 设班组长：同样不动
    await s.leaders.setTeamLeader('TL-TEAM2', 'tl-lead2', 'tl-head')
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-b', action: 'ARRANGE_START' }])
    await s.leaders.setTeamLeader('TL-TEAM2', null, 'tl-head')
    expect(await openTodos(weld.id)).toEqual([{ ownerId: 'tl-b', action: 'ARRANGE_START' }])
  })

  it('"我的"（生产调度）= 本人负责的 + 本人当班组长的班组的自制工序；行上带班组长，主按钮不是"指定负责人"', async () => {
    const { weld, cut } = await chain('我的件', 'TL-TEAM', null)
    await finish(cut.id)
    const ctx = await s.auth.loadRoleContext('tl-lead', false)
    expect(ctx.leadOf).toEqual(['TL-TEAM'])
    const mine = await s.workshop.listProduction({ workOrderNumber: WO, mine: { userId: 'tl-lead', teamIds: ctx.leadOf! } })
    expect(mine.rows.find((r) => r.stepId === weld.id)).toMatchObject({ column: 'ready', ownerId: null, leaderId: 'tl-lead', leaderName: 'tl-lead' })
    expect(mine.rows.some((r) => r.stepId === cut.id)).toBe(false) // 下料是 tl-a 的，不派班组
    const plain = await s.workshop.listProduction({ workOrderNumber: WO, mine: { userId: 'tl-lead', teamIds: [] } })
    expect(plain.rows.some((r) => r.stepId === weld.id)).toBe(false)
  })

  it('W10：加工中超期、没指定负责人的自制工序，提醒发给班组长', async () => {
    const part = await s.steps.createPart(WO, { name: 'W10 件', quantity: 1 })
    const step = await s.steps.addStep(part.id, { processId: 'TL-WELD', mode: 'SELF', supplierId: 'TL-TEAM', dueDate: day('2026-10-01') }, 'tl-a')
    await db.routeStep.update({ where: { id: step.id }, data: { ownerId: null, status: 'IN_PROGRESS', startedAt: day('2026-09-20') } })
    const targets = await s.scan.collectTargets(new Date('2026-10-10T08:00:00.000Z'), s.rules.DEFAULT_THRESHOLDS, [], 'W10')
    expect(targets.find((t) => t.refId === step.id)).toMatchObject({ ownerIds: ['tl-lead'] })
    await db.routeStep.update({ where: { id: step.id }, data: { ownerId: 'tl-b' } })
    const again = await s.scan.collectTargets(new Date('2026-10-10T08:00:00.000Z'), s.rules.DEFAULT_THRESHOLDS, [], 'W10')
    expect(again.find((t) => t.refId === step.id)).toMatchObject({ ownerIds: ['tl-b'] })
    await db.routeStep.update({ where: { id: step.id }, data: { status: 'DONE', finishedAt: new Date() } })
  })

  it('第一道（厂外外协）的待办与生产调度同一条规则：缺料时不发、显示卡住；到齐后才发"可以开工"；等变更时作废、解除后补发', async () => {
    const part = await s.steps.createPart(WO, { name: '外协第一道件', quantity: 1 })
    const send = await s.steps.addStep(part.id, { processId: 'TL-WELD', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'TL-OUT', ownerId: 'tl-b' }, 'tl-a')
    const line = await db.purchaseLine.create({ data: { workOrderNumber: WO, partId: part.id, materialName: '钢板', quantity: 1, needDate: day('2026-11-20') } })
    const row = async () => (await s.workshop.listProduction({ workOrderNumber: WO })).rows.find((r) => r.stepId === send.id)
    const todosOfPart = () => db.todo.findMany({ where: { OR: [{ refId: part.id }, { refId: send.id }], status: 'OPEN' }, select: { ownerId: true, action: true } })

    await s.purchases.purchaseTx((tx) => s.purchases.refreshPartReady(tx, part.id, true))
    expect(await row()).toMatchObject({ column: 'stuck', stuckKind: 'MATERIAL' })
    expect(await todosOfPart()).toEqual([]) // 不发"安排发出"，也不发"可以开工"

    await s.purchases.confirmArrival(line.id, { source: 'PC' }, 'tl-a')
    expect(await row()).toMatchObject({ column: 'ready' })
    expect(await todosOfPart()).toEqual([{ ownerId: 'tl-b', action: 'READY_TO_START' }])

    // 等变更：不能开工 → 作废；解除 → 补发
    await db.routeStep.update({ where: { id: send.id }, data: { holdReleaseId: 'T-REL-X' } })
    expect(await s.purchases.purchaseTx((tx) => s.purchases.refreshPartReady(tx, part.id, false))).toBe('revoked')
    expect(await row()).toMatchObject({ column: 'stuck', stuckKind: 'HELD' })
    expect(await todosOfPart()).toEqual([])
    await db.routeStep.update({ where: { id: send.id }, data: { holdReleaseId: null } })
    expect(await s.purchases.purchaseTx((tx) => s.purchases.refreshPartReady(tx, part.id, true))).toBe('sent')
    expect(await todosOfPart()).toEqual([{ ownerId: 'tl-b', action: 'READY_TO_START' }])
  })

  it('第一道是自制、派到班组、没指定负责人：物料到齐后"可以开工"发给班组长', async () => {
    const part = await s.steps.createPart(WO, { name: '自制第一道件', quantity: 1 })
    const first = await s.steps.addStep(part.id, { processId: 'TL-CUT', mode: 'SELF', supplierId: 'TL-TEAM' }, 'tl-a')
    await db.routeStep.update({ where: { id: first.id }, data: { ownerId: null } })
    const line = await db.purchaseLine.create({ data: { workOrderNumber: WO, partId: part.id, materialName: '圆钢', quantity: 1, needDate: day('2026-11-20') } })
    await s.purchases.confirmArrival(line.id, { source: 'PC' }, 'tl-a')
    expect(await openTodos(part.id)).toEqual([{ ownerId: 'tl-lead', action: 'READY_TO_START' }])
    // 指定负责人：第一道的"可以开工"也跟着换人
    await s.steps.updateStep(first.id, { ownerId: 'tl-b' })
    expect(await openTodos(part.id)).toEqual([{ ownerId: 'tl-b', action: 'READY_TO_START' }])
  })
  it('物料早就齐了、后来才排第一道（加工序 / 复制工序链 / 套模板）：补发"可以开工"；调顺序、删第一道时跟着第一道换人', async () => {
    const arrived = (partId: string) =>
      db.purchaseLine.create({ data: { workOrderNumber: WO, partId, materialName: '方管', quantity: 1, needDate: day('2026-11-20'), status: 'ARRIVED', arrivedDate: day('2026-10-20') } })
    // 加工序
    const a = await s.steps.createPart(WO, { name: '先到料件', quantity: 1 })
    await arrived(a.id)
    await s.purchases.purchaseTx((tx) => s.purchases.refreshPartReady(tx, a.id, true))
    expect(await openTodos(a.id)).toEqual([]) // 还没排工序
    const first = await s.steps.addStep(a.id, { processId: 'TL-CUT', mode: 'SELF', ownerId: 'tl-b' }, 'tl-a')
    expect(await openTodos(a.id)).toEqual([{ ownerId: 'tl-b', action: 'READY_TO_START' }])
    // 追加第二道不影响
    const second = await s.steps.addStep(a.id, { processId: 'TL-WELD', mode: 'SELF', ownerId: 'tl-a' }, 'tl-a')
    expect(await openTodos(a.id)).toEqual([{ ownerId: 'tl-b', action: 'READY_TO_START' }])
    // 调顺序：第二道成了第一道 → 转给它的负责人；删掉它 → 回到原第一道
    await s.steps.moveStep(second.id, 'up')
    expect(await openTodos(a.id)).toEqual([{ ownerId: 'tl-a', action: 'READY_TO_START' }])
    await s.steps.deleteStep(second.id)
    expect(await openTodos(a.id)).toEqual([{ ownerId: 'tl-b', action: 'READY_TO_START' }])
    expect(first.id).toBeTruthy()

    // 复制工序链
    const b = await s.steps.createPart(WO, { name: '先到料件·复制', quantity: 1 })
    await arrived(b.id)
    await s.steps.copyRoute(b.id, a.id, 'tl-a')
    expect(await openTodos(b.id)).toEqual([{ ownerId: 'tl-b', action: 'READY_TO_START' }])

    // 套模板（负责人默认是操作人）
    const tpl = await s.templates.createTemplate({ name: 'TL-模板', steps: [{ processId: 'TL-CUT', mode: 'SELF', supplierId: 'TL-TEAM' }] }, 'tl-a')
    const c = await s.steps.createPart(WO, { name: '先到料件·模板', quantity: 1 })
    await arrived(c.id)
    await s.templates.applyTemplateBatch([c.id], tpl.id, 'tl-a')
    expect(await openTodos(c.id)).toEqual([{ ownerId: 'tl-a', action: 'READY_TO_START' }])
  })
  it('同一道工序并发返厂：只发一条"第一次返厂"待办，已返回数量不丢（先锁工件、READ COMMITTED 锁后读最新）', async () => {
    const part = await s.steps.createPart(WO, { name: '并发返厂件', quantity: 4 })
    const out = await s.steps.addStep(part.id, { processId: 'TL-CUT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'TL-OUT', ownerId: 'tl-a' }, 'tl-a')
    const next = await s.steps.addStep(part.id, { processId: 'TL-WELD', mode: 'SELF', supplierId: 'TL-TEAM' }, 'tl-a')
    await db.routeStep.update({ where: { id: next.id }, data: { ownerId: null } })
    await db.routeStep.update({ where: { id: out.id }, data: { status: 'OUT' } })
    const results = await Promise.all(Array.from({ length: 4 }, () => s.flow.manualReturn({ stepId: out.id, qty: 1, actorId: 'tl-a', source: 'PC' })))
    expect(results.filter((r) => r.todoCreated)).toHaveLength(1)
    expect(await openTodos(next.id)).toEqual([{ ownerId: 'tl-lead', action: 'ARRANGE_START' }])
    expect(await s.purchases.purchaseTx((tx) => s.flow.returnedQty(tx, out.id))).toBe(4)
    expect(await db.routeStep.findUniqueOrThrow({ where: { id: out.id }, select: { status: true } })).toEqual({ status: 'DONE' })
  })
})
