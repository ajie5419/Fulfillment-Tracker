/**
 * 工艺模块（10-27）：真实 MySQL 上直接调用服务层。
 * 覆盖：料单 / 工艺状态流转与变更记录、重复下发拦下、已取消不能改；设计变更涉及已下发料单 → 自动"修改中" + 提醒工艺部负责人（只发能看到工单的人）；
 * 列表视图与统计；设计任务列表、总计划节点上带出料单 / 工艺状态。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL
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

  it('料单：未开始 → 编制中 → 已下发 → 修改中 → 已下发；工艺：无 → 编制中 → 已下发；每步记操作人', async () => {
    const t = await task('车架')
    const fresh = await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })
    expect(fresh).toMatchObject({ materialStatus: 'NOT_STARTED', processStatus: 'NONE' })

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
})
