/**
 * 设计出图任务（R11）：真实 MySQL 上直接调用服务层，用 now 注入"快进时钟"。
 * 覆盖：新建 → 标记出图（只有负责人 / 管理员）→ 一键发放（发放单关联任务）→ "可以开工"门槛（物料齐了也要等图纸）、
 * 发放单作废回退、客户确认节点、取消 / 改关联工件、W7 判定与升级阶梯（不转异常）、列表筛选与截断前排序、设计负荷、看板。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL
const DAY = 86_400_000

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  scan: typeof import('../../server/services/alerts/scan')
  rules: typeof import('../../server/services/alerts/rules')
  board: typeof import('../../server/services/issues/board')
  digest: typeof import('../../server/services/alerts/digest')
  pur: typeof import('../../server/services/purchases/purchases')
  rel: typeof import('../../server/services/releases/releases')
  dr: typeof import('../../server/services/drawings/drawings')
  todos: typeof import('../../server/services/flow/todos')
}

describe.skipIf(!DB)('设计出图任务（R11）', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-R11'
  const OTHER_WO = 'T-WO-R11-B'
  const DESIGNER = { userId: 'u-des', isAdmin: false }
  const ADMIN = { userId: 'u-admin', isAdmin: true }
  const STRANGER = { userId: 'u-pm', isAdmin: false }

  async function clean() {
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.issue.deleteMany()
    await db.release.deleteMany() // 签收记录级联删除
    await db.drawingTask.deleteMany() // 关联工件级联删除
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    await db.notifyRole.deleteMany()
    await db.workOrderExt.deleteMany()
    await db.offDay.deleteMany()
    await db.threshold.deleteMany()
    await db.flowEvent.deleteMany()
    await db.todo.deleteMany()
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
      scan: await import('../../server/services/alerts/scan'),
      rules: await import('../../server/services/alerts/rules'),
      board: await import('../../server/services/issues/board'),
      digest: await import('../../server/services/alerts/digest'),
      pur: await import('../../server/services/purchases/purchases'),
      rel: await import('../../server/services/releases/releases'),
      dr: await import('../../server/services/drawings/drawings'),
      todos: await import('../../server/services/flow/todos'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await clean()
    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [WO, OTHER_WO].map((wo) => ({ workOrderNumber: wo, customerName: '测试客户', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
    })
    await db.qmsProcess.createMany({ data: [{ id: 'P-CUT', name: '下料', updatedAt: now }] })
    const DEPTS = ['技术部', '生产部', '项目部', '公司领导']
    await db.qmsDepartment.createMany({ data: DEPTS.map((name, i) => ({ id: `DD-${i}`, name, parentId: '0', status: 1, updatedAt: now })) })
    const user = (id: string, realName: string, dept: string) => ({ id, username: id, realName, departmentId: `DD-${DEPTS.indexOf(dept)}`, status: 'ACTIVE', updatedAt: now })
    await db.qmsUser.createMany({
      data: [
        user('u-des', '设计员', '技术部'),
        user('u-tech', '技术部长', '技术部'),
        user('u-worker', '班组长', '生产部'),
        user('u-prodhead', '生产经理', '生产部'),
        user('u-pm', '项目经理', '项目部'),
        user('u-pdh', '项目部负责人', '项目部'),
        user('u-lead', '分管领导', '公司领导'),
      ],
    })
    await db.notifyRole.createMany({
      data: [
        { role: 'DEPT_HEAD', userId: 'u-tech', department: '技术部' },
        { role: 'DEPT_HEAD', userId: 'u-prodhead', department: '生产部' },
        { role: 'PROJECT_DEPT_HEAD', userId: 'u-pdh' },
        { role: 'LEADER', userId: 'u-lead' },
      ],
    })
    await db.workOrderExt.create({ data: { workOrderNumber: WO, projectManagerId: 'u-pm' } })
  })

  afterAll(async () => {
    if (db) await clean()
    await db?.$disconnect()
  })

  const today = () => new Date(`${s.rules.shanghaiDay(new Date())}T00:00:00.000Z`)
  const dayOff = (n: number) => new Date(+today() + n * DAY)
  let seq = 0
  async function makePart(wo = WO) {
    seq++
    const part = await s.steps.createPart(wo, { name: `工件-${seq}`, quantity: 1 })
    await s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-worker' }, 'u-worker')
    return part
  }
  const task = (over: Partial<Parameters<Services['dr']['createTask']>[0]> = {}) =>
    s.dr.createTask({ workOrderNumber: WO, componentName: '主梁总图', ownerId: 'u-des', planDate: dayOff(10), ...over }, 'u-pm')
  const release = (taskId: string | null, over: Partial<Parameters<Services['rel']['createRelease']>[0]> = {}) =>
    s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '图纸发放', userIds: ['u-worker'], drawingTaskId: taskId, ...over }, 'u-des')
  const readyTodos = (partId: string) => db.todo.findMany({ where: { refType: 'part', refId: partId, action: 'READY_TO_START' }, orderBy: { createdAt: 'asc' } })
  const statusOf = async (id: string) => (await db.drawingTask.findUniqueOrThrow({ where: { id } })).status

  it('创建 → 出图 → 发放 → 可以开工：物料齐了也要等图纸；发放单作废回退、再发放再发', async () => {
    const part = await makePart()
    const line = await s.pur.createLine({ workOrderNumber: WO, partId: part.id, materialName: '回转支承', quantity: 1, needDate: dayOff(20) }, 'u-pm')
    const t = await task({ partIds: [part.id] })
    expect(t).toMatchObject({ status: 'PENDING', createdBy: 'u-pm' })
    await expect(task({ partIds: [(await makePart(OTHER_WO)).id] })).rejects.toThrow('不属于该工单')
    await expect(task({ ownerId: 'u-nobody' })).rejects.toThrow('设计负责人不存在')
    await expect(task({ customerPlanDate: dayOff(3) })).rejects.toThrow('不需要客户确认')

    // 物料到了，但图纸还没出 → 不发"可以开工"
    expect((await s.pur.confirmArrival(line.id, { source: 'PC' }, 'u-worker')).readySent).toBe(false)
    expect(await readyTodos(part.id)).toHaveLength(0)

    // 还没出图不能发放
    await expect(release(t.id)).rejects.toThrow('还没有出图')
    // 只有负责人本人或管理员能标记出图；出图日不能晚于今天
    await expect(s.dr.markDrawn(t.id, null, STRANGER)).rejects.toThrow('只有设计负责人本人或管理员')
    await expect(s.dr.markDrawn(t.id, dayOff(1), DESIGNER)).rejects.toThrow('不能晚于今天')
    expect(await s.dr.markDrawn(t.id, null, DESIGNER)).toMatchObject({ status: 'DRAWN', readySent: 0 })
    expect(await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ drawnDate: today(), drawnBy: 'u-des' })
    await expect(s.dr.markDrawn(t.id, null, ADMIN)).rejects.toThrow('已经标记过出图')
    expect(await readyTodos(part.id)).toHaveLength(0)

    // 发放：工单要一致、类型只能图纸 / 设计变更
    await expect(release(t.id, { workOrderNumber: OTHER_WO })).rejects.toThrow('不属于该工单')
    await expect(release(t.id, { type: 'PROCESS' })).rejects.toThrow('图纸或设计变更')
    const r1 = await release(t.id, { partIds: [part.id] })
    expect(r1.drawing).toMatchObject({ status: 'DONE', readySent: 1 })
    expect((await db.release.findUniqueOrThrow({ where: { id: r1.id } })).drawingTaskId).toBe(t.id)
    let todos = await readyTodos(part.id)
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ ownerId: 'u-worker', status: 'OPEN' })
    const mine = await s.todos.listMyTodos('u-worker')
    expect(mine.find((x) => x.action === 'READY_TO_START')?.suggestion).toContain('图纸已发放（1 个出图任务）')

    // 已发放的不能撤销出图
    await expect(s.dr.undoDrawn(t.id, DESIGNER)).rejects.toThrow('请先作废发放单')

    // 发放单作废 → 任务回到已出图，没处理的"可以开工"作废
    await s.rel.voidRelease(r1.id, { userId: 'u-des', isAdmin: false })
    expect(await statusOf(t.id)).toBe('DRAWN')
    todos = await readyTodos(part.id)
    expect(todos.map((x) => x.status)).toEqual(['CANCELLED'])

    // 再发放 → 再发
    const r2 = await release(t.id)
    expect(r2.drawing).toMatchObject({ status: 'DONE', readySent: 1 })
    expect((await readyTodos(part.id)).filter((x) => x.status === 'OPEN')).toHaveLength(1)

    // 再挂一个待出图任务 → 没处理的待办作废
    const t2 = await task({ partIds: [part.id], componentName: '主梁零件图' })
    expect((await readyTodos(part.id)).filter((x) => x.status === 'OPEN')).toHaveLength(0)
    // 取消它 → 挡着的没了，重新发
    expect(await s.dr.updateTask(t2.id, { cancelled: true })).toMatchObject({ status: 'CANCELLED', readySent: 1 })
    // 重新启用 → 又挡住
    expect(await s.dr.updateTask(t2.id, { cancelled: false })).toMatchObject({ status: 'PENDING' })
    expect((await readyTodos(part.id)).filter((x) => x.status === 'OPEN')).toHaveLength(0)
    // 改关联工件（移走）→ 原工件不再被挡，重新发
    expect(await s.dr.updateTask(t2.id, { partIds: [] })).toMatchObject({ status: 'PENDING', readySent: 1 })
  })

  it('客户确认是独立节点：发放后待客户确认，确认后才算完成；只挂出图任务的工件也会发"可以开工"', async () => {
    const part = await makePart()
    const t = await task({ partIds: [part.id], needsCustomerConfirm: true, customerPlanDate: dayOff(5), componentName: '液压系统' })
    await expect(s.dr.confirmCustomer(t.id, null, 'u-pm')).rejects.toThrow('还没有出图')
    await s.dr.markDrawn(t.id, dayOff(-1), ADMIN)
    expect((await release(t.id)).drawing).toMatchObject({ status: 'CUSTOMER_PENDING', readySent: 0 })
    expect(await readyTodos(part.id)).toHaveLength(0)
    await expect(s.dr.confirmCustomer(t.id, dayOff(1), 'u-pm')).rejects.toThrow('不能晚于今天')
    expect(await s.dr.confirmCustomer(t.id, null, 'u-pm')).toMatchObject({ status: 'DONE', readySent: 1 })
    expect(await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ customerConfirmedDate: today(), customerConfirmedBy: 'u-pm' })
    await expect(s.dr.confirmCustomer(t.id, null, 'u-pm')).rejects.toThrow('已经确认过')
    // 撤销确认 → 回到待客户确认，待办作废
    expect(await s.dr.undoCustomer(t.id)).toMatchObject({ status: 'CUSTOMER_PENDING' })
    expect((await readyTodos(part.id)).map((x) => x.status)).toEqual(['CANCELLED'])

    // 先确认、后发放：发放后直接完成；不需要客户确认的不能录
    const t3 = await task({ needsCustomerConfirm: true, customerPlanDate: dayOff(5), componentName: '先确认' })
    await s.dr.markDrawn(t3.id, null, DESIGNER)
    expect(await s.dr.confirmCustomer(t3.id, null, 'u-pm')).toMatchObject({ status: 'DRAWN' })
    expect((await release(t3.id)).drawing).toMatchObject({ status: 'DONE' })
    const t4 = await task({ componentName: '不需要确认' })
    await s.dr.markDrawn(t4.id, null, DESIGNER)
    await expect(s.dr.confirmCustomer(t4.id, null, 'u-pm')).rejects.toThrow('不需要客户确认')
    // 撤销出图（未发放）：回到待出图
    expect(await s.dr.undoDrawn(t4.id, DESIGNER)).toMatchObject({ status: 'PENDING' })
    await expect(s.dr.undoDrawn(t4.id, STRANGER)).rejects.toThrow('只有设计负责人本人或管理员')
  })

  it('W7：到期前黄、过期红、客户确认超期黄 → 红；升级阶梯 设计负责人 → 技术部负责人 + 项目经理 → 项目部负责人 + 领导；不转异常', async () => {
    await db.drawingTask.deleteMany()
    await db.alert.deleteMany()
    await db.reminder.deleteMany()
    const due = await task({ componentName: '快到期', planDate: dayOff(2) })
    const far = await task({ componentName: '还早', planDate: dayOff(3) })
    const noOwner = await task({ componentName: '没负责人', ownerId: null, planDate: dayOff(-1) })
    const confirm = await task({ componentName: '待确认', planDate: dayOff(-10), needsCustomerConfirm: true, customerPlanDate: dayOff(-1) })
    await s.dr.markDrawn(confirm.id, dayOff(-9), DESIGNER)
    const other = await s.dr.createTask({ workOrderNumber: OTHER_WO, componentName: '别的工单', ownerId: 'u-des', planDate: dayOff(-5) }, 'u-pm')

    const targets = await s.scan.collectTargets(new Date(), await s.scan.loadThresholds(), [], 'W7')
    const byId = new Map(targets.map((x) => [x.refId, x]))
    expect(byId.get(due.id)).toMatchObject({ level: 'YELLOW', ownerIds: ['u-des'], deptNames: ['技术部'], workOrderNumber: WO })
    expect(byId.has(far.id)).toBe(false)
    expect(byId.get(noOwner.id)).toMatchObject({ level: 'RED', ownerIds: ['u-tech'] })
    expect(byId.get(confirm.id)).toMatchObject({ level: 'YELLOW' })
    expect(byId.get(confirm.id)!.summary).toContain('客户确认计划')
    expect(byId.get(other.id)).toMatchObject({ level: 'RED' })

    const w7Issues = async () => db.issue.count({ where: { sourceKey: { in: (await db.alert.findMany({ where: { rule: 'W7' } })).map((a) => `ALERT:${a.id}`) } } })
    await s.scan.scanRules(new Date())
    const recipients = async (refId: string) =>
      [...new Set((await db.reminder.findMany({ where: { alertId: (await db.alert.findFirstOrThrow({ where: { refId, rule: 'W7' } })).id } })).map((r) => r.userId))].sort()
    expect(await recipients(due.id)).toEqual(['u-des', 'u-pm', 'u-tech'])
    expect(await recipients(noOwner.id)).toEqual(['u-lead', 'u-pdh', 'u-pm', 'u-tech'])
    // 不转异常
    expect(await w7Issues()).toBe(0)
    expect((await db.alert.findFirstOrThrow({ where: { refId: noOwner.id } })).status).toBe('ACTIVE')

    // 快进：快到期的过了计划日 → 红，加项目部负责人、领导；客户确认超 4 天 → 红
    await s.scan.scanRules(new Date(Date.now() + 3 * DAY))
    expect((await db.alert.findFirstOrThrow({ where: { refId: due.id, rule: 'W7' } })).level).toBe('RED')
    expect(await recipients(due.id)).toEqual(['u-des', 'u-lead', 'u-pdh', 'u-pm', 'u-tech'])
    expect((await db.alert.findFirstOrThrow({ where: { refId: confirm.id, rule: 'W7' } })).level).toBe('RED')
    expect(await w7Issues()).toBe(0)

    // 出图后预警立即消除；取消的下一轮扫描消除
    await s.dr.markDrawn(due.id, null, DESIGNER)
    expect((await db.alert.findFirstOrThrow({ where: { refId: due.id, rule: 'W7' } })).status).toBe('CLEARED')
    await s.dr.updateTask(noOwner.id, { cancelled: true })
    expect((await db.alert.findFirstOrThrow({ where: { refId: noOwner.id, rule: 'W7' } })).status).toBe('CLEARED')

    // 阈值可改：提醒窗口改成 5 天 → "还早"也黄
    await db.threshold.upsert({ where: { rule: 'W7' }, update: { remindHours: 120 }, create: { rule: 'W7', remindHours: 120, yellowDays: 1, redDays: 4 } })
    const again = await s.scan.collectTargets(new Date(), await s.scan.loadThresholds(), [], 'W7')
    expect(again.find((x) => x.refId === far.id)).toMatchObject({ level: 'YELLOW' })
    await db.threshold.deleteMany()

    // 提醒跳转：电脑端出图任务页，手机端我的出图任务
    const alerts = await (await import('../../server/services/alerts/reminders')).listReminders('u-des')
    const w7 = alerts.items.find((i) => i.rule === 'W7')
    expect(w7?.link).toMatch(/^\/drawings\?id=/)
    expect(w7?.mobileLink).toBe(`/m${w7!.link}`)

    // 编辑弹窗原样带回计划日 / 客户确认字段：日期没变不清预警（不重复首发、重复通知）；真改了计划日才清
    const otherAlert = async () => db.alert.findFirstOrThrow({ where: { refId: other.id, rule: 'W7' } })
    const firstAt = (await otherAlert()).firstAt
    const old = await db.drawingTask.findUniqueOrThrow({ where: { id: other.id } })
    await s.dr.updateTask(other.id, { planDate: new Date(old.planDate), needsCustomerConfirm: false, customerPlanDate: null, note: '只改备注' })
    expect(await otherAlert()).toMatchObject({ status: 'ACTIVE', firstAt })
    await s.dr.updateTask(other.id, { planDate: dayOff(10) })
    expect((await otherAlert()).status).toBe('CLEARED')
  })

  it('列表：先在数据库里筛选排序再截断；逾期视图、负责人筛选、可见范围；设计负荷、看板、每日汇总', async () => {
    await db.drawingTask.deleteMany()
    const late = await task({ componentName: '逾期 A', planDate: dayOff(-3) })
    await task({ componentName: '本周外', ownerId: 'u-tech', planDate: dayOff(30) })
    const lateConfirm = await task({ componentName: '确认逾期', planDate: dayOff(-10), needsCustomerConfirm: true, customerPlanDate: dayOff(-2) })
    await s.dr.markDrawn(lateConfirm.id, dayOff(-9), DESIGNER)
    await s.dr.createTask({ workOrderNumber: OTHER_WO, componentName: '别的工单逾期', ownerId: 'u-des', planDate: dayOff(-1) }, 'u-pm')

    const all = await s.dr.listTasks({ view: 'overdue' }, ADMIN)
    expect(all.rows.map((r) => r.componentName).sort()).toEqual(['别的工单逾期', '确认逾期', '逾期 A'])
    expect(all.stats.overdue).toBe(3)
    const scoped = await s.dr.listTasks({ view: 'overdue', visibleWorkOrders: [WO] }, STRANGER)
    expect(scoped.rows.map((r) => r.id).sort()).toEqual([late.id, lateConfirm.id].sort())
    expect(scoped.rows.find((r) => r.id === late.id)).toMatchObject({ overdue: true, ownerText: '设计员', permissions: { markDrawn: false } })
    const des = await s.dr.listTasks({ view: 'open', ownerId: 'u-des' }, DESIGNER)
    expect(des.rows.every((r) => r.ownerId === 'u-des')).toBe(true)
    expect(des.rows.find((r) => r.id === late.id)?.permissions.markDrawn).toBe(true)
    // 待出图在前（按计划日从近到远），已出图在后
    expect(des.rows.map((r) => r.status)).toEqual(['PENDING', 'PENDING', 'DRAWN'])
    expect(des.total).toBe(3)

    const load = await s.dr.designLoad({ visibleWorkOrders: [WO] })
    expect(load.rows[0]).toMatchObject({ ownerId: 'u-des', ownerName: '设计员', open: 2, overdue: 2, pendingDraw: 1 })
    expect(load.rows.find((r) => r.ownerId === 'u-tech')).toMatchObject({ open: 1, overdue: 0 })

    const board = await s.board.getBoard(undefined)
    expect(board.rows.find((r) => r.workOrderNumber === WO)?.drawingOverdue).toBe(2)
    expect(board.rows.find((r) => r.workOrderNumber === OTHER_WO)?.drawingOverdue).toBe(1)

    await db.reminder.deleteMany({ where: { kind: 'DIGEST' } })
    await s.digest.generateDailyDigest({ force: true })
    const digest = await db.reminder.findFirstOrThrow({ where: { kind: 'DIGEST', userId: 'u-pm' } })
    expect(digest.title).toContain('出图逾期 2 项')
  })
})
