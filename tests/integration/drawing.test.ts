/**
 * 设计任务（R11）：真实 MySQL 上直接调用服务层，用 now 注入"快进时钟"。
 * 覆盖：新建 → 标记设计完成（只有负责人 / 管理员）→ 一键发放（发放单关联任务）→ "可以开工"门槛（物料齐了也要等图纸）、
 * 发放单作废回退、客户确认节点、取消 / 改关联工件、W7 判定与升级阶梯（不转异常）、列表筛选与截断前排序、设计负荷、看板。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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

describe.skipIf(!DB)('设计任务（R11）', () => {
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
    await db.uploadFile.deleteMany()
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

  it('创建 → 设计完成 → 发放 → 可以开工：物料齐了也要等图纸；发放单作废回退、再发放再发', async () => {
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

    // 还没完成设计不能发放
    await expect(release(t.id)).rejects.toThrow('还没有完成设计')
    // 只有负责人本人或管理员能标记设计完成；设计完成日不能晚于今天
    await expect(s.dr.markDrawn(t.id, null, STRANGER)).rejects.toThrow('只有设计负责人本人或管理员')
    await expect(s.dr.markDrawn(t.id, dayOff(1), DESIGNER)).rejects.toThrow('不能晚于今天')
    expect(await s.dr.markDrawn(t.id, null, DESIGNER)).toMatchObject({ status: 'DRAWN', readySent: 0 })
    expect(await db.drawingTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ drawnDate: today(), drawnBy: 'u-des' })
    await expect(s.dr.markDrawn(t.id, null, ADMIN)).rejects.toThrow('已经标记过设计完成')
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
    expect(mine.find((x) => x.action === 'READY_TO_START')?.suggestion).toContain('图纸已发放（1 个设计任务）')

    // 已发放的不能撤销设计完成
    await expect(s.dr.undoDrawn(t.id, DESIGNER)).rejects.toThrow('请先作废发放单')

    // 发放单作废 → 任务回到设计完成，没处理的"可以开工"作废
    await s.rel.voidRelease(r1.id, { userId: 'u-des', isAdmin: false })
    expect(await statusOf(t.id)).toBe('DRAWN')
    todos = await readyTodos(part.id)
    expect(todos.map((x) => x.status)).toEqual(['CANCELLED'])

    // 再发放 → 再发
    const r2 = await release(t.id)
    expect(r2.drawing).toMatchObject({ status: 'DONE', readySent: 1 })
    expect((await readyTodos(part.id)).filter((x) => x.status === 'OPEN')).toHaveLength(1)

    // 再挂一个设计中的任务 → 没处理的待办作废
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

  it('发放图纸附 BOM：按图号建工件并关联发放单和设计任务；分批累加不重复建；版号变了拦下；没记版号的补上', async () => {
    const BWO = OTHER_WO
    const rows = (list: [string | null, string | null, string, number][]) => list.map(([drawingNo, revision, name, quantity], i) => ({ row: i + 2, drawingNo, revision, name, quantity }))
    const bomFile = async () => (await db.uploadFile.create({ data: { id: randomBytes(16).toString('hex'), storedName: 'x.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 1, uploaderId: 'u-des' } })).id
    await s.steps.createPart(BWO, { name: '旧支腿', quantity: 1, drawingNo: 'ZT-100' })
    const t = await s.dr.createTask({ workOrderNumber: BWO, componentName: '车架总图', ownerId: 'u-des', planDate: dayOff(10) }, 'u-pm')
    await s.dr.markDrawn(t.id, null, DESIGNER)
    const send = async (list: Parameters<typeof rows>[0], over: Partial<Parameters<Services['rel']['createRelease']>[0]> = {}) =>
      s.rel.createRelease({ type: 'DRAWING', workOrderNumber: BWO, description: '车架图纸', userIds: ['u-worker'], drawingTaskId: t.id, bom: { fileId: await bomFile(), rows: rows(list) }, ...over }, 'u-des')

    // 只有图纸发放单能附 BOM
    await expect(send([['CJ-001', 'A', '主梁', 1]], { type: 'CHANGE' })).rejects.toThrow('只有图纸发放单可以附 BOM 表')
    // 行错误：整张不发、不建
    await expect(send([['CJ-001', 'A', '主梁', 0]])).rejects.toThrow('BOM 表有 1 行不对')
    expect(await db.release.count({ where: { workOrderNumber: BWO } })).toBe(0)

    // 第一批：新建 2 个（同图号合并），已有的 ZT-100 没记版号 → 补上；螺栓、没图号的不建
    const r1 = await send([
      ['CJ-001', 'A', '主梁', 1],
      ['cj-001 ', 'A', '主梁', 1],
      ['CJ-002', 'A', '端梁', 2],
      ['ZT-100', 'B', '支腿', 1],
      ['GB5783', null, '六角头螺栓 M16', 40],
      [null, null, '减速机', 1],
    ])
    // 3 个工件都还没有工序链 → 提醒生产经理排工序（每张发放单每人一条），跳到工件页只看未排工序
    expect(r1.bom).toEqual({ created: 2, matched: 1, revisionFilled: 1, skipped: 2, unrouted: 3, unroutedNotified: true })
    expect(r1.drawing).toMatchObject({ status: 'DONE' })
    const routeReminders = await db.reminder.findMany({ where: { dedupeKey: { startsWith: `RELEASE_ROUTE:${r1.id}:` } } })
    expect(routeReminders.map((r) => [r.userId, r.kind, r.link])).toEqual([['u-prodhead', 'RELEASE', `/parts?wo=${BWO}&noRoute=1`]])
    expect(routeReminders[0]!.title).toContain('3 个工件还没有工序链')
    const parts = await db.part.findMany({ where: { workOrderNumber: BWO, drawingNo: { not: null } }, orderBy: { drawingNo: 'asc' } })
    expect(parts.map((p) => [p.drawingNo, p.revision, p.quantity, p.fromTechBom])).toEqual([
      ['CJ-001', 'A', 2, true],
      ['CJ-002', 'A', 2, true],
      ['ZT-100', 'B', 1, false],
    ])
    const rel1 = await db.release.findUniqueOrThrow({ where: { id: r1.id } })
    expect(new Set(rel1.partIds as string[])).toEqual(new Set(parts.map((p) => p.id)))
    expect(rel1.bomFileId).toBeTruthy()
    expect((await db.uploadFile.findUniqueOrThrow({ where: { id: rel1.bomFileId! } })).releaseId).toBe(r1.id)
    expect((await db.drawingTaskPart.findMany({ where: { taskId: t.id } })).map((x) => x.partId).sort()).toEqual(parts.map((p) => p.id).sort())
    // 详情：BOM 表单独列出（不混在附件里），工件带版号、数量
    const detail = await s.rel.getRelease(r1.id, DESIGNER)
    expect(detail.bomFile?.id).toBe(rel1.bomFileId)
    expect(detail.attachments).toEqual([])
    expect(detail.parts.find((p) => p.drawingNo === 'CJ-002')).toMatchObject({ revision: 'A', quantity: 2 })
    // 同一个 BOM 文件不能再用
    await expect(
      s.rel.createRelease({ type: 'DRAWING', workOrderNumber: BWO, description: 'x', userIds: ['u-worker'], bom: { fileId: rel1.bomFileId!, rows: rows([['CJ-009', null, '吊耳', 1]]) } }, 'u-des'),
    ).rejects.toThrow('BOM 表无效或已被使用')
    expect(await db.part.count({ where: { workOrderNumber: BWO, drawingNo: 'CJ-009' } })).toBe(0)

    // 第二批（不从设计任务发）：只带新图号 + 一个已有的，累加不重复建
    // CJ-002 先排上工序：只提醒还没有工序链的 CJ-003
    await s.steps.addStep(parts.find((p) => p.drawingNo === 'CJ-002')!.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-worker' }, 'u-worker')
    const r2 = await send([['CJ-002', 'A', '端梁', 2], ['CJ-003', null, '横梁', 1]], { drawingTaskId: null })
    expect(r2.bom).toEqual({ created: 1, matched: 1, revisionFilled: 0, skipped: 0, unrouted: 1, unroutedNotified: true })
    expect((await db.reminder.findFirstOrThrow({ where: { dedupeKey: `RELEASE_ROUTE:${r2.id}:u-prodhead` } })).title).toContain('1 个工件还没有工序链')
    expect(await db.part.count({ where: { workOrderNumber: BWO, drawingNo: { not: null } } })).toBe(4)

    // 版号变了：整张拦下，提示发设计变更，已有工件不改
    await expect(send([['CJ-001', 'B', '主梁', 2], ['CJ-004', 'A', '新件', 1]], { drawingTaskId: null })).rejects.toThrow('版号变了请发"设计变更"')
    expect((await db.part.findFirstOrThrow({ where: { workOrderNumber: BWO, drawingNo: 'CJ-001' } })).revision).toBe('A')
    expect(await db.part.count({ where: { workOrderNumber: BWO, drawingNo: 'CJ-004' } })).toBe(0)
    // 只有螺栓：没有要建的工件
    await expect(send([['GB5783', null, '螺栓', 4]], { drawingTaskId: null })).rejects.toThrow('没有要建的工件')

    // 两人同时发同一批：后一个等前一个提交，按图号关联，不重复建
    const [a, b] = await Promise.all([send([['CJ-010', 'A', '并发件', 1]], { drawingTaskId: null }), send([['CJ-010', 'A', '并发件', 1]], { drawingTaskId: null })])
    expect([a.bom!.created, b.bom!.created].sort()).toEqual([0, 1])
    expect(await db.part.count({ where: { workOrderNumber: BWO, drawingNo: 'CJ-010' } })).toBe(1)

    // 负责人账号在 QMS 停用了：同样算没人收到
    const headIds = (await db.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: '生产部' } })).map((h) => h.userId)
    await db.qmsUser.updateMany({ where: { id: { in: headIds } }, data: { status: 'INACTIVE' } })
    try {
      const r4 = await send([['CJ-012', null, '停用负责人件', 1]], { drawingTaskId: null })
      expect(r4.bom).toMatchObject({ unrouted: 1, unroutedNotified: false })
    } finally {
      await db.qmsUser.updateMany({ where: { id: { in: headIds } }, data: { status: 'ACTIVE' } })
    }

    // 没设生产部负责人：不建提醒，也不能告诉发放人"已提醒"
    const heads = await db.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: '生产部' } })
    await db.notifyRole.deleteMany({ where: { id: { in: heads.map((h) => h.id) } } })
    try {
      const r3 = await send([['CJ-011', null, '无人提醒件', 1]], { drawingTaskId: null })
      expect(r3.bom).toMatchObject({ unrouted: 1, unroutedNotified: false })
      expect(await db.reminder.count({ where: { dedupeKey: { startsWith: `RELEASE_ROUTE:${r3.id}:` } } })).toBe(0)
    } finally {
      await db.notifyRole.createMany({ data: heads })
    }
  })

  it('客户确认是独立节点：发放后待客户确认，确认后才算完成；只挂设计任务的工件也会发"可以开工"', async () => {
    const part = await makePart()
    const t = await task({ partIds: [part.id], needsCustomerConfirm: true, customerPlanDate: dayOff(5), componentName: '液压系统' })
    await expect(s.dr.confirmCustomer(t.id, null, 'u-pm')).rejects.toThrow('还没有完成设计')
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
    // 撤销设计完成（未发放）：回到设计中
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

    // 设计完成后预警立即消除；取消的下一轮扫描消除
    await s.dr.markDrawn(due.id, null, DESIGNER)
    expect((await db.alert.findFirstOrThrow({ where: { refId: due.id, rule: 'W7' } })).status).toBe('CLEARED')
    await s.dr.updateTask(noOwner.id, { cancelled: true })
    expect((await db.alert.findFirstOrThrow({ where: { refId: noOwner.id, rule: 'W7' } })).status).toBe('CLEARED')

    // 阈值可改：提醒窗口改成 5 天 → "还早"也黄
    await db.threshold.upsert({ where: { rule: 'W7' }, update: { remindHours: 120 }, create: { rule: 'W7', remindHours: 120, yellowDays: 1, redDays: 4 } })
    const again = await s.scan.collectTargets(new Date(), await s.scan.loadThresholds(), [], 'W7')
    expect(again.find((x) => x.refId === far.id)).toMatchObject({ level: 'YELLOW' })
    await db.threshold.deleteMany()

    // 提醒跳转：电脑端设计任务页，手机端我的设计任务
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
    // 设计中在前（按计划日从近到远），设计完成在后
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
    expect(digest.title).toContain('设计逾期 2 项')
  })
})
