/**
 * 项目部总计划（R14）：真实 MySQL 上直接调用服务层，用 now 注入"快进时钟"。
 * 覆盖：按模板生成（计划日 = 交期 − 天数）、草稿随便改；发布（基线、给部门负责人发确认待办、没负责人的部门报出来）；
 * 确认 / 退回（退回提醒项目经理）；发布后改日期必须写原因、记调整记录、重新请确认；
 * 部门记录挂节点（只能同一工单、已发布必选、晚于节点日只提示、老数据照旧）；Excel 导入按节点名匹配不拦截；
 * 预计日顺延 / 预计交期；W9 只报源头节点（按自身延误）、交期风险单独一条工单级红、自动清除；超时未确认（W5 阈值）；看板、领导总览、每日汇总。
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
  tpl: typeof import('../../server/services/plan/templates')
  steps: typeof import('../../server/services/flow/steps')
  scan: typeof import('../../server/services/alerts/scan')
  rules: typeof import('../../server/services/alerts/rules')
  board: typeof import('../../server/services/issues/board')
  overview: typeof import('../../server/services/issues/overview')
  digest: typeof import('../../server/services/alerts/digest')
  reminders: typeof import('../../server/services/alerts/reminders')
  todos: typeof import('../../server/services/flow/todos')
  pur: typeof import('../../server/services/purchases/purchases')
  imp: typeof import('../../server/services/purchases/import')
  dr: typeof import('../../server/services/drawings/drawings')
  kit: typeof import('../../server/services/kitting/kitting')
  auth: typeof import('../../server/utils/auth')
}

describe.skipIf(!DB)('项目部总计划（R14）', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-R14'
  const W9WO = 'T-WO-R14-W9'
  const OTHER_WO = 'T-WO-R14-B'
  const DEP_WO = 'T-WO-R14-DEP'
  const PROD = { userId: 'u-prodhead', isAdmin: false }

  async function clean() {
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.planChangeLog.deleteMany()
    await db.planNode.deleteMany()
    await db.workOrderPlan.deleteMany()
    await db.planTemplate.deleteMany({ where: { id: { notIn: ['plan-tpl-generic', 'plan-tpl-special-vehicle'] } } })
    await db.issue.deleteMany()
    await db.assemblyNode.deleteMany()
    await db.release.deleteMany()
    await db.drawingTask.deleteMany()
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

  const today = () => new Date(`${s.rules.shanghaiDay(new Date())}T00:00:00.000Z`)
  const dayOff = (n: number) => new Date(+today() + n * DAY)
  const dayStr = (n: number) => dayOff(n).toISOString().slice(0, 10)

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      plan: await import('../../server/services/plan/plan'),
      tpl: await import('../../server/services/plan/templates'),
      steps: await import('../../server/services/flow/steps'),
      scan: await import('../../server/services/alerts/scan'),
      rules: await import('../../server/services/alerts/rules'),
      board: await import('../../server/services/issues/board'),
      overview: await import('../../server/services/issues/overview'),
      digest: await import('../../server/services/alerts/digest'),
      reminders: await import('../../server/services/alerts/reminders'),
      todos: await import('../../server/services/flow/todos'),
      pur: await import('../../server/services/purchases/purchases'),
      imp: await import('../../server/services/purchases/import'),
      dr: await import('../../server/services/drawings/drawings'),
      kit: await import('../../server/services/kitting/kitting'),
      auth: await import('../../server/utils/auth'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await clean()
    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [
        { workOrderNumber: WO, customerName: '测试客户', quantity: 1, deliveryDate: dayOff(150), status: 'IN_PROGRESS', updatedAt: now },
        { workOrderNumber: W9WO, customerName: '测试客户', quantity: 1, deliveryDate: dayOff(60), status: 'IN_PROGRESS', updatedAt: now },
        { workOrderNumber: OTHER_WO, customerName: '测试客户', quantity: 1, deliveryDate: dayOff(90), status: 'IN_PROGRESS', updatedAt: now },
        { workOrderNumber: DEP_WO, customerName: '测试客户', quantity: 1, deliveryDate: dayOff(100), status: 'IN_PROGRESS', updatedAt: now },
      ],
    })
    await db.qmsProcess.createMany({ data: [{ id: 'P-CUT', name: '下料', updatedAt: now }] })
    const DEPTS = ['生产部', '项目部', '技术部', '采购部', '公司领导']
    await db.qmsDepartment.createMany({ data: DEPTS.map((name, i) => ({ id: `PD-${i}`, name, parentId: '0', status: 1, updatedAt: now })) })
    const user = (id: string, realName: string, dept: string) => ({ id, username: id, realName, departmentId: `PD-${DEPTS.indexOf(dept)}`, status: 'ACTIVE', updatedAt: now })
    await db.qmsUser.createMany({
      data: [
        user('u-pm', '项目经理', '项目部'),
        user('u-pdh', '项目部负责人', '项目部'),
        user('u-techhead', '技术部长', '技术部'),
        user('u-des', '设计员', '技术部'),
        user('u-buyhead', '采购部长', '采购部'),
        user('u-prodhead', '生产经理', '生产部'),
        user('u-lead', '分管领导', '公司领导'),
      ],
    })
    // 质量部、财务部没有负责人
    await db.notifyRole.createMany({
      data: [
        { role: 'DEPT_HEAD', userId: 'u-techhead', department: '技术部' },
        { role: 'DEPT_HEAD', userId: 'u-buyhead', department: '采购部' },
        { role: 'DEPT_HEAD', userId: 'u-prodhead', department: '生产部' },
        { role: 'PROJECT_DEPT_HEAD', userId: 'u-pdh' },
        { role: 'LEADER', userId: 'u-lead' },
      ],
    })
    await db.workOrderExt.createMany({ data: [WO, W9WO, OTHER_WO, DEP_WO].map((w) => ({ workOrderNumber: w, projectManagerId: 'u-pm' })) })
  })

  afterAll(async () => {
    if (db) await clean()
    await db?.$disconnect()
  })

  const nodesOf = (wo: string) => db.planNode.findMany({ where: { workOrderNumber: wo }, orderBy: { seq: 'asc' } })
  const openTodos = (nodeId: string) => db.todo.findMany({ where: { refType: 'planNode', refId: nodeId, status: 'OPEN' } })
  const ctxOf = (userId: string, admin = false) => s.auth.loadRoleContext(userId, admin)

  it('模板：内置"通用"模板 11 个节点；自建模板重名报错；按模板生成计划日 = 交期 − 天数；草稿可以随便改、重新生成', async () => {
    const list = await s.tpl.listTemplates()
    const generic = list.find((t) => t.id === 'plan-tpl-generic')!
    expect(generic.name).toBe('通用')
    expect(generic.nodes).toHaveLength(11)
    expect(generic.nodes.at(-1)).toMatchObject({ name: '发运', dept: 'PROJECT', daysBeforeDelivery: 0 })
    await expect(s.tpl.createTemplate({ name: '通用', nodes: [{ name: 'x', dept: 'TECH', daysBeforeDelivery: 1 }] }, 'u-pdh')).rejects.toThrow('已有同名模板')
    await expect(s.tpl.createTemplate({ name: '重名节点', nodes: [{ name: 'x', dept: 'TECH', daysBeforeDelivery: 1 }, { name: 'x', dept: 'TECH', daysBeforeDelivery: 0 }] }, 'u-pdh')).rejects.toThrow('节点名称重复')
    const small = await s.tpl.createTemplate({ name: '简版', nodes: [{ name: '设计', dept: 'TECH', daysBeforeDelivery: 30 }, { name: '发运', dept: 'PROJECT', daysBeforeDelivery: 0 }] }, 'u-pdh')

    expect(await s.plan.generateFromTemplate(WO, small.id, 'u-pm')).toEqual({ created: 2, replaced: 0 })
    // 重新生成：替换
    expect(await s.plan.generateFromTemplate(WO, 'plan-tpl-generic', 'u-pm')).toEqual({ created: 11, replaced: 2 })
    const nodes = await nodesOf(WO)
    expect(nodes.map((n) => n.name)).toEqual(['合同评审', '设计出图', '客户确认', '关键物料到货', '下料组焊', '机加', '外协', '涂装', '装配', '调试', '发运'])
    expect(nodes[0]!.planDate.toISOString().slice(0, 10)).toBe(dayStr(150 - 120))
    expect(nodes.at(-1)!.planDate.toISOString().slice(0, 10)).toBe(dayStr(150))
    expect(nodes.every((n) => n.baselineDate === null && n.confirmStatus === null)).toBe(true)
    // 草稿改日期不用原因、不记调整记录
    await s.plan.updateNode(nodes[1]!.id, { planDate: dayOff(52) }, 'u-pm')
    expect(await db.planChangeLog.count()).toBe(0)
    // 改模板不影响已生成的
    await s.tpl.updateTemplate(small.id, { name: '简版', nodes: [{ name: '只剩一个', dept: 'TECH', daysBeforeDelivery: 3 }] })
    expect(await db.planNode.count({ where: { workOrderNumber: WO } })).toBe(11)
    await s.tpl.deleteTemplate(small.id)
    expect((await s.plan.planOptions(WO)).published).toBe(false)
  })

  it('前置节点（10-22）：内置"特种车辆"模板带阶段、工期、前置；生成后连好前置、算开始日；不能成环 / 选自己 / 选别的工单；恢复默认；漏连提示', async () => {
    const sv = (await s.tpl.listTemplates()).find((t) => t.id === 'plan-tpl-special-vehicle')!
    expect(sv.name).toBe('特种车辆')
    expect(sv.nodes).toHaveLength(18)
    expect(sv.nodes[15]).toMatchObject({ name: '装配', phase: '装配、调试、发运', durationDays: 8, daysBeforeDelivery: 9, preds: [9, 10, 11, 12, 13, 15] })
    expect(sv.nodes[0]!.preds).toEqual([])

    expect(await s.plan.generateFromTemplate(DEP_WO, 'plan-tpl-special-vehicle', 'u-pm')).toEqual({ created: 18, replaced: 0 })
    const nodes = await nodesOf(DEP_WO)
    const id = (seq: number) => nodes[seq - 1]!.id
    expect(nodes.every((n) => n.customDeps)).toBe(true)
    expect(await db.planNodeDep.count({ where: { nodeId: { in: nodes.map((n) => n.id) } } })).toBe(23)
    // 车架：完成 = 交期 − 19，开始 = 完成 − 工期 27 + 1
    expect(nodes[13]!.planDate.toISOString().slice(0, 10)).toBe(dayStr(100 - 19))
    expect(nodes[13]!.startDate!.toISOString().slice(0, 10)).toBe(dayStr(100 - 19 - 26))
    let view = await s.plan.getPlan(DEP_WO, await ctxOf('u-pm'))
    expect(view.network).toBe(true)
    expect(view.dangling).toEqual([])
    expect(view.phases).toEqual(['开工通知', '图纸设计及文件下发', '采购', '生产制作', '表面处理', '装配、调试、发运'])
    expect(view.nodes[15]!.preds.map((p) => p.seq)).toEqual([9, 10, 11, 12, 13, 15])
    expect(view.nodes[17]!.critical).toBe(true) // 发货：按时也是关键（余量 0）
    expect(view.nodes[9]!).toMatchObject({ critical: false, slackDays: 4 }) // 油缸到装配空 4 天

    // 成环：结构图纸改成等车架 → 车架又等结构图纸；整笔回滚
    await expect(s.plan.updateNode(id(2), { preds: [id(14)] }, 'u-pm')).rejects.toThrow('成环')
    expect(await db.planNodeDep.findMany({ where: { nodeId: id(2) }, select: { predId: true } })).toEqual([{ predId: id(1) }])
    await expect(s.plan.updateNode(id(2), { preds: [id(2)] }, 'u-pm')).rejects.toThrow('不能选自己')
    await s.plan.generateFromTemplate(OTHER_WO, 'plan-tpl-generic', 'u-pm')
    const other = (await nodesOf(OTHER_WO))[0]!
    await expect(s.plan.updateNode(id(2), { preds: [other.id] }, 'u-pm')).rejects.toThrow('同一个工单')
    await expect(s.plan.updateNode(id(2), { startDate: dayOff(100) }, 'u-pm')).rejects.toThrow('不能晚于计划完成日')
    // 默认的"上一个节点"也算：#6 恢复默认（等 #5），再让 #5 等 #6 → 成环被拦
    await s.plan.updateNode(id(6), { preds: null }, 'u-pm')
    await expect(s.plan.updateNode(id(5), { preds: [id(6)] }, 'u-pm')).rejects.toThrow('成环')
    // 新节点排在 #6 前面（顺序号 5，和 #5 同号按创建先后排在它后面）且等 #6：#6 默认等它 → 成环，节点不留下
    await expect(s.plan.createNode(DEP_WO, { name: '资料移交', dept: 'PROJECT', planDate: dayOff(30), seq: 5, preds: [id(6)] }, 'u-pm')).rejects.toThrow('成环')
    expect(await db.planNode.count({ where: { workOrderNumber: DEP_WO } })).toBe(18)

    // 装配漏连液压件：提示"后面没有节点接着"
    await s.plan.updateNode(id(16), { preds: [id(9), id(10), id(11), id(12), id(15)] }, 'u-pm')
    view = await s.plan.getPlan(DEP_WO, await ctxOf('u-pm'))
    expect(view.dangling.map((n) => n.name)).toEqual(['液压件'])
    // 恢复默认：前置 = 上一个节点（调试 ← 装配不变；装配 ← 液压件）
    await s.plan.updateNode(id(16), { preds: null }, 'u-pm')
    view = await s.plan.getPlan(DEP_WO, await ctxOf('u-pm'))
    expect(view.nodes[15]).toMatchObject({ customDeps: false, preds: [{ id: id(15), seq: 15, name: '表面处理喷漆' }] })
    // 删前置节点：关系一起删（装配不再等它）
    await s.plan.updateNode(id(16), { preds: [id(14), id(15)] }, 'u-pm')
    await s.plan.deleteNode(id(15), null, 'u-pm')
    expect(await db.planNodeDep.findMany({ where: { nodeId: id(16) }, select: { predId: true } })).toEqual([{ predId: id(14) }])
    // 删节点后默认前置改变也可能成环：#5 等 #7、#6 不等任何节点、#7 默认等 #6；删 #6 后 #7 改等 #5 → #5↔#7，拦住并回滚
    await s.plan.updateNode(id(5), { preds: [id(7)] }, 'u-pm')
    await s.plan.updateNode(id(6), { preds: [] }, 'u-pm')
    await s.plan.updateNode(id(7), { preds: null }, 'u-pm')
    await expect(s.plan.deleteNode(id(6), null, 'u-pm')).rejects.toThrow('成环')
    expect(await db.planNode.count({ where: { id: id(6) } })).toBe(1)

    // 模板校验：前置超范围、选自己、成环
    const n = (name: string, preds: number[] | null) => ({ name, dept: 'TECH' as const, daysBeforeDelivery: 1, preds })
    await expect(s.tpl.createTemplate({ name: 'X1', nodes: [n('a', [3]), n('b', null)] }, 'u-pdh')).rejects.toThrow('不存在')
    await expect(s.tpl.createTemplate({ name: 'X2', nodes: [n('a', [1])] }, 'u-pdh')).rejects.toThrow('不能是自己')
    await expect(s.tpl.createTemplate({ name: 'X3', nodes: [n('a', [2]), n('b', null)] }, 'u-pdh')).rejects.toThrow('成环')
    const ok = await s.tpl.createTemplate({ name: 'X4', nodes: [{ ...n('a', []), phase: ' 设计 ', durationDays: 5 }, n('b', null), n('c', [1])] }, 'u-pdh')
    const x4 = (await s.tpl.listTemplates()).find((t) => t.id === ok.id)!
    expect(x4.nodes.map((m) => [m.phase, m.durationDays, m.preds])).toEqual([['设计', 5, []], [null, null, null], [null, null, [1]]])
    await s.tpl.deleteTemplate(ok.id)
    await db.planNode.deleteMany({ where: { workOrderNumber: { in: [DEP_WO, OTHER_WO] } } })
    await db.workOrderPlan.deleteMany({ where: { workOrderNumber: { in: [DEP_WO, OTHER_WO] } } })
  })

  it('子节点（10-22）：挂在上级下面，编号 2.1；上级等子节点、子节点默认和上级同时开始；日期、层级、成环校验；全完成上级自动完成；有子节点不能删；模板带上级', async () => {
    const pm = 'u-pm'
    const a = await s.plan.createNode(DEP_WO, { name: '原材料', dept: 'PURCHASE', planDate: dayOff(20), phase: '采购' }, pm)
    const p = await s.plan.createNode(DEP_WO, { name: '下料组焊', dept: 'PRODUCTION', planDate: dayOff(40), phase: '生产制作' }, pm)
    const b = await s.plan.createNode(DEP_WO, { name: '机加', dept: 'PRODUCTION', planDate: dayOff(50), phase: '生产制作' }, pm)
    // 子节点：阶段跟上级（传了别的也不算）；计划日不能晚于上级
    const c1 = await s.plan.createNode(DEP_WO, { name: '车架', dept: 'PRODUCTION', planDate: dayOff(35), parentId: p.id, phase: '乱填' }, pm)
    await expect(s.plan.createNode(DEP_WO, { name: '悬挂', dept: 'PRODUCTION', planDate: dayOff(45), parentId: p.id }, pm)).rejects.toThrow('晚于上级')
    const c2 = await s.plan.createNode(DEP_WO, { name: '悬挂', dept: 'PRODUCTION', planDate: dayOff(38), parentId: p.id }, pm)
    expect((await db.planNode.findUnique({ where: { id: c1.id } }))!.phase).toBe('生产制作')
    // 只有一层；子节点不能等上级；别的工单的节点不能当上级
    await expect(s.plan.createNode(DEP_WO, { name: '孙', dept: 'PRODUCTION', planDate: dayOff(30), parentId: c1.id }, pm)).rejects.toThrow('本身是子节点')
    await expect(s.plan.updateNode(c2.id, { preds: [p.id] }, pm)).rejects.toThrow('不能再等上级')
    await expect(s.plan.updateNode(p.id, { parentId: a.id }, pm)).rejects.toThrow('下面有子节点')
    await expect(s.plan.updateNode(c1.id, { parentId: c1.id }, pm)).rejects.toThrow('不能选自己')
    // 上级的计划日不能早于子节点
    await expect(s.plan.updateNode(p.id, { planDate: dayOff(36) }, pm)).rejects.toThrow('不能早于子节点')
    // 只改备注不校验日期
    await s.plan.updateNode(p.id, { note: '组焊车间' }, pm)

    let view = await s.plan.getPlan(DEP_WO, await ctxOf(pm))
    expect(view.nodes.map((n) => `${n.code} ${n.name}`)).toEqual(['1 原材料', '2 下料组焊', '2.1 车架', '2.2 悬挂', '3 机加'])
    const byName = (name: string) => view.nodes.find((n) => n.name === name)!
    expect(byName('下料组焊')).toMatchObject({ childCount: 2, parentId: null })
    expect(byName('车架')).toMatchObject({ parentId: p.id, preds: [{ id: a.id, code: '1' }] }) // 默认：和上级同时开始
    expect(byName('机加').preds).toMatchObject([{ id: p.id, code: '2' }]) // 默认接上一个一级节点，不接到子节点上
    expect(view.network).toBe(true)
    expect(view.lastNodeId).toBe(b.id)
    expect(view.dangling).toEqual([])
    // 上级改阶段：子节点跟着改
    await s.plan.updateNode(p.id, { phase: '下料组焊' }, pm)
    expect((await db.planNode.findMany({ where: { parentId: p.id }, select: { phase: true } })).map((n) => n.phase)).toEqual(['下料组焊', '下料组焊'])

    // 子节点晚了：上级受子节点影响，后续一级节点跟着晚
    await db.planTask.create({ data: { workOrderNumber: DEP_WO, planNodeId: c2.id, name: '悬挂外协', ownerId: pm, planDate: dayOff(43) } })
    view = await s.plan.getPlan(DEP_WO, await ctxOf(pm))
    expect(byName('悬挂')).toMatchObject({ source: true, delayDays: 5 })
    expect(byName('下料组焊')).toMatchObject({ source: false, upstream: true, delayDays: 3, pushedBy: { code: '2.2', name: '悬挂', child: true }, unsplit: false })
    expect(byName('机加')).toMatchObject({ upstream: true, delayDays: 3 })

    // 完成：子节点没完成不能标上级完成；子节点都完成后上级自动完成
    await expect(s.plan.completeNode(p.id, null, pm)).rejects.toThrow('还有子节点没完成')
    await s.plan.completeNode(c1.id, null, pm)
    await s.plan.completeNode(c2.id, null, pm)
    view = await s.plan.getPlan(DEP_WO, await ctxOf(pm))
    expect(byName('下料组焊')).toMatchObject({ done: true, doneBy: 'AUTO' })

    // 有子节点不能删；把子节点移出后可以
    await expect(s.plan.deleteNode(p.id, null, pm)).rejects.toThrow('还有 2 个子节点')
    await s.plan.updateNode(c1.id, { parentId: null }, pm)
    await s.plan.updateNode(c2.id, { parentId: null }, pm)
    await s.plan.deleteNode(p.id, null, pm)
    await db.planNode.deleteMany({ where: { workOrderNumber: DEP_WO } })

    // 模板：上级要排在前面、只一层、子节点前置不能是上级；生成时挂好、阶段跟上级
    const n = (name: string, parent: number | null, preds: number[] | null = null, phase: string | null = null) => ({ name, dept: 'PRODUCTION' as const, daysBeforeDelivery: 5, parent, preds, phase })
    await expect(s.tpl.createTemplate({ name: 'Y1', nodes: [n('a', 2), n('b', null)] }, 'u-pdh')).rejects.toThrow('排在它前面')
    await expect(s.tpl.createTemplate({ name: 'Y2', nodes: [n('a', null), n('b', 1), n('c', 2)] }, 'u-pdh')).rejects.toThrow('本身是子节点')
    await expect(s.tpl.createTemplate({ name: 'Y3', nodes: [n('a', null), n('b', 1, [1])] }, 'u-pdh')).rejects.toThrow('不能是自己的上级')
    await expect(s.tpl.createTemplate({ name: 'Y5', nodes: [n('a', null), { ...n('b', 1), daysBeforeDelivery: 3 }] }, 'u-pdh')).rejects.toThrow('不能比上级小')
    const y = await s.tpl.createTemplate({ name: 'Y4', nodes: [n('组焊', null, null, '生产'), n('车架', 1), n('悬挂', 1, null, '别的'), n('机加', null, null, '生产')] }, 'u-pdh')
    expect((await s.tpl.listTemplates()).find((t) => t.id === y.id)!.nodes.map((m) => [m.name, m.parent, m.phase])).toEqual([
      ['组焊', null, '生产'],
      ['车架', 1, '生产'],
      ['悬挂', 1, '生产'],
      ['机加', null, '生产'],
    ])
    await s.plan.generateFromTemplate(DEP_WO, y.id, pm)
    view = await s.plan.getPlan(DEP_WO, await ctxOf(pm))
    expect(view.nodes.map((m) => `${m.code} ${m.name}`)).toEqual(['1 组焊', '1.1 车架', '1.2 悬挂', '2 机加'])
    expect(view.nodes[3]!.preds.map((m) => m.name)).toEqual(['组焊'])
    await s.tpl.deleteTemplate(y.id)
    await db.planTask.deleteMany({ where: { workOrderNumber: DEP_WO } })
    await db.planNode.deleteMany({ where: { workOrderNumber: DEP_WO } })
    await db.workOrderPlan.deleteMany({ where: { workOrderNumber: DEP_WO } })
  })

  it('发布前：部门记录可以不挂；不能挂别的工单的节点', async () => {
    const [, design] = await nodesOf(WO)
    const t = await s.dr.createTask({ workOrderNumber: WO, componentName: '老图纸（不挂）', ownerId: 'u-des', planDate: dayOff(40) }, 'u-pm')
    expect(t.planNodeId).toBeNull()
    await s.plan.createNode(OTHER_WO, { name: '别的工单节点', dept: 'TECH', planDate: dayOff(20) }, 'u-pm')
    const other = (await nodesOf(OTHER_WO))[0]!
    await expect(s.dr.createTask({ workOrderNumber: WO, componentName: 'x', planDate: dayOff(40), planNodeId: other.id }, 'u-pm')).rejects.toThrow('不属于该工单')
    const linked = await s.dr.createTask({ workOrderNumber: WO, componentName: '主梁总图', ownerId: 'u-des', planDate: dayOff(55), planNodeId: design!.id }, 'u-pm')
    expect(linked.planNodeId).toBe(design!.id)
    expect(linked.planWarning).toContain('晚于总计划节点"设计出图"')
  })

  it('发布：记基线、给部门负责人发确认待办（没负责人的部门报出来）；不能重复发布、不能再按模板生成', async () => {
    // 加一个质量部节点（质量部没有负责人）
    await s.plan.createNode(WO, { name: '出厂检验', dept: 'QUALITY', planDate: dayOff(148), seq: 11 }, 'u-pm')
    const r = await s.plan.publishPlan(WO, 'u-pm')
    expect(r.nodes).toBe(12)
    expect(r.deptsWithoutHead).toEqual(['质量部'])
    const nodes = await nodesOf(WO)
    expect(nodes.every((n) => n.baselineDate && +n.baselineDate === +n.planDate)).toBe(true)
    expect(nodes.every((n) => n.confirmStatus === 'PENDING')).toBe(true)
    const design = nodes.find((n) => n.name === '设计出图')!
    expect((await openTodos(design.id)).map((t) => t.ownerId)).toEqual(['u-techhead'])
    const contract = nodes.find((n) => n.name === '合同评审')!
    expect((await openTodos(contract.id)).map((t) => t.ownerId)).toEqual(['u-pdh'])
    expect(await openTodos(nodes.find((n) => n.name === '出厂检验')!.id)).toHaveLength(0)
    expect(r.todos).toBe(11)
    // 待办标题、跳转
    const mine = await s.todos.listMyTodos('u-techhead')
    const todo = mine.find((t) => t.refId === design.id)!
    expect(todo.title).toContain(`确认总计划节点：${WO} · 设计出图（技术部`)
    expect(todo.plan?.link).toBe(`/plan?wo=${WO}&node=${design.id}`)

    await expect(s.plan.publishPlan(WO, 'u-pm')).rejects.toThrow('已经发布过了')
    await expect(s.plan.generateFromTemplate(WO, 'plan-tpl-generic', 'u-pm')).rejects.toThrow('已发布')
    expect((await s.plan.planOptions(WO)).published).toBe(true)
  })

  it('确认 / 退回：确认关闭待办；退回写原因并提醒项目经理；总计划页按人给出能否确认', async () => {
    const nodes = await nodesOf(WO)
    const design = nodes.find((n) => n.name === '设计出图')!
    const buy = nodes.find((n) => n.name === '关键物料到货')!
    const view = await s.plan.getPlan(WO, await ctxOf('u-techhead'))
    expect(view.nodes.find((n) => n.id === design.id)).toMatchObject({ canConfirm: true, canComplete: true })
    expect(view.nodes.find((n) => n.id === buy.id)).toMatchObject({ canConfirm: false, canComplete: false })
    expect(view.canEdit).toBe(false)
    expect((await s.plan.getPlan(WO, await ctxOf('u-pm'))).canEdit).toBe(true)

    await s.plan.confirmNode(design.id, 'u-techhead')
    expect(await db.planNode.findUnique({ where: { id: design.id } })).toMatchObject({ confirmStatus: 'CONFIRMED', confirmedBy: 'u-techhead' })
    expect(await openTodos(design.id)).toHaveLength(0)
    await expect(s.plan.confirmNode(design.id, 'u-techhead')).rejects.toThrow()

    await s.plan.rejectNode(buy.id, '供应商排产已满，最早晚一周', 'u-buyhead')
    expect(await db.planNode.findUnique({ where: { id: buy.id } })).toMatchObject({ confirmStatus: 'REJECTED', rejectReason: '供应商排产已满，最早晚一周' })
    const rem = await db.reminder.findFirst({ where: { userId: 'u-pm', kind: 'PLAN' } })
    expect(rem?.title).toContain('退回')
    expect(rem?.link).toBe(`/plan?wo=${WO}&node=${buy.id}`)
    expect(await openTodos(buy.id)).toHaveLength(0)
  })

  it('发布后改日期：必须写原因，记调整记录，重新请确认；删节点、加节点同样要原因', async () => {
    const nodes = await nodesOf(WO)
    const buy = nodes.find((n) => n.name === '关键物料到货')!
    await expect(s.plan.updateNode(buy.id, { planDate: dayOff(97) }, 'u-pm')).rejects.toThrow('原因')
    // 只改备注不用原因
    await s.plan.updateNode(buy.id, { note: '进口件' }, 'u-pm')
    const r = await s.plan.updateNode(buy.id, { planDate: dayOff(97), reason: '按采购部退回意见顺延一周' }, 'u-pm')
    expect(r.reconfirm).toBe(true)
    const log = await db.planChangeLog.findFirst({ where: { nodeId: buy.id } })
    expect(log).toMatchObject({ kind: 'DATE', reason: '按采购部退回意见顺延一周', actorId: 'u-pm' })
    expect(log!.oldDate!.toISOString().slice(0, 10)).toBe(dayStr(90))
    expect(log!.newDate!.toISOString().slice(0, 10)).toBe(dayStr(97))
    const after = await db.planNode.findUnique({ where: { id: buy.id } })
    expect(after).toMatchObject({ confirmStatus: 'PENDING', rejectReason: null })
    expect(after!.baselineDate!.toISOString().slice(0, 10)).toBe(dayStr(90)) // 基线不变
    expect((await openTodos(buy.id)).map((t) => t.ownerId)).toEqual(['u-buyhead'])

    await expect(s.plan.createNode(WO, { name: '型式试验', dept: 'TECH', planDate: dayOff(140) }, 'u-pm')).rejects.toThrow('原因')
    const added = await s.plan.createNode(WO, { name: '型式试验', dept: 'TECH', planDate: dayOff(140), reason: '客户追加' }, 'u-pm')
    expect(await db.planNode.findUnique({ where: { id: added.id } })).toMatchObject({ baselineDate: null, confirmStatus: 'PENDING' })
    await expect(s.plan.deleteNode(added.id, null, 'u-pm')).rejects.toThrow('原因')
    await s.plan.deleteNode(added.id, '客户取消', 'u-pm')
    expect((await db.planChangeLog.findMany({ where: { workOrderNumber: WO }, orderBy: { createdAt: 'asc' } })).map((l) => l.kind)).toEqual(['DATE', 'ADD', 'DELETE'])
    expect(await db.todo.count({ where: { refId: added.id, status: 'OPEN' } })).toBe(0)
    expect((await s.plan.getPlan(WO, await ctxOf('u-pm'))).changeLogs).toHaveLength(3)
  })

  it('已发布：手工新建部门记录必须选节点；晚于节点日只提示；老数据（没挂）照旧能改；已挂的不能改成不挂；系统生成的不受影响', async () => {
    const nodes = await nodesOf(WO)
    const design = nodes.find((n) => n.name === '设计出图')!
    const buy = nodes.find((n) => n.name === '关键物料到货')!
    const assy = nodes.find((n) => n.name === '装配')!
    const cut = nodes.find((n) => n.name === '下料组焊')!
    const NEED = '该工单已发布总计划，请选择所属总计划节点'
    // 设计
    await expect(s.dr.createTask({ workOrderNumber: WO, componentName: 'x', planDate: dayOff(40) }, 'u-pm')).rejects.toThrow(NEED)
    const t = await s.dr.createTask({ workOrderNumber: WO, componentName: '液压原理图', planDate: dayOff(40), planNodeId: design.id }, 'u-pm')
    expect(t.planWarning).toBeNull()
    // 采购：承诺日晚于节点日 → 提示，照样保存
    await expect(s.pur.createLine({ workOrderNumber: WO, materialName: '钢板', quantity: 1, needDate: dayOff(80) }, 'u-pm')).rejects.toThrow(NEED)
    const l = await s.pur.createLine({ workOrderNumber: WO, materialName: '回转支承', quantity: 1, needDate: dayOff(90), promisedDate: dayOff(99), planNodeId: buy.id }, 'u-pm')
    expect(l.planWarning).toContain('承诺到货日')
    expect(await db.purchaseLine.count({ where: { id: l.id } })).toBe(1)
    // 装配节点
    await expect(s.kit.createNode({ workOrderNumber: WO, name: '总装', needDate: dayOff(140) }, PROD)).rejects.toThrow(NEED)
    const k = await s.kit.createNode({ workOrderNumber: WO, name: '总装', needDate: dayOff(141), planNodeId: assy.id }, PROD)
    expect(k.planWarning).toContain('需求日')
    // 工序：手工添加必选；BOM / 模板 / 复制路线这类批量生成的不经过这里
    const part = await s.steps.createPart(WO, { name: '主梁', quantity: 1 })
    await expect(s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-prodhead' }, 'u-prodhead')).rejects.toThrow(NEED)
    const st = await s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-prodhead', dueDate: dayOff(106), planNodeId: cut.id }, 'u-prodhead')
    expect(st.planWarning).toContain('要求完成日')
    // 改成不挂：拒绝；改挂别的节点：可以
    await expect(s.steps.updateStep(st.id, { planNodeId: null })).rejects.toThrow('不能改成不挂')
    await s.steps.updateStep(st.id, { planNodeId: assy.id })
    await s.steps.updateStep(st.id, { planNodeId: cut.id })
    // 老数据（发布前建的、没挂）：不带 planNodeId 照常能改
    const old = await db.drawingTask.findFirstOrThrow({ where: { workOrderNumber: WO, componentName: '老图纸（不挂）' } })
    await s.dr.updateTask(old.id, { note: '老数据照常改' })
    await s.dr.updateTask(old.id, { planNodeId: null })
    expect((await db.drawingTask.findUniqueOrThrow({ where: { id: old.id } })).planNodeId).toBeNull()
    // 未挂节点的条数
    expect((await s.plan.getPlan(WO, await ctxOf('u-pm'))).unlinked).toMatchObject({ drawing: 1, purchase: 0, step: 0, assembly: 0, total: 1 })
  })

  it('Excel 导入：按节点名称匹配；匹配不到、已发布没填的留空照常导入并提示', async () => {
    const ctx = {
      workOrders: new Set([WO]),
      canSee: () => true,
      existing: [],
      parts: [],
      users: [],
      suppliers: [],
      planNodes: (await nodesOf(WO)).map((n) => ({ id: n.id, workOrderNumber: n.workOrderNumber, name: n.name })),
      publishedWos: new Set([WO]),
      today: dayStr(0),
    } as unknown as Parameters<Services['imp']['validateRows']>[1]
    const row = (r: number, planNode?: string) => ({ row: r, values: { workOrderNumber: WO, materialName: `物料${r}`, quantity: 1, needDate: dayStr(80), ...(planNode ? { planNode } : {}) } })
    const res = s.imp.validateRows([row(2, '关键物料到货'), row(3, '不存在的节点'), row(4)] as never, ctx)
    expect(res.errors).toEqual([])
    expect(res.lines).toHaveLength(3)
    const buy = (await nodesOf(WO)).find((n) => n.name === '关键物料到货')!
    expect(res.lines.map((x) => x.planNodeId ?? null)).toEqual([buy.id, null, null])
    expect(res.warnings.map((w) => w.row)).toEqual([3, 4])
    expect(res.warnings[0]!.messages[0]).toContain('没有节点"不存在的节点"')
  })

  it('预计日顺延、预计交期；W9 只报源头节点（按自身延误 1 天黄、3 天红），受上游影响的不报；交期风险单独一条工单级红；完成后自动清除；看板 / 总览 / 每日汇总', async () => {
    // 交期 60 天后，主线留有余量：设计 10 天后、制造 30 天后（最后一个节点，比交期早 30 天）
    const a = await s.plan.createNode(W9WO, { name: '设计', dept: 'TECH', planDate: dayOff(10) }, 'u-pm')
    const b = await s.plan.createNode(W9WO, { name: '制造', dept: 'PRODUCTION', planDate: dayOff(30) }, 'u-pm')
    await s.plan.publishPlan(W9WO, 'u-pm')
    const t = await s.dr.createTask({ workOrderNumber: W9WO, componentName: '总图', ownerId: 'u-des', planDate: dayOff(12), planNodeId: a.id }, 'u-pm')
    const now = new Date()
    await s.scan.scanRules(now)
    const alert = (nodeId: string) => db.alert.findFirst({ where: { rule: 'W9', refType: 'planNode', refId: nodeId, status: 'ACTIVE' } })
    const planAlert = () => db.alert.findFirst({ where: { rule: 'W9', refType: 'plan', refId: W9WO, status: 'ACTIVE' } })
    // 设计自身晚 2 天：源头，黄；制造只因顺延晚 2 天：不报；预计交期 32 天后，不拖期：没有工单级
    expect((await alert(a.id))?.level).toBe('YELLOW')
    expect(await alert(b.id)).toBeNull()
    expect(await planAlert()).toBeNull()
    let view = await s.plan.getPlan(W9WO, await ctxOf('u-pm'))
    expect(view.nodes.map((n) => [n.expectedDate, n.delayDays, n.driver, n.source, n.upstream, n.selfDelayDays])).toEqual([
      [dayStr(12), 2, 'task', true, false, 2],
      [dayStr(32), 2, 'prev', false, true, 0],
    ])
    expect(view).toMatchObject({ expectedDelivery: dayStr(32), deliveryDelayDays: -28, delayedNodes: 2, sourceNodes: 1, planAlertLevel: null })
    expect(view.nodes[0]!.tasks[0]).toMatchObject({ kind: 'drawing', id: t.id, lateForNode: true, link: `/drawings?id=${t.id}` })
    // 黄色起通知：技术部负责人 + 项目经理
    const yellowTo = (await db.reminder.findMany({ where: { alertId: (await alert(a.id))!.id } })).map((r) => r.userId)
    expect(yellowTo).toEqual(expect.arrayContaining(['u-techhead', 'u-pm']))

    // 设计自身晚 4 天：红；制造仍只是受上游影响
    await s.dr.updateTask(t.id, { planDate: dayOff(14) })
    await s.scan.scanRules(now)
    expect((await alert(a.id))?.level).toBe('RED')
    expect(await alert(b.id)).toBeNull()

    // 制造自己也挂了晚 1 天的物料（顺延后总共晚 4 天）：成了源头，级别按自身 1 天 → 黄
    const l = await s.pur.createLine({ workOrderNumber: W9WO, materialName: '电机', quantity: 1, needDate: dayOff(31), planNodeId: b.id }, 'u-pm')
    await s.scan.scanRules(now)
    expect((await alert(b.id))?.level).toBe('YELLOW')

    // 预计交期晚于合同交期：交期提前到 33 天后 → 预计 34 天后，拖期 1 天 → 工单级红；节点级不跟着升红
    await db.qmsWorkOrder.update({ where: { workOrderNumber: W9WO }, data: { deliveryDate: dayOff(33) } })
    await s.scan.scanRules(now)
    const pa = await planAlert()
    expect(pa?.level).toBe('RED')
    expect((await alert(b.id))?.level).toBe('YELLOW')
    const paTo = (await db.reminder.findMany({ where: { alertId: pa!.id } })).map((r) => r.userId).sort()
    expect(paTo).toEqual(['u-lead', 'u-pdh', 'u-pm'])
    const paTitle = (await db.reminder.findFirst({ where: { alertId: pa!.id } }))!.title
    expect(paTitle).toContain(`按总计划预计 ${dayStr(34)} 交付，拖期 1 天；源头延误节点：设计、制造`)
    view = await s.plan.getPlan(W9WO, await ctxOf('u-pm'))
    expect(view).toMatchObject({ deliveryDelayDays: 1, sourceNodes: 2, planAlertLevel: 'RED' })
    // 预警列表：工单级一行，跳到总计划页，不显示持续时长；节点级只有两个源头节点
    const list = await s.reminders.listAlerts({ rule: 'W9', workOrderNumber: W9WO })
    expect(list.filter((x) => x.refType === 'plan')).toMatchObject([{ level: 'RED', link: `/plan?wo=${W9WO}`, duration: null, subject: '总计划预计交期' }])
    expect(list.filter((x) => x.refType === 'planNode').map((x) => x.refId).sort()).toEqual([a.id, b.id].sort())
    const row = (await s.board.getBoard(undefined)).rows.find((r) => r.workOrderNumber === W9WO)!
    expect(row).toMatchObject({ expectedDelivery: dayStr(34), delayDays: 1, delayedPlanNodes: 2 })
    const ov = await s.overview.getOverview()
    expect(ov.planDelays.find((d) => d.workOrderNumber === W9WO)).toMatchObject({ delayDays: 1, delayedNodes: 2, cause: '设计（技术部）自身晚 4 天' })
    expect(ov.planByDept.find((d) => d.dept === 'TECH')!.delayed).toBeGreaterThanOrEqual(1)
    await s.digest.generateDailyDigest({ now, force: true })
    const digest = await db.reminder.findFirst({ where: { userId: 'u-pm', kind: 'DIGEST' }, orderBy: { createdAt: 'desc' } })
    expect(digest?.title).toMatch(/总计划延误节点 \d+ 个，预计拖期工单 \d+ 个（最长 \d+ 天）/)

    // 处理掉：交期改回、物料删掉、设计完成（节点自动完成）→ 节点级、工单级预警全部消除
    await db.qmsWorkOrder.update({ where: { workOrderNumber: W9WO }, data: { deliveryDate: dayOff(60) } })
    await s.pur.deleteLine(l.id)
    await db.drawingTask.update({ where: { id: t.id }, data: { status: 'DONE', drawnDate: dayOff(0) } })
    await s.scan.scanRules(now)
    expect(await alert(a.id)).toBeNull()
    expect(await alert(b.id)).toBeNull()
    expect(await planAlert()).toBeNull()
    view = await s.plan.getPlan(W9WO, await ctxOf('u-pm'))
    expect(view.nodes[0]).toMatchObject({ done: true, doneBy: 'AUTO', actualDate: dayStr(0) })
    expect(view.nodes[1]).toMatchObject({ expectedDate: dayStr(30), delayDays: 0, source: false, upstream: false })
    expect(view.deliveryDelayDays).toBe(-30)
  })

  it('手动完成 / 撤销：手动优先；撤销后回到按挂靠任务自动判断；自动完成的不能撤销', async () => {
    const [a] = await nodesOf(W9WO)
    await expect(s.plan.undoCompleteNode(a!.id)).rejects.toThrow('没有手动标记完成') // 自动完成的不能撤销
    await s.plan.completeNode(a!.id, dayOff(-1), 'u-techhead')
    let view = await s.plan.getPlan(W9WO, await ctxOf('u-pm'))
    expect(view.nodes[0]).toMatchObject({ done: true, doneBy: 'MANUAL', actualDate: dayStr(-1), manualDoneByName: '技术部长' })
    await s.plan.undoCompleteNode(a!.id)
    view = await s.plan.getPlan(W9WO, await ctxOf('u-pm'))
    expect(view.nodes[0]).toMatchObject({ doneBy: 'AUTO' })
  })

  it('超时未确认：按 W5 阈值（4 小时提醒、1 天黄、2 天红），确认后消除；不计入 W5', async () => {
    const nodes = await nodesOf(W9WO)
    const b = nodes.find((n) => n.name === '制造')!
    const todo = (await openTodos(b.id))[0]!
    const confirmAlert = () => db.alert.findFirst({ where: { rule: 'W9', refType: 'planConfirm', refId: b.id, status: 'ACTIVE' } })
    await s.scan.scanRules(new Date(+todo.createdAt + 2 * HOUR))
    expect(await confirmAlert()).toBeNull()
    await s.scan.scanRules(new Date(+todo.createdAt + 5 * HOUR))
    expect((await confirmAlert())?.level).toBe('REMIND')
    await s.scan.scanRules(new Date(+todo.createdAt + 25 * HOUR))
    expect((await confirmAlert())?.level).toBe('YELLOW')
    await s.scan.scanRules(new Date(+todo.createdAt + 49 * HOUR))
    const red = await confirmAlert()
    expect(red?.level).toBe('RED')
    const to = (await db.reminder.findMany({ where: { alertId: red!.id } })).map((r) => r.userId)
    expect(to).toEqual(expect.arrayContaining(['u-prodhead', 'u-pm', 'u-pdh', 'u-lead']))
    expect(await db.alert.count({ where: { rule: 'W5' } })).toBe(0)
    await s.plan.confirmNode(b.id, 'u-prodhead')
    await s.scan.scanRules(new Date(+todo.createdAt + 50 * HOUR))
    expect(await confirmAlert()).toBeNull()
  })
})
