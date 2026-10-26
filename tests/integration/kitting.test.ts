/**
 * 齐套（R12）：真实 MySQL 上直接调用服务层，用 now 注入"快进时钟"。
 * 覆盖：装配节点增删改与权限（生产经理 / 该工单项目经理 / 管理员）、节点清单（同一工件可挂多个节点、只限同一工单）、
 * 齐套率随到货 / 完工 / 取消变化、缺件卡在哪一步、W8 阶梯（节点负责人 → 生产经理 + 项目经理 → 项目部负责人 + 领导）与自动清除、
 * 列表（数据库里先筛选排序再截断、跨工单、我负责的）、看板与每日汇总的"未齐套节点"。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL
const DAY = 86_400_000

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  finish: typeof import('../../server/services/flow/finish')
  scan: typeof import('../../server/services/alerts/scan')
  rules: typeof import('../../server/services/alerts/rules')
  board: typeof import('../../server/services/issues/board')
  digest: typeof import('../../server/services/alerts/digest')
  reminders: typeof import('../../server/services/alerts/reminders')
  settings: typeof import('../../server/services/alerts/settings')
  pur: typeof import('../../server/services/purchases/purchases')
  dr: typeof import('../../server/services/drawings/drawings')
  kit: typeof import('../../server/services/kitting/kitting')
  demo: typeof import('../../server/services/dev/demo')
}

describe.skipIf(!DB)('齐套（R12）', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-R12'
  const OTHER_WO = 'T-WO-R12-B'
  const ADMIN = { userId: 'u-admin', isAdmin: true }
  const PROD = { userId: 'u-prodhead', isAdmin: false }
  const PM = { userId: 'u-pm', isAdmin: false }
  const WORKER = { userId: 'u-worker', isAdmin: false }
  const W8 = { remindHours: null, yellowDays: 5, redDays: 1 }

  async function clean() {
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.issue.deleteMany()
    await db.assemblyNode.deleteMany() // 清单级联删除
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

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      steps: await import('../../server/services/flow/steps'),
      flow: await import('../../server/services/flow/flow'),
      finish: await import('../../server/services/flow/finish'),
      scan: await import('../../server/services/alerts/scan'),
      rules: await import('../../server/services/alerts/rules'),
      board: await import('../../server/services/issues/board'),
      digest: await import('../../server/services/alerts/digest'),
      reminders: await import('../../server/services/alerts/reminders'),
      settings: await import('../../server/services/alerts/settings'),
      pur: await import('../../server/services/purchases/purchases'),
      dr: await import('../../server/services/drawings/drawings'),
      kit: await import('../../server/services/kitting/kitting'),
      demo: await import('../../server/services/dev/demo'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await clean()
    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [WO, OTHER_WO].map((wo) => ({ workOrderNumber: wo, customerName: '测试客户', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
    })
    await db.qmsProcess.createMany({ data: [{ id: 'P-CUT', name: '下料', updatedAt: now }, { id: 'P-WELD', name: '组焊', updatedAt: now }] })
    const DEPTS = ['生产部', '项目部', '公司领导', '技术部']
    await db.qmsDepartment.createMany({ data: DEPTS.map((name, i) => ({ id: `KD-${i}`, name, parentId: '0', status: 1, updatedAt: now })) })
    const user = (id: string, realName: string, dept: string) => ({ id, username: id, realName, departmentId: `KD-${DEPTS.indexOf(dept)}`, status: 'ACTIVE', updatedAt: now })
    await db.qmsUser.createMany({
      data: [
        user('u-owner', '装配班长', '生产部'),
        user('u-worker', '班组长', '生产部'),
        user('u-prodhead', '生产经理', '生产部'),
        user('u-pm', '项目经理', '项目部'),
        user('u-pdh', '项目部负责人', '项目部'),
        user('u-lead', '分管领导', '公司领导'),
        user('u-des', '设计员', '技术部'),
      ],
    })
    await db.notifyRole.createMany({
      data: [
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
  /** 工件：两道自制工序（下料 → 组焊） */
  async function makePart(wo = WO) {
    seq++
    const part = await s.steps.createPart(wo, { name: `工件-${seq}`, quantity: 1 })
    await s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', ownerId: 'u-worker' }, 'u-worker')
    await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'SELF', ownerId: 'u-worker' }, 'u-worker')
    return part
  }
  const line = (name: string, over: Partial<Parameters<Services['pur']['createLine']>[0]> = {}) =>
    s.pur.createLine({ workOrderNumber: WO, materialName: name, quantity: 1, needDate: dayOff(20), ...over }, 'u-pm')
  const node = (over: Partial<Parameters<Services['kit']['createNode']>[0]> = {}, actor = PROD) =>
    s.kit.createNode({ workOrderNumber: WO, name: '主梁总装', needDate: dayOff(30), ...over }, actor)
  const finishAll = async (partId: string) => {
    for (const st of await db.routeStep.findMany({ where: { partId }, orderBy: { seq: 'asc' } })) await s.finish.finishStep({ stepId: st.id, actorId: 'u-worker', source: 'PC' })
  }
  const view = (id: string) => s.kit.getNode(id, ADMIN)

  it('节点增删改 + 清单：生产经理 / 该工单项目经理 / 管理员能改，别人不能；同一工件可挂多个节点；只限同一工单', async () => {
    const p1 = await makePart()
    const p2 = await makePart()
    const otherPart = await makePart(OTHER_WO)
    const l1 = await line('钢板')
    const otherLine = await s.pur.createLine({ workOrderNumber: OTHER_WO, materialName: '别的钢板', quantity: 1, needDate: dayOff(20) }, 'u-pm')

    await expect(node({}, WORKER)).rejects.toThrow('只有生产经理、该工单的项目经理或管理员')
    await expect(node({ workOrderNumber: OTHER_WO }, PM)).rejects.toThrow('只有生产经理')
    await expect(node({ partIds: [otherPart.id] })).rejects.toThrow('所选工件不存在或不属于该工单')
    await expect(node({ purchaseIds: [otherLine.id] })).rejects.toThrow('所选关键物料不存在或不属于该工单')
    await expect(node({ ownerId: 'u-nobody' })).rejects.toThrow('节点负责人不存在')
    await expect(node({ workOrderNumber: 'NO-SUCH' })).rejects.toThrow('工单不存在')

    const a = await node({ name: '主梁总装', partIds: [p1.id, p2.id, p1.id], purchaseIds: [l1.id] }, PM)
    const b = await node({ name: '回转部装', partIds: [p1.id], ownerId: 'u-owner' }, ADMIN)
    const c = await node({ workOrderNumber: OTHER_WO, name: '别的工单节点' }, PROD)
    // 排序号不填 = 排在该工单最后
    expect([a.sortOrder, b.sortOrder, c.sortOrder]).toEqual([1, 2, 1])
    expect((await view(a.id)).partIds.sort()).toEqual([p1.id, p2.id].sort())
    // 同一工件挂在两个节点上
    expect(await db.assemblyNodePart.count({ where: { partId: p1.id } })).toBe(2)

    // 可编辑标记：项目经理只对自己的工单
    expect((await s.kit.getNode(a.id, PM)).canEdit).toBe(true)
    expect((await s.kit.getNode(c.id, PM)).canEdit).toBe(false)
    expect((await s.kit.getNode(c.id, PROD)).canEdit).toBe(true)
    expect((await s.kit.getNode(a.id, WORKER)).canEdit).toBe(false)
    expect((await view(a.id)).ownerText).toBe('生产经理（生产经理）')

    // 改：名称、需求日、负责人、排序、清单（整体替换）
    await expect(s.kit.updateNode(a.id, { name: 'x' }, WORKER)).rejects.toThrow('只有生产经理')
    await expect(s.kit.updateNode(a.id, { partIds: [otherPart.id] }, PM)).rejects.toThrow('不属于该工单')
    const r = await s.kit.updateNode(a.id, { name: '主梁总装（改）', needDate: dayOff(25), ownerId: 'u-owner', sortOrder: 5, partIds: [p2.id], purchaseIds: [] }, PM)
    expect(r).toMatchObject({ total: 1, ready: 0, percent: 0 })
    expect(await view(a.id)).toMatchObject({ name: '主梁总装（改）', ownerName: '装配班长', sortOrder: 5, partIds: [p2.id], purchaseIds: [] })
    expect(dateDay((await view(a.id)).needDate)).toBe(s.rules.dateFieldDay(dayOff(25)))
    // 按工单列：按排序号
    const list = await s.kit.listNodes({ workOrderNumber: WO }, PM, W8)
    expect(list.rows.map((x) => x.id)).toEqual([b.id, a.id])
    expect(list.canCreate).toBe(true)
    expect((await s.kit.listNodes({ workOrderNumber: OTHER_WO }, PM, W8)).canCreate).toBe(false)

    // 删：只删节点和清单，工件、物料还在
    await expect(s.kit.deleteNode(b.id, WORKER)).rejects.toThrow('只有生产经理')
    await s.kit.deleteNode(b.id, PM)
    await expect(view(b.id)).rejects.toThrow('不存在')
    expect(await db.part.count({ where: { id: p1.id } })).toBe(1)
    // 工件、物料删除后从清单里消失
    await s.kit.updateNode(a.id, { purchaseIds: [l1.id] }, PM)
    await s.pur.deleteLine(l1.id)
    expect((await view(a.id)).purchaseIds).toEqual([])
  })

  const dateDay = (v: Date | string) => new Date(v).toISOString().slice(0, 10)

  it('齐套率随到货 / 完工 / 取消变化；缺件标出卡在哪一步', async () => {
    const part = await makePart()
    const l1 = await line('钢板', { partId: part.id, promisedDate: dayOff(-1) })
    const l2 = await line('回转支承', { promisedDate: dayOff(40) })
    const l3 = await line('减速机')
    const n = await node({ name: '齐套测试', needDate: dayOff(30), partIds: [part.id], purchaseIds: [l1.id, l2.id, l3.id] })
    const draw = await s.dr.createTask({ workOrderNumber: WO, componentName: '主梁总图', ownerId: 'u-des', planDate: dayOff(5), partIds: [part.id] }, 'u-pm')

    let v = await view(n.id)
    expect(v).toMatchObject({ total: 4, ready: 0, percent: 0, incomplete: true })
    const partRow = () => v.shortages.find((x) => x.kind === 'part')!
    expect(partRow()).toMatchObject({ name: part.name, stage: '下料', reason: '图纸未完成', reasonCode: 'DRAWING', detail: '主梁总图' })
    // 物料：按承诺日排；逾期、赶不上节点
    expect(v.shortages.filter((x) => x.kind === 'purchase').map((x) => x.name)).toEqual(['钢板', '减速机', '回转支承'])
    expect(v.shortages.find((x) => x.id === l1.id)).toMatchObject({ stage: '超承诺日', overdue: true, lateForNode: false })
    expect(v.shortages.find((x) => x.id === l2.id)).toMatchObject({ overdue: false, lateForNode: true })

    // 设计任务取消 → 卡在"待料"（挂在工件上的钢板还没到）
    await s.dr.updateTask(draw.id, { cancelled: true })
    v = await view(n.id)
    expect(partRow()).toMatchObject({ reason: '待料', detail: '钢板' })
    // 到货 → 1/4；取消一项物料 → 不计入（1/3）
    await s.pur.confirmArrival(l1.id, { source: 'PC' }, 'u-worker')
    await s.pur.updateLine(l3.id, { status: 'CANCELLED' })
    v = await view(n.id)
    expect(v).toMatchObject({ total: 3, ready: 1, percent: 33 })
    expect(v.excluded).toEqual(['减速机'])
    expect(partRow()).toMatchObject({ reason: '待开工', stage: '下料' })

    // 开工 → 在制；第一道完工 → 当前工序变成组焊
    const steps = await db.routeStep.findMany({ where: { partId: part.id }, orderBy: { seq: 'asc' } })
    await s.flow.startStep({ stepId: steps[0]!.id, actorId: 'u-worker', source: 'PC' })
    v = await view(n.id)
    expect(partRow()).toMatchObject({ reason: '在制', stage: '下料' })
    await s.finish.finishStep({ stepId: steps[0]!.id, actorId: 'u-worker', source: 'PC' })
    v = await view(n.id)
    expect(partRow()).toMatchObject({ reason: '待开工', stage: '组焊' })
    // 最后一道完工 → 工件完成，算就绪
    await s.finish.finishStep({ stepId: steps[1]!.id, actorId: 'u-worker', source: 'PC' })
    v = await view(n.id)
    expect(v).toMatchObject({ total: 3, ready: 2, percent: 66 })
    expect(v.readyItems).toEqual(expect.arrayContaining([part.name, '钢板']))

    // 未齐套筛选（数据库口径）与页面口径一致
    const incompleteIds = async () => (await s.kit.listNodes({ workOrderNumber: WO, incompleteOnly: true }, ADMIN, W8)).rows.map((x) => x.id)
    expect(await incompleteIds()).toContain(n.id)
    await s.pur.confirmArrival(l2.id, { source: 'PC' }, 'u-worker')
    v = await view(n.id)
    expect(v).toMatchObject({ total: 3, ready: 3, percent: 100, incomplete: false, shortages: [] })
    expect(await incompleteIds()).not.toContain(n.id)
    // 撤销到货 → 又不齐
    await s.pur.undoArrival(l2.id)
    expect(await incompleteIds()).toContain(n.id)
    // 清单为空：没有齐套率，不算未齐套
    const empty = await node({ name: '空节点' })
    expect(await view(empty.id)).toMatchObject({ total: 0, percent: null, incomplete: false })
    expect(await incompleteIds()).not.toContain(empty.id)
  })

  it('W8：前 5 天黄、前 1 天红；节点负责人 → 生产经理 + 项目经理 → 项目部负责人 + 领导；不转异常；齐套后自动清除', async () => {
    await db.assemblyNode.deleteMany()
    await db.alert.deleteMany()
    await db.reminder.deleteMany()
    const p = await makePart()
    const lA = await line('A 料')
    const lB = await line('B 料')
    const soon = await node({ name: '5 天后', needDate: dayOff(5), ownerId: 'u-owner', purchaseIds: [lA.id] })
    const tomorrow = await node({ name: '明天', needDate: dayOff(1), partIds: [p.id] })
    const far = await node({ name: '6 天后', needDate: dayOff(6), purchaseIds: [lB.id] })
    const passed = await node({ name: '已过', needDate: dayOff(-3), purchaseIds: [lB.id], ownerId: 'u-owner' })
    const emptyDue = await node({ name: '空清单', needDate: dayOff(0) })
    const other = await node({ workOrderNumber: OTHER_WO, name: '别的工单', needDate: dayOff(2) })
    await s.kit.updateNode(other.id, { partIds: [(await makePart(OTHER_WO)).id] }, PROD)

    const targets = await s.scan.collectTargets(new Date(), await s.scan.loadThresholds(), [], 'W8')
    const byId = new Map(targets.map((x) => [x.refId, x]))
    expect(byId.get(soon.id)).toMatchObject({ level: 'YELLOW', ownerIds: ['u-owner'], deptNames: ['生产部'], workOrderNumber: WO })
    expect(byId.get(soon.id)!.summary).toContain('齐套 0/1（0%）')
    expect(byId.get(tomorrow.id)).toMatchObject({ level: 'RED', ownerIds: ['u-prodhead'] })
    expect(byId.get(passed.id)).toMatchObject({ level: 'RED' })
    expect(byId.get(passed.id)!.summary).toContain('已过 3 天')
    expect(byId.get(other.id)).toMatchObject({ level: 'YELLOW' })
    expect(byId.has(far.id)).toBe(false)
    expect(byId.has(emptyDue.id)).toBe(false)

    await s.scan.scanRules(new Date())
    const alertOf = (refId: string) => db.alert.findFirstOrThrow({ where: { refId, rule: 'W8' }, orderBy: { createdAt: 'desc' } })
    const recipients = async (refId: string) => [...new Set((await db.reminder.findMany({ where: { alertId: (await alertOf(refId)).id } })).map((r) => r.userId))].sort()
    expect(await recipients(soon.id)).toEqual(['u-owner', 'u-pm', 'u-prodhead'])
    expect(await recipients(tomorrow.id)).toEqual(['u-lead', 'u-pdh', 'u-pm', 'u-prodhead'])
    // 不转异常
    const w8Issues = async () => db.issue.count({ where: { sourceKey: { in: (await db.alert.findMany({ where: { rule: 'W8' } })).map((a) => `ALERT:${a.id}`) } } })
    expect(await w8Issues()).toBe(0)
    expect((await alertOf(tomorrow.id)).status).toBe('ACTIVE')

    // 快进 4 天：5 天后的到了前 1 天 → 红，加项目部负责人、领导；6 天后的进了黄色窗口
    await s.scan.scanRules(new Date(Date.now() + 4 * DAY))
    expect((await alertOf(soon.id)).level).toBe('RED')
    expect(await recipients(soon.id)).toEqual(['u-lead', 'u-owner', 'u-pdh', 'u-pm', 'u-prodhead'])
    expect((await alertOf(far.id)).level).toBe('YELLOW')
    expect(await w8Issues()).toBe(0)

    // 提醒跳转：电脑端齐套页，手机端齐套页
    const mine = await s.reminders.listReminders('u-owner')
    const w8 = mine.items.find((i) => i.rule === 'W8')
    expect(w8?.link).toMatch(/^\/kitting\?id=/)
    expect(w8?.mobileLink).toBe(`/m${w8!.link}`)
    const listed = await s.reminders.listAlerts({ rule: 'W8' })
    expect(listed.find((x) => x.refId === soon.id)).toMatchObject({ link: `/kitting?id=${soon.id}`, duration: null, canConvert: false })

    // 齐套率到 100% → 下一轮扫描自动清除（到货不用碰节点）
    await s.pur.confirmArrival(lA.id, { source: 'PC' }, 'u-worker')
    await s.scan.scanRules(new Date())
    expect((await alertOf(soon.id)).status).toBe('CLEARED')
    // 页面上：已齐的节点不再显示预警等级
    expect((await view(soon.id)).alertLevel).toBeNull()
    // 工件完工 → 清除
    await finishAll(p.id)
    await s.scan.scanRules(new Date())
    expect((await alertOf(tomorrow.id)).status).toBe('CLEARED')

    // 编辑清单让节点齐了（这里把未到货的移走 → 清单为空）：立即清除，不等扫描
    expect((await alertOf(passed.id)).status).toBe('ACTIVE')
    await s.kit.updateNode(passed.id, { purchaseIds: [] }, PROD)
    expect((await alertOf(passed.id)).status).toBe('CLEARED')
    // 快进时进了窗口的"6 天后"，按真实时间又出了窗口：本轮扫描消除
    expect((await alertOf(far.id)).status).toBe('CLEARED')
    // 原样保存（需求日没变）不清；真改了需求日才清
    const otherFirst = (await alertOf(other.id)).firstAt
    await s.kit.updateNode(other.id, { name: '别的工单', needDate: dayOff(2), note: '只改备注' }, PROD)
    expect(await alertOf(other.id)).toMatchObject({ status: 'ACTIVE', firstAt: otherFirst })
    await s.kit.updateNode(other.id, { needDate: dayOff(40) }, PROD)
    expect((await alertOf(other.id)).status).toBe('CLEARED')
    // 删除节点 → 立即清除
    const del = await node({ name: '要删的', needDate: dayOff(1), purchaseIds: [lB.id] })
    await s.scan.scanRules(new Date())
    expect((await alertOf(del.id)).status).toBe('ACTIVE')
    await s.kit.deleteNode(del.id, ADMIN)
    expect((await alertOf(del.id)).status).toBe('CLEARED')

    // 阈值在设置页可改：黄色改成前 10 天 → 6 天后的也黄；黄色天数不能小于红色
    await s.settings.saveThreshold('W8', { remindHours: null, yellowDays: 10, redDays: 2 })
    const again = await s.scan.collectTargets(new Date(), await s.scan.loadThresholds(), [], 'W8')
    expect(again.find((x) => x.refId === far.id)).toMatchObject({ level: 'YELLOW' })
    await expect(s.settings.saveThreshold('W8', { remindHours: null, yellowDays: 1, redDays: 3 })).rejects.toThrow('黄色的提前天数不能小于红色')
    expect((await db.threshold.findUniqueOrThrow({ where: { rule: 'W8' } })).remindHours).toBeNull()
    await db.threshold.deleteMany()
  })

  it('列表先筛选排序再截断：跨工单按需求日、只看未齐套、可见范围、我负责的；看板、每日汇总的"未齐套节点"', async () => {
    await db.assemblyNode.deleteMany()
    const lOpen = await line('未到料')
    const lArrived = await line('已到料', { arrivedDate: dayOff(-1) })
    const late = await node({ name: '已过未齐', needDate: dayOff(-2), purchaseIds: [lOpen.id] })
    const soon = await node({ name: '快到未齐', needDate: dayOff(3), purchaseIds: [lOpen.id], ownerId: 'u-owner' })
    const far = await node({ name: '远期未齐', needDate: dayOff(30), purchaseIds: [lOpen.id] })
    const done = await node({ name: '已齐', needDate: dayOff(1), purchaseIds: [lArrived.id] })
    const otherWo = await node({ workOrderNumber: OTHER_WO, name: '别的工单未齐', needDate: dayOff(2), partIds: [(await makePart(OTHER_WO)).id] })

    // 跨工单：按需求日从近到远
    const all = await s.kit.listNodes({}, ADMIN, W8)
    expect(all.rows.map((r) => r.name)).toEqual(['已过未齐', '已齐', '别的工单未齐', '快到未齐', '远期未齐'])
    expect(all.stats).toEqual({ all: 5, incomplete: 4, dueSoon: 3, windowDays: 5, yellowDays: 5, redDays: 1 })
    expect(all.rows.find((r) => r.id === late.id)).toMatchObject({ daysLeft: -2 })
    const incomplete = await s.kit.listNodes({ incompleteOnly: true }, ADMIN, W8)
    expect(incomplete.rows.map((r) => r.id)).toEqual([late.id, otherWo.id, soon.id, far.id])
    expect(incomplete.total).toBe(4)
    // 可见范围（项目经理只看自己的工单）
    const scoped = await s.kit.listNodes({ incompleteOnly: true, visibleWorkOrders: [WO] }, PM, W8)
    expect(scoped.rows.map((r) => r.id)).toEqual([late.id, soon.id, far.id])
    expect(scoped.rows.every((r) => r.canEdit)).toBe(true)
    // 我负责的：负责人是我；没指定负责人的归生产经理
    const owner = await s.kit.listNodes({ mine: { userId: 'u-owner', isProductionHead: false } }, { userId: 'u-owner', isAdmin: false }, W8)
    expect(owner.rows.map((r) => r.id)).toEqual([soon.id])
    expect(owner.rows[0]!.canEdit).toBe(false)
    const head = await s.kit.listNodes({ mine: { userId: 'u-prodhead', isProductionHead: true } }, PROD, W8)
    expect(head.rows.map((r) => r.id)).toEqual([late.id, done.id, otherWo.id, far.id])
    // 管理员同时是生产经理：仍按生产经理身份带上没指定负责人的节点
    const role = await db.notifyRole.create({ data: { role: 'DEPT_HEAD', userId: 'u-admin', department: '生产部' } })
    const adminCtx = await s.kit.editorContext(ADMIN)
    expect(adminCtx).toMatchObject({ isAdmin: true, isProductionHead: true })
    await db.notifyRole.delete({ where: { id: role.id } })
    expect((await s.kit.editorContext(ADMIN)).isProductionHead).toBe(false)

    // 看板：已进入预警窗口（需求日前 5 天内，含已过）的未齐套节点；远期、已齐的不算
    const board = await s.board.getBoard(undefined)
    expect(board.rows.find((r) => r.workOrderNumber === WO)?.incompleteNodes).toBe(2)
    expect(board.rows.find((r) => r.workOrderNumber === OTHER_WO)?.incompleteNodes).toBe(1)
    const pmBoard = await s.board.getBoard([WO])
    expect(pmBoard.rows.map((r) => r.workOrderNumber)).toEqual([WO])

    // 每日汇总：按可见范围计数（项目经理只算自己的工单，领导算全部）
    await db.reminder.deleteMany({ where: { kind: 'DIGEST' } })
    await s.digest.generateDailyDigest({ force: true })
    const digestOf = async (userId: string) => (await db.reminder.findFirstOrThrow({ where: { kind: 'DIGEST', userId } })).title
    expect(await digestOf('u-pm')).toContain('未齐套节点 2 个')
    expect(await digestOf('u-lead')).toContain('未齐套节点 3 个')
  })

  it('演示数据：3 个装配节点——齐套、临近需求日缺件（W8 黄）、远期缺件；日期按上海日历现算；清除时一并删掉', async () => {
    await db.assemblyNode.deleteMany()
    await db.alert.deleteMany()
    await s.demo.seedDemo()
    const list = await s.kit.listNodes({ workOrderNumber: 'DEMO-WO-001' }, ADMIN, W8)
    expect(list.rows.map((r) => [r.name, r.percent, r.daysLeft])).toEqual([
      ['回转机构部装', 100, 10],
      ['主梁总装', 0, 3],
      ['支腿部装', 0, 20],
    ])
    const main = list.rows[1]!
    expect(main.shortages.find((x) => x.kind === 'part')).toMatchObject({ reason: '图纸未完成' })
    expect(list.rows[2]!.shortages.find((x) => x.kind === 'part')).toMatchObject({ reason: '在制', stage: '下料' })
    const w8 = await s.scan.collectTargets(new Date(), await s.scan.loadThresholds(), [], 'W8')
    expect(w8.map((x) => [x.refId, x.level])).toEqual([['DEMO-NODE-002', 'YELLOW']])
    // 重复写入不重复插入
    await s.demo.seedDemo()
    expect(await db.assemblyNode.count({ where: { workOrderNumber: 'DEMO-WO-001' } })).toBe(3)
    const reset = await s.demo.resetDemo()
    expect(reset.assemblyNodes).toBe(3)
    expect(await db.part.count({ where: { id: { startsWith: 'DEMO-' } } })).toBe(0)
  })
})
