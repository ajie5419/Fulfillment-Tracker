/**
 * 工艺模块（10-27）：真实 MySQL 上直接调用服务层。
 * 覆盖：料单 / 工艺状态流转与变更记录、重复下发拦下、已取消不能改；设计变更涉及已下发料单 → 自动"修改中" + 提醒工艺部负责人（只发能看到工单的人）；
 * 列表视图与统计；设计任务列表、总计划节点上带出料单 / 工艺状态。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
const DAY = 86_400_000

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  rel: typeof import('../../server/services/releases/releases')
  dr: typeof import('../../server/services/drawings/drawings')
  pc: typeof import('../../server/services/process/process')
}

describe.skipIf(!DB)('工艺模块（料单、工艺）', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-PROC'
  const OTHER_WO = 'T-WO-PROC-B'
  const DESIGNER = { userId: 'u-des', isAdmin: false }

  async function clean() {
    await db.purchaseLine.deleteMany()
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.release.deleteMany()
    await db.drawingTask.deleteMany() // 关联工件、变更记录级联删除
    await db.notifyRole.deleteMany()
    await db.workOrderExt.deleteMany()
    await db.todo.deleteMany()
    await db.flowEvent.deleteMany()
    await db.routeStep.deleteMany()
    await db.part.deleteMany()
    await db.qmsWorkOrder.deleteMany()
    await db.qmsProcess.deleteMany()
    await db.qmsUser.deleteMany()
    await db.qmsDepartment.deleteMany()
  }

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      steps: await import('../../server/services/flow/steps'),
      rel: await import('../../server/services/releases/releases'),
      dr: await import('../../server/services/drawings/drawings'),
      pc: await import('../../server/services/process/process'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await clean()
    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [WO, OTHER_WO].map((wo) => ({ workOrderNumber: wo, customerName: '测试客户', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
    })
    await db.qmsProcess.createMany({ data: [{ id: 'P-CUT', name: '下料', updatedAt: now }] })
    const DEPTS = ['技术部', '工艺部', '生产部']
    await db.qmsDepartment.createMany({ data: DEPTS.map((name, i) => ({ id: `PD-${i}`, name, parentId: '0', status: 1, updatedAt: now })) })
    const user = (id: string, realName: string, dept: string, status = 'ACTIVE') => ({ id, username: id, realName, departmentId: `PD-${DEPTS.indexOf(dept)}`, status, updatedAt: now })
    await db.qmsUser.createMany({
      data: [user('u-des', '设计员', '技术部'), user('u-proc', '工艺员', '工艺部'), user('u-prochead', '工艺部长', '工艺部'), user('u-gone', '离职部长', '工艺部', 'DISABLED'), user('u-worker', '班组长', '生产部')],
    })
    await db.notifyRole.createMany({
      data: [
        { role: 'DEPT_HEAD', userId: 'u-prochead', department: '工艺部' },
        // 停用账号不发提醒
        { role: 'DEPT_HEAD', userId: 'u-gone', department: '工艺部' },
      ],
    })
  })

  afterAll(async () => {
    if (db) await clean()
    await db?.$disconnect()
  })

  let seq = 0
  async function makePart(wo = WO) {
    seq++
    return s.steps.createPart(wo, { name: `工件-${seq}`, quantity: 1 })
  }
  const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z')
  const task = (componentName: string, partIds: string[] = [], wo = WO) =>
    s.dr.createTask({ workOrderNumber: wo, componentName, ownerId: 'u-des', planDate: new Date(+today() + 10 * DAY), partIds }, 'u-des')
  const act = (id: string, kind: 'MATERIAL' | 'PROCESS', action: 'start' | 'issue' | 'revise' | 'reset', note?: string) => s.pc.changeStatus(id, { kind, action, note }, 'u-proc')
  async function publish(id: string) {
    await s.dr.markDrawn(id, null, DESIGNER)
    return s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '正式发放', userIds: ['u-worker'], drawingTaskId: id }, 'u-des')
  }

  it('料单：未开始 → 编制中 → 已下发 → 修改中 → 已下发；工艺：无 → 编制中 → 已下发；每步记操作人', async () => {
    const t = await task('车架')
    const fresh = await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })
    expect(fresh).toMatchObject({ materialStatus: 'NOT_STARTED', processStatus: 'NONE' })
    await publish(t.id)

    expect(await act(t.id, 'MATERIAL', 'start')).toMatchObject({ status: 'DRAFTING', statusText: '编制中' })
    await expect(act(t.id, 'MATERIAL', 'start')).rejects.toThrow('料单现在是"编制中"，不能开始编制')
    expect(await act(t.id, 'MATERIAL', 'issue', '第一批')).toMatchObject({ status: 'ISSUED' })
    // 点两次下发：第二次拦下
    await expect(act(t.id, 'MATERIAL', 'issue')).rejects.toThrow('不能下发')
    expect(await act(t.id, 'MATERIAL', 'revise', '尺寸不对')).toMatchObject({ status: 'REVISING' })
    await expect(act(t.id, 'MATERIAL', 'reset')).rejects.toThrow('不能撤回')
    expect(await act(t.id, 'MATERIAL', 'issue')).toMatchObject({ status: 'ISSUED' })

    expect(await act(t.id, 'PROCESS', 'start')).toMatchObject({ status: 'DRAFTING' })
    expect(await act(t.id, 'PROCESS', 'reset')).toMatchObject({ status: 'NONE' })
    await act(t.id, 'PROCESS', 'start')
    expect(await act(t.id, 'PROCESS', 'issue')).toMatchObject({ status: 'ISSUED' })

    const row = await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })
    expect(row).toMatchObject({ materialStatus: 'ISSUED', materialBy: 'u-proc', processStatus: 'ISSUED', processBy: 'u-proc' })
    expect(row.materialAt).toBeInstanceOf(Date)

    const { logs } = await s.pc.listLogs(t.id)
    expect(logs).toHaveLength(8)
    expect(logs.find((l) => l.note === '尺寸不对')).toMatchObject({ kindText: '料单', fromText: '已下发', toText: '修改中', actorName: '工艺员', auto: false })
  })

  it('并发：同时点两次"开始编制"只成功一次', async () => {
    const t = await task('液压系统')
    await publish(t.id)
    const r = await Promise.allSettled([act(t.id, 'MATERIAL', 'start'), act(t.id, 'MATERIAL', 'start')])
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(await db.processDocLog.count({ where: { taskId: t.id } })).toBe(1)
  })

  it('已取消的设计任务不能改，也不在列表里；设计任务不存在报错', async () => {
    const t = await task('取消的部件')
    await s.dr.updateTask(t.id, { cancelled: true })
    await expect(act(t.id, 'MATERIAL', 'start')).rejects.toThrow('已取消')
    const { rows } = await s.pc.listProcess({ workOrderNumber: WO, view: 'all' }, true)
    expect(rows.some((r) => r.id === t.id)).toBe(false)
    await expect(act('no-such-id', 'MATERIAL', 'start')).rejects.toThrow('设计任务不存在')
  })

  it('设计变更涉及已下发的料单：自动改"修改中"、记录关联变更单、提醒工艺部负责人（停用账号不发）；未下发的、别的工单的不动', async () => {
    const p1 = await makePart()
    const p2 = await makePart()
    const issued = await task('驾驶室', [p1.id])
    const drafting = await task('操作台', [p2.id])
    await publish(issued.id)
    await publish(drafting.id)
    await act(issued.id, 'MATERIAL', 'start')
    await act(issued.id, 'MATERIAL', 'issue')
    await act(drafting.id, 'MATERIAL', 'start')

    const r = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, description: '驾驶室改尺寸', partIds: [p1.id, p2.id], userIds: ['u-worker'] }, 'u-des')
    expect(r.material).toEqual({ revising: 1, notified: true })
    expect(await db.drawingTask.findUniqueOrThrow({ where: { id: issued.id } })).toMatchObject({ materialStatus: 'REVISING', materialBy: 'u-des' })
    expect((await db.drawingTask.findUniqueOrThrow({ where: { id: drafting.id } })).materialStatus).toBe('DRAFTING')

    const log = (await s.pc.listLogs(issued.id)).logs[0]!
    expect(log).toMatchObject({ toText: '修改中', auto: true, release: { id: r.id, releaseNo: r.releaseNo }, actorName: '设计员' })

    const rem = await db.reminder.findMany({ where: { kind: 'PROCESS' } })
    expect(rem.map((x) => x.userId)).toEqual(['u-prochead'])
    expect(rem[0]!.title).toContain('驾驶室')
    expect(rem[0]!.title).toContain(WO)
    expect(rem[0]!.link).toBe(`/process?wo=${WO}&view=revising`)

    // 图纸发放（不是设计变更）不会动料单
    await act(issued.id, 'MATERIAL', 'issue')
    const r2 = await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '补发', partIds: [p1.id], userIds: ['u-worker'] }, 'u-des')
    expect(r2.material).toEqual({ revising: 0, notified: false })
    expect((await db.drawingTask.findUniqueOrThrow({ where: { id: issued.id } })).materialStatus).toBe('ISSUED')
  })

  it('从设计任务发设计变更：这个任务的料单已下发也改"修改中"；没设工艺部负责人时 notified=false', async () => {
    const t = await task('车桥')
    await s.dr.markDrawn(t.id, null, DESIGNER)
    await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '车桥图纸', userIds: ['u-worker'], drawingTaskId: t.id }, 'u-des')
    await act(t.id, 'MATERIAL', 'start')
    await act(t.id, 'MATERIAL', 'issue')
    await db.notifyRole.deleteMany({ where: { department: '工艺部' } })
    const r = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, description: '车桥变更', userIds: ['u-worker'], drawingTaskId: t.id }, 'u-des')
    expect(r.material).toEqual({ revising: 1, notified: false })
    expect((await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })).materialStatus).toBe('REVISING')
    await db.notifyRole.create({ data: { role: 'DEPT_HEAD', userId: 'u-prochead', department: '工艺部' } })
  })

  it('列表：视图、统计、按钮只给能改的人；设计任务列表带出料单 / 工艺摘要', async () => {
    const t = await task('图纸已发的部件')
    await s.dr.markDrawn(t.id, null, DESIGNER)
    await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '发图', userIds: ['u-worker'], drawingTaskId: t.id }, 'u-des')
    const other = await task('别的工单部件', [], OTHER_WO)

    const waiting = await s.pc.listProcess({ workOrderNumber: WO, view: 'waiting' }, true)
    expect(waiting.rows.map((r) => r.id)).toEqual([t.id])
    expect(waiting.rows[0]).toMatchObject({ drawingStatusText: '已完成', materialStatusText: '未开始', processStatusText: '无', actions: { material: ['start'], process: ['start'] } })
    expect(waiting.rows[0]!.drawingRelease?.releaseNo).toBeTruthy()
    expect(waiting.stats.waiting).toBe(1)

    const readOnly = await s.pc.listProcess({ workOrderNumber: WO, view: 'all' }, false)
    expect(readOnly.rows.every((r) => !r.actions.material.length && !r.actions.process.length)).toBe(true)

    const revising = await s.pc.listProcess({ workOrderNumber: WO, view: 'revising' }, true)
    expect(revising.rows.map((r) => r.componentName)).toEqual(['车桥'])
    expect(revising.stats.revising).toBe(1)

    // 可见范围：只看 OTHER_WO 的人看不到 WO 的部件
    const scoped = await s.pc.listProcess({ view: 'all', visibleWorkOrders: [OTHER_WO] }, true)
    expect(scoped.rows.map((r) => r.id)).toEqual([other.id])
    expect(scoped.stats.total).toBe(1)

    const { rows } = await s.dr.listTasks({ workOrderNumber: WO, view: 'all' }, DESIGNER)
    expect(rows.find((r) => r.componentName === '车桥')?.processText).toBe('料单修改中 · 工艺无')
    expect(rows.find((r) => r.componentName === '车架')?.processText).toBe('料单已下发 · 工艺已下发')
  })
  it('物料到齐、设计完成后仍等料单：下发发待办、修改撤销；已开工和后续工序不受回退影响', async () => {
    const purchases = await import('../../server/services/purchases/purchases')
    const workshop = await import('../../server/services/flow/workshop')
    const flow = await import('../../server/services/flow/flow')
    const parts = [await makePart(), await makePart()]
    const t = await task('料单开工回归', parts.map((p) => p.id))
    const steps: Awaited<ReturnType<Services['steps']['addStep']>>[] = []
    for (const part of parts) {
      steps.push(await s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-worker' }, 'u-worker'))
      const line = await db.purchaseLine.create({ data: { workOrderNumber: WO, partId: part.id, materialName: '钢板', quantity: 1, needDate: today() } })
      await purchases.confirmArrival(line.id, { source: 'PC' }, 'u-proc')
    }
    await s.dr.markDrawn(t.id, null, DESIGNER)
    await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '料单前提回归', userIds: ['u-worker'], drawingTaskId: t.id }, 'u-des')
    const todos = () => db.todo.findMany({ where: { refId: { in: parts.map((p) => p.id) }, action: 'READY_TO_START', status: 'OPEN' } })
    const rows = async () => (await workshop.listProduction({ workOrderNumber: WO })).rows.filter((r) => steps.some((x) => x.id === r.stepId))
    expect(await todos()).toHaveLength(0)
    expect(await rows()).toEqual(expect.arrayContaining(steps.map((x) => expect.objectContaining({ stepId: x.id, column: 'stuck', stuckKind: 'MATERIAL_LIST', stuckText: '料单未下发' }))))
    const start = (stepId: string) => flow.startStep({ stepId, actorId: 'u-worker', source: 'PC' })
    await expect(start(steps[0]!.id)).rejects.toThrow('料单未下发')
    await db.routeStep.update({ where: { id: steps[1]!.id }, data: { mode: 'EXTERNAL_OUTSOURCE' } })
    await expect(flow.sendStep({ stepId: steps[1]!.id, actorId: 'u-worker', source: 'PC', promisedReturnDate: today() })).rejects.toThrow('料单未下发')
    await db.routeStep.update({ where: { id: steps[1]!.id }, data: { mode: 'SELF' } })
    await act(t.id, 'MATERIAL', 'start')
    await act(t.id, 'MATERIAL', 'reset')
    expect(await todos()).toHaveLength(0)
    await act(t.id, 'MATERIAL', 'start')
    await act(t.id, 'MATERIAL', 'issue')
    expect(await todos()).toHaveLength(2)
    expect((await rows()).every((r) => r.column === 'ready')).toBe(true)
    await act(t.id, 'MATERIAL', 'revise')
    expect(await todos()).toHaveLength(0)
    expect(await db.todo.count({ where: { refId: { in: parts.map((p) => p.id) }, action: 'READY_TO_START', status: 'CANCELLED' } })).toBe(2)
    await act(t.id, 'MATERIAL', 'issue')
    await start(steps[0]!.id)
    await act(t.id, 'MATERIAL', 'revise')
    expect((await rows()).find((r) => r.stepId === steps[0]!.id)?.column).toBe('working')
    await (await import('../../server/services/flow/finish')).finishStep({ stepId: steps[0]!.id, actorId: 'u-worker', source: 'PC' })
    const next = await s.steps.addStep(parts[0]!.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-worker' }, 'u-worker')
    await expect(start(next.id)).resolves.toMatchObject({ status: 'IN_PROGRESS' })
    // 设计变更只选其中一个工件，也必须撤销同一料单关联的其他工件待办。
    await act(t.id, 'MATERIAL', 'issue')
    expect(await todos()).toHaveLength(1)
    await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, description: '自动打回料单', partIds: [parts[0]!.id], userIds: ['u-worker'] }, 'u-des')
    expect(await todos()).toHaveLength(0)
  })

  it('FOR UPDATE 里撞上死锁（P2010 / 1213）也认作死锁，发放会整单重试', async () => {
    const { isDeadlock } = await import('../../server/utils/prisma')
    await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS zz_deadlock (id INT PRIMARY KEY)')
    await db.$executeRawUnsafe('INSERT IGNORE INTO zz_deadlock VALUES (1), (2)')
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const cross = (a: number, b: number) =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM zz_deadlock WHERE id = ${a} FOR UPDATE`
        await wait(300)
        await tx.$queryRaw`SELECT id FROM zz_deadlock WHERE id = ${b} FOR UPDATE`
      }, { timeout: 20_000 })
    try {
      const results = await Promise.allSettled([cross(1, 2), cross(2, 1)])
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(failed).toHaveLength(1)
      expect(failed[0]!.reason.code).toBe('P2010')
      expect(isDeadlock(failed[0]!.reason)).toBe(true)
    } finally {
      await db.$executeRawUnsafe('DROP TABLE IF EXISTS zz_deadlock')
    }
    expect(isDeadlock({ code: 'P2002', meta: { target: 'releaseNo' }, message: 'Unique constraint failed' })).toBe(false)
  })

  it.each([
    ['MATERIAL', 'start', '料单', '开始编制'],
    ['MATERIAL', 'issue', '料单', '下发'],
    ['PROCESS', 'start', '工艺', '开始编制'],
    ['PROCESS', 'issue', '工艺', '下发'],
  ] as const)('未发放时 %s/%s 被拒，状态与日志不变', async (kind, action, label, verb) => {
    const t = await task(`未发放-${kind}-${action}`)
    // 设计完成也不等于正式发放；issue 分支模拟演示环境已有的编制中数据。
    await s.dr.markDrawn(t.id, null, DESIGNER)
    if (action === 'issue') await db.drawingTask.update({ where: { id: t.id }, data: kind === 'MATERIAL' ? { materialStatus: 'DRAFTING' } : { processStatus: 'DRAFTING' } })
    const before = await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })
    await expect(act(t.id, kind, action)).rejects.toThrow(`图纸未发放，不能${verb}${label}`)
    expect(await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })).toEqual(before)
    expect(await db.processDocLog.count({ where: { taskId: t.id } })).toBe(0)
  })

  it.each(['PENDING', 'SIGNED', 'NONE'] as const)('有效发放单即可编制、下发两类文档：签收状态 %s 不构成门槛', async (receipt) => {
    const t = await s.dr.createTask({ workOrderNumber: WO, componentName: `签收-${receipt}`, ownerId: 'u-des', planDate: today(), needsCustomerConfirm: true, customerPlanDate: today() }, 'u-des')
    const release = await publish(t.id)
    const rec = await db.releaseReceipt.findFirstOrThrow({ where: { releaseId: release.id } })
    if (receipt === 'SIGNED') await s.rel.signReceipt(rec.id, 'u-worker')
    if (receipt === 'NONE') await db.releaseReceipt.delete({ where: { id: rec.id } }) // 无需签收的有效单据
    expect((await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('CUSTOMER_PENDING')
    for (const kind of ['MATERIAL', 'PROCESS'] as const) {
      expect(await act(t.id, kind, 'start')).toMatchObject({ status: 'DRAFTING' })
      expect(await act(t.id, kind, 'issue')).toMatchObject({ status: 'ISSUED' })
    }
  })

  it('同工件的独立发放单、缓存的已完成设计状态，均不能代替本任务的有效发放关联', async () => {
    const p = await makePart()
    const t = await task('按任务关联判断', [p.id])
    await s.dr.markDrawn(t.id, null, DESIGNER)
    await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '仅关联工件', partIds: [p.id], userIds: ['u-worker'] }, 'u-des')
    // 模拟历史派生状态失真，前置必须查询发放事实。
    await db.drawingTask.update({ where: { id: t.id }, data: { status: 'DONE' } })
    for (const kind of ['MATERIAL', 'PROCESS'] as const) await expect(act(t.id, kind, 'start')).rejects.toThrow('图纸未发放')
  })

  it('作废同时回退两类已下发文档，记录作废人、来源单据，并撤销开工待办；再次发放、下发恢复', async () => {
    const p = await makePart()
    await s.steps.addStep(p.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-worker' }, 'u-worker')
    const t = await task('作废联动', [p.id])
    const release = await publish(t.id)
    for (const kind of ['MATERIAL', 'PROCESS'] as const) { await act(t.id, kind, 'start'); await act(t.id, kind, 'issue') }
    const ready = () => db.todo.count({ where: { refId: p.id, action: 'READY_TO_START', status: 'OPEN' } })
    expect(await ready()).toBe(1)
    await s.rel.voidRelease(release.id, { userId: 'u-proc', isAdmin: true })
    expect(await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ materialStatus: 'REVISING', processStatus: 'REVISING', materialBy: 'u-proc', processBy: 'u-proc' })
    expect(await ready()).toBe(0)
    const logs = await db.processDocLog.findMany({ where: { taskId: t.id, releaseId: release.id }, orderBy: { kind: 'asc' } })
    expect(logs).toHaveLength(2)
    for (const log of logs) expect(log).toMatchObject({ actorId: 'u-proc', fromStatus: 'ISSUED', toStatus: 'REVISING', note: `因发放单作废 ${release.releaseNo}` })
    for (const kind of ['MATERIAL', 'PROCESS'] as const) await expect(act(t.id, kind, 'issue')).rejects.toThrow('图纸未发放')
    await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '重新发图', userIds: ['u-worker'], drawingTaskId: t.id }, 'u-des')
    expect(await ready()).toBe(0)
    expect(await act(t.id, 'MATERIAL', 'issue')).toMatchObject({ status: 'ISSUED' })
    // 只剩工艺修改中时，列表、统计仍计入待处理，不进入已下发视图。
    for (const view of ['todo', 'revising'] as const) {
      const list = await s.pc.listProcess({ workOrderNumber: WO, view }, true)
      expect(list.rows.find((r) => r.id === t.id)).toMatchObject({ processStatus: 'REVISING', processStatusText: '修改中', actions: { process: ['issue'] } })
      expect(list.stats.revising).toBeGreaterThan(0)
    }
    expect((await s.pc.listProcess({ workOrderNumber: WO, view: 'issued' }, true)).rows.some((r) => r.id === t.id)).toBe(false)
    expect(await act(t.id, 'PROCESS', 'issue')).toMatchObject({ status: 'ISSUED' })
    expect(await ready()).toBe(1)
    await expect(s.rel.voidRelease(release.id, DESIGNER)).rejects.toThrow('已经作废')
    expect(await db.processDocLog.count({ where: { taskId: t.id, releaseId: release.id } })).toBe(2)
  })

  it.each(['MATERIAL', 'PROCESS'] as const)('作废不改 %s 编制中，仍可撤回；只有另一类已下发文档回退', async (drafting) => {
    const t = await task(`保留编制-${drafting}`)
    const release = await publish(t.id)
    for (const kind of ['MATERIAL', 'PROCESS'] as const) {
      await act(t.id, kind, 'start')
      if (kind !== drafting) await act(t.id, kind, 'issue')
    }
    await s.rel.voidRelease(release.id, DESIGNER)
    const row = await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })
    expect(drafting === 'MATERIAL' ? row.materialStatus : row.processStatus).toBe('DRAFTING')
    expect(await db.processDocLog.count({ where: { taskId: t.id, releaseId: release.id } })).toBe(1)
    await expect(act(t.id, drafting, 'issue')).rejects.toThrow('图纸未发放')
    expect(await act(t.id, drafting, 'reset')).toMatchObject({ status: drafting === 'MATERIAL' ? 'NOT_STARTED' : 'NONE' })
    await expect(act(t.id, drafting, 'start')).rejects.toThrow('图纸未发放')
  })

  it.each(['MATERIAL', 'PROCESS'] as const)('设计中无图纸时，%s 开始编制被拒，历史已下发状态仍可回退', async (kind) => {
    const t = await task(`设计中-${kind}`)
    await expect(act(t.id, kind, 'start')).rejects.toThrow('图纸未发放')
    await db.drawingTask.update({ where: { id: t.id }, data: kind === 'MATERIAL' ? { materialStatus: 'ISSUED' } : { processStatus: 'ISSUED' } })
    expect(await act(t.id, kind, 'revise')).toMatchObject({ status: kind === 'MATERIAL' ? 'REVISING' : 'DRAFTING' })
  })

  it.each(['MATERIAL', 'PROCESS'] as const)('并发作废与 %s 下发串行处理，最终不能保留已下发状态', async (kind) => {
    const t = await task(`并发作废-${kind}`)
    const release = await publish(t.id)
    await act(t.id, kind, 'start')
    const results = await Promise.allSettled([act(t.id, kind, 'issue'), s.rel.voidRelease(release.id, DESIGNER)])
    expect(results[1]!.status).toBe('fulfilled')
    if (results[0]!.status === 'rejected') expect(results[0]!.reason.message).toContain('图纸未发放')
    const row = await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })
    expect(kind === 'MATERIAL' ? row.materialStatus : row.processStatus).toBe(results[0]!.status === 'fulfilled' ? 'REVISING' : 'DRAFTING')
  })

  it('作废一版仍回退已下发文档；另一张有效发放单允许再次下发', async () => {
    const t = await task('多版发放')
    const first = await publish(t.id)
    await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '第二版', userIds: ['u-worker'], drawingTaskId: t.id }, 'u-des')
    for (const kind of ['MATERIAL', 'PROCESS'] as const) { await act(t.id, kind, 'start'); await act(t.id, kind, 'issue') }
    await s.rel.voidRelease(first.id, DESIGNER)
    expect(await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'DONE', materialStatus: 'REVISING', processStatus: 'REVISING' })
    for (const kind of ['MATERIAL', 'PROCESS'] as const) expect(await act(t.id, kind, 'issue')).toMatchObject({ status: 'ISSUED' })
  })
})
