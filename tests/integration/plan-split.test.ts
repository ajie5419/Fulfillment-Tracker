/**
 * 部门计划二次分解（zhao 10-22）：真实 MySQL 上直接调用服务层。
 * 覆盖：节点"未分解"标记与分解权限；其他任务建 / 改 / 转交 / 完成 / 撤销 / 删除与负责人待办（截止日 = 计划完成日）；
 * 其他任务计入节点预计日、自动完成；挂工序（只能同一工单）；W9 未分解提醒（发布 72 小时后、只提醒部门负责人、分解后消失）；
 * 删节点时其他任务一起删、待办作废。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL
const DAY = 86_400_000
const HOUR = 3_600_000

type Services = {
  plan: typeof import('../../server/services/plan/plan')
  tasks: typeof import('../../server/services/plan/tasks')
  steps: typeof import('../../server/services/flow/steps')
  scan: typeof import('../../server/services/alerts/scan')
  rules: typeof import('../../server/services/alerts/rules')
  todos: typeof import('../../server/services/flow/todos')
  dr: typeof import('../../server/services/drawings/drawings')
  auth: typeof import('../../server/utils/auth')
}

describe.skipIf(!DB)('部门计划二次分解', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-SPLIT'
  const OTHER_WO = 'T-WO-SPLIT-B'

  async function clean() {
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.planChangeLog.deleteMany()
    await db.planTask.deleteMany()
    await db.planNode.deleteMany()
    await db.workOrderPlan.deleteMany()
    await db.drawingTask.deleteMany()
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

  const today = () => new Date(`${s.rules.shanghaiDay(new Date())}T00:00:00.000Z`)
  const dayOff = (n: number) => new Date(+today() + n * DAY)
  const dayStr = (n: number) => dayOff(n).toISOString().slice(0, 10)
  const ctxOf = (userId: string, admin = false) => s.auth.loadRoleContext(userId, admin)
  const taskTodos = (taskId: string) => db.todo.findMany({ where: { refType: 'planTask', refId: taskId }, orderBy: { createdAt: 'asc' } })
  const node = async (name: string) => (await db.planNode.findFirstOrThrow({ where: { workOrderNumber: WO, name } }))
  const view = async (userId = 'u-pm') => s.plan.getPlan(WO, await ctxOf(userId))
  const nodeView = async (name: string, userId = 'u-pm') => (await view(userId)).nodes.find((n) => n.name === name)!

  let stepIds: string[] = []
  let otherStepId = ''

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      plan: await import('../../server/services/plan/plan'),
      tasks: await import('../../server/services/plan/tasks'),
      steps: await import('../../server/services/flow/steps'),
      scan: await import('../../server/services/alerts/scan'),
      rules: await import('../../server/services/alerts/rules'),
      todos: await import('../../server/services/flow/todos'),
      dr: await import('../../server/services/drawings/drawings'),
      auth: await import('../../server/utils/auth'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await clean()
    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [
        { workOrderNumber: WO, customerName: '测试客户', quantity: 1, deliveryDate: dayOff(60), status: 'IN_PROGRESS', updatedAt: now },
        { workOrderNumber: OTHER_WO, customerName: '测试客户', quantity: 1, deliveryDate: dayOff(90), status: 'IN_PROGRESS', updatedAt: now },
      ],
    })
    await db.qmsProcess.createMany({ data: [{ id: 'P-CUT', name: '下料', updatedAt: now }, { id: 'P-WELD', name: '组焊', updatedAt: now }] })
    const DEPTS = ['生产部', '项目部', '技术部', '采购部']
    await db.qmsDepartment.createMany({ data: DEPTS.map((name, i) => ({ id: `SD-${i}`, name, parentId: '0', status: 1, updatedAt: now })) })
    const user = (id: string, realName: string, dept: string) => ({ id, username: id, realName, departmentId: `SD-${DEPTS.indexOf(dept)}`, status: 'ACTIVE', updatedAt: now })
    await db.qmsUser.createMany({
      data: [
        user('u-pm', '项目经理', '项目部'),
        user('u-pdh', '项目部负责人', '项目部'),
        user('u-techhead', '技术部长', '技术部'),
        user('u-des', '设计员', '技术部'),
        user('u-prodhead', '生产经理', '生产部'),
        user('u-buyer', '采购员', '采购部'),
      ],
    })
    await db.notifyRole.createMany({
      data: [
        { role: 'DEPT_HEAD', userId: 'u-techhead', department: '技术部' },
        { role: 'DEPT_HEAD', userId: 'u-prodhead', department: '生产部' },
        { role: 'PROJECT_DEPT_HEAD', userId: 'u-pdh' },
      ],
    })
    await db.workOrderExt.createMany({ data: [WO, OTHER_WO].map((w) => ({ workOrderNumber: w, projectManagerId: 'u-pm' })) })
    // 草稿时建好总计划和工序（工序先不挂）
    await s.plan.createNode(WO, { name: '合同评审', dept: 'PROJECT', planDate: dayOff(10) }, 'u-pm')
    await s.plan.createNode(WO, { name: '设计出图', dept: 'TECH', planDate: dayOff(20) }, 'u-pm')
    await s.plan.createNode(WO, { name: '组焊', dept: 'PRODUCTION', planDate: dayOff(40) }, 'u-pm')
    await s.plan.createNode(WO, { name: '发运', dept: 'PROJECT', planDate: dayOff(60) }, 'u-pm')
    const part = await s.steps.createPart(WO, { name: '主梁', quantity: 1 })
    const a = await s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-prodhead', dueDate: dayOff(30) }, 'u-prodhead')
    const b = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'SELF', ownerId: 'u-prodhead', dueDate: dayOff(38) }, 'u-prodhead')
    stepIds = [a.id, b.id]
    const otherPart = await s.steps.createPart(OTHER_WO, { name: '别的工件', quantity: 1 })
    otherStepId = (await s.steps.addStep(otherPart.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-prodhead' }, 'u-prodhead')).id
    await s.plan.publishPlan(WO, 'u-pm')
  })

  afterAll(async () => {
    if (db) await clean()
    await db?.$disconnect()
  })

  it('发布后节点都标"未分解"；分解权限：责任部门的人、项目经理、项目部，别的部门不行', async () => {
    const v = await view()
    expect(v.nodes.every((n) => n.unsplit)).toBe(true)
    expect(v.canCreate).toEqual({ drawing: false, purchase: true, route: true, kitting: true })
    expect(v.nodes.every((n) => n.canSplit)).toBe(true)
    const tech = await view('u-des')
    expect(tech.nodes.find((n) => n.name === '设计出图')!.canSplit).toBe(true)
    expect(tech.nodes.find((n) => n.name === '组焊')!.canSplit).toBe(false)
    expect(tech.canCreate.drawing).toBe(true)
    expect((await view('u-pdh')).nodes.find((n) => n.name === '组焊')!.canSplit).toBe(true)
    expect((await view('u-buyer')).nodes.find((n) => n.name === '组焊')!.canSplit).toBe(false)
  })

  it('其他任务：建好给负责人发待办（截止日 = 计划完成日），晚于节点只提示；计入节点预计日', async () => {
    const contract = await node('合同评审')
    const r = await s.tasks.createPlanTask(contract.id, { name: '合同技术条款评审', ownerId: 'u-pdh', planDate: dayOff(12), note: '附技术协议' }, 'u-pm')
    expect(r.planWarning).toContain('晚于总计划节点"合同评审"')
    const todos = await taskTodos(r.id)
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ ownerId: 'u-pdh', action: 'DO_PLAN_TASK', status: 'OPEN' })
    expect(todos[0]!.dueAt!.toISOString().slice(0, 10)).toBe(dayStr(12))
    const mine = (await s.todos.listMyTodos('u-pdh')).find((t) => t.refId === r.id)!
    expect(mine.actionText).toBe('完成部门任务')
    expect(mine.title).toBe(`完成部门任务：${WO} · 合同技术条款评审`)
    expect(mine.dueDay).toBe(dayStr(12))
    expect(mine.workOrderNumber).toBe(WO)
    expect(mine.planTask?.link).toBe(`/plan?wo=${WO}&node=${contract.id}`)
    // 负责人看不到这张工单时：待办照常、可标完成，但不给"查看"链接（总计划页会 403）
    const outOfScope = (await s.todos.listMyTodos('u-pdh', [OTHER_WO])).find((t) => t.refId === r.id)!
    expect(outOfScope.planTask).toMatchObject({ id: r.id, link: null })
    // 其他类型的待办 planTask 为空
    const n = await nodeView('合同评审')
    expect(n.unsplit).toBe(false)
    expect(n.taskCount).toBe(1)
    expect(n.expectedDate).toBe(dayStr(12))
    expect(n.source).toBe(true)
    const t = n.tasks[0]!
    expect(t).toMatchObject({ kind: 'task', kindText: '其他任务', name: '合同技术条款评审', ownerId: 'u-pdh', ownerName: '项目部负责人', note: '附技术协议', lateForNode: true, canEdit: true, canDone: true })
    // 负责人本人（项目部负责人也是项目部的）能标完成；其他部门的人看得到但改不了
    const buyerView = (await view('u-buyer')).nodes.find((x) => x.name === '合同评审')!.tasks[0]!
    expect(buyerView).toMatchObject({ canEdit: false, canDone: false })
  })

  it('改负责人换人发待办；改日期改截止日；转交待办 = 换负责人', async () => {
    const contract = await node('合同评审')
    const task = await db.planTask.findFirstOrThrow({ where: { planNodeId: contract.id } })
    await s.tasks.updatePlanTask(task.id, { ownerId: 'u-pm' })
    let todos = await taskTodos(task.id)
    expect(todos.map((t) => [t.ownerId, t.status])).toEqual([['u-pdh', 'CANCELLED'], ['u-pm', 'OPEN']])
    const w = await s.tasks.updatePlanTask(task.id, { planDate: dayOff(9) })
    expect(w.planWarning).toBeNull()
    todos = await taskTodos(task.id)
    expect(todos.at(-1)!.dueAt!.toISOString().slice(0, 10)).toBe(dayStr(9))
    await s.todos.transferTodo(todos.at(-1)!.id, 'u-pdh')
    expect((await db.planTask.findUniqueOrThrow({ where: { id: task.id } })).ownerId).toBe('u-pdh')
    expect((await taskTodos(task.id)).filter((t) => t.status === 'OPEN').map((t) => t.ownerId)).toEqual(['u-pdh'])
    await expect(s.tasks.updatePlanTask(task.id, { ownerId: 'nobody' })).rejects.toThrow('负责人不存在')
  })

  it('完成：不能晚于今天；完成后待办关闭，节点下任务全部完成节点自动完成；撤销完成重发待办', async () => {
    const contract = await node('合同评审')
    const task = await db.planTask.findFirstOrThrow({ where: { planNodeId: contract.id } })
    await expect(s.tasks.completePlanTask(task.id, dayOff(1), 'u-pdh')).rejects.toThrow('不能晚于今天')
    await s.tasks.completePlanTask(task.id, null, 'u-pdh')
    await expect(s.tasks.completePlanTask(task.id, null, 'u-pdh')).rejects.toThrow('已经完成')
    expect((await taskTodos(task.id)).filter((t) => t.status === 'OPEN')).toHaveLength(0)
    let n = await nodeView('合同评审')
    expect(n).toMatchObject({ done: true, doneBy: 'AUTO', actualDate: dayStr(0) })
    expect(n.tasks[0]).toMatchObject({ done: true, statusText: '已完成' })
    await s.tasks.undoCompletePlanTask(task.id)
    expect((await taskTodos(task.id)).filter((t) => t.status === 'OPEN').map((t) => t.ownerId)).toEqual(['u-pdh'])
    n = await nodeView('合同评审')
    expect(n.done).toBe(false)
    await expect(s.tasks.undoCompletePlanTask(task.id)).rejects.toThrow('还没有完成')
  })

  it('挂工序：只能挂同一工单的工序；挂上后算节点的部门任务', async () => {
    const weld = await node('组焊')
    await expect(s.tasks.linkStepsToNode(weld.id, [stepIds[0]!, otherStepId])).rejects.toThrow('不属于该工单')
    const opts = await s.tasks.stepOptions(WO)
    expect(opts.map((o) => [o.processName, o.planNodeId])).toEqual([['下料', null], ['组焊', null]])
    expect(await s.tasks.linkStepsToNode(weld.id, stepIds)).toEqual({ linked: 2 })
    const n = await nodeView('组焊')
    expect(n.unsplit).toBe(false)
    expect(n.tasks.map((t) => t.kind)).toEqual(['step', 'step'])
    expect((await s.tasks.stepOptions(WO)).every((o) => o.planNodeName === '3. 组焊')).toBe(true)
  })

  it('W9 未分解：发布 72 小时内不报；之后只提醒还没分解的节点（给责任部门负责人）；分解后消失', async () => {
    const plan = await db.workOrderPlan.findUniqueOrThrow({ where: { workOrderNumber: WO } })
    const design = await node('设计出图')
    const ship = await node('发运')
    const splitAlerts = () => db.alert.findMany({ where: { refType: 'planSplit', status: 'ACTIVE' }, orderBy: { refId: 'asc' } })
    await s.scan.scanRules(new Date(+plan.publishedAt! + 71 * HOUR))
    expect(await splitAlerts()).toHaveLength(0)
    const later = new Date(+plan.publishedAt! + 73 * HOUR)
    await s.scan.scanRules(later)
    const active = await splitAlerts()
    expect(active.map((a) => [a.refId, a.level]).sort()).toEqual([[design.id, 'REMIND'], [ship.id, 'REMIND']].sort())
    const reminders = await db.reminder.findMany({ where: { alertId: active.find((a) => a.refId === design.id)!.id } })
    expect(reminders.map((r) => r.userId)).toEqual(['u-techhead'])
    expect(reminders[0]!.title).toContain('还没有分解部门任务')
    expect((await nodeView('设计出图')).splitAlertLevel).toBe('REMIND')
    // 技术部分解（设计任务挂节点）后提醒立刻消失（不等下次扫描），再扫也不会重新生成
    await s.dr.createTask({ workOrderNumber: WO, componentName: '主梁总图', ownerId: 'u-des', planDate: dayOff(18), planNodeId: design.id }, 'u-techhead')
    expect((await splitAlerts()).map((a) => a.refId)).toEqual([ship.id])
    expect((await nodeView('设计出图')).splitAlertLevel).toBeNull()
    await s.scan.scanRules(new Date(+later + HOUR))
    expect((await splitAlerts()).map((a) => a.refId)).toEqual([ship.id])
    // 节点手动完成也不再提醒
    await s.plan.completeNode(ship.id, null, 'u-pm')
    expect(await splitAlerts()).toHaveLength(0)
    await s.plan.undoCompleteNode(ship.id)
  })

  it('删任务作废待办；删节点时其他任务一起删、待办作废', async () => {
    const ship = await node('发运')
    const a = await s.tasks.createPlanTask(ship.id, { name: '发运准备', ownerId: 'u-pm', planDate: dayOff(58) }, 'u-pm')
    const b = await s.tasks.createPlanTask(ship.id, { name: '装车', ownerId: 'u-pm', planDate: dayOff(60) }, 'u-pm')
    await s.tasks.deletePlanTask(a.id)
    expect((await taskTodos(a.id)).map((t) => t.status)).toEqual(['CANCELLED'])
    expect(await db.planTask.count({ where: { id: a.id } })).toBe(0)
    await s.plan.deleteNode(ship.id, '并入合同评审', 'u-pm')
    expect(await db.planTask.count({ where: { id: b.id } })).toBe(0)
    expect((await taskTodos(b.id)).map((t) => t.status)).toEqual(['CANCELLED'])
    // 已删任务的待办不再出现在我的待办里
    expect((await s.todos.listMyTodos('u-pm')).some((t) => t.refId === b.id)).toBe(false)
  })
})
