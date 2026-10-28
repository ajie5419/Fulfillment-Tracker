/**
 * 发放签收 + 设计变更通知（R9）：真实 MySQL 上直接调用服务层，用 now 注入"快进时钟"。
 * 覆盖：新建（按人 + 按部门/角色）、签收/拒收与权限、W5 升级（签收 + 变更影响确认）、确认变更影响待办、"等变更"让 W2/W3 不计时、自动解除、作废。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL
const HOUR = 3_600_000
const DAY = 86_400_000

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  todos: typeof import('../../server/services/flow/todos')
  scan: typeof import('../../server/services/alerts/scan')
  rules: typeof import('../../server/services/alerts/rules')
  rel: typeof import('../../server/services/releases/releases')
  errors: typeof import('../../server/services/flow/errors')
}

describe.skipIf(!DB)('发放签收与设计变更（R9）', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-R9'
  const OTHER_WO = 'T-WO-R9-B'
  const issuer = { userId: 'u-tech', isAdmin: false }

  async function clean() {
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.uploadFile.deleteMany()
    await db.release.deleteMany() // 签收记录级联删除
    await db.issue.deleteMany()
    await db.notifyRole.deleteMany()
    await db.workOrderExt.deleteMany()
    await db.offDay.deleteMany()
    await db.threshold.deleteMany()
    await db.flowEvent.deleteMany()
    await db.todo.deleteMany()
    await db.unmatchedInspection.deleteMany()
    await db.routeStep.deleteMany()
    await db.part.deleteMany()
    await db.qmsInspection.deleteMany()
    await db.qmsWorkOrder.deleteMany()
    await db.qmsSupplier.deleteMany()
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
      todos: await import('../../server/services/flow/todos'),
      scan: await import('../../server/services/alerts/scan'),
      rules: await import('../../server/services/alerts/rules'),
      rel: await import('../../server/services/releases/releases'),
      errors: await import('../../server/services/flow/errors'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await clean()

    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [WO, OTHER_WO].map((wo) => ({ workOrderNumber: wo, customerName: '测试客户', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
    })
    await db.qmsSupplier.create({ data: { id: 'S-1', name: '外协厂', updatedAt: now } })
    await db.qmsProcess.createMany({
      data: [
        { id: 'P-WELD', name: '组焊', updatedAt: now },
        { id: 'P-PAINT', name: '涂装', updatedAt: now },
      ],
    })
    const DEPTS = ['生产部', '技术部', '项目部', '公司领导']
    await db.qmsDepartment.createMany({ data: DEPTS.map((name, i) => ({ id: `RD-${i}`, name, parentId: '0', status: 1, updatedAt: now })) })
    const user = (id: string, realName: string, dept: string, status = 'ACTIVE') => ({ id, username: id, realName, departmentId: `RD-${DEPTS.indexOf(dept)}`, status, updatedAt: now })
    await db.qmsUser.createMany({
      data: [
        user('u-tech', '设计员', '技术部'),
        user('u-out', '外协专员', '生产部'),
        user('u-head', '生产经理', '生产部'),
        user('u-worker', '车间工人', '生产部'),
        user('u-left', '离职工人', '生产部', 'INACTIVE'),
        user('u-pm', '项目经理', '项目部'),
        user('u-pdh', '项目部负责人', '项目部'),
        user('u-lead', '分管领导', '公司领导'),
      ],
    })
    await db.notifyRole.createMany({
      data: [
        { role: 'OUTSOURCE_COORDINATOR', userId: 'u-out' },
        { role: 'DEPT_HEAD', userId: 'u-head', department: '生产部' },
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

  let seq = 0
  /** 组焊（厂外）→ 涂装（厂外），负责人外协专员 */
  async function makePart(wo = WO) {
    seq++
    const part = await s.steps.createPart(wo, { name: `支腿-${seq}`, quantity: 1 })
    const weld = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-1' }, 'u-out')
    const paint = await s.steps.addStep(part.id, { processId: 'P-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-1' }, 'u-out')
    return { part, weld, paint }
  }
  const today = () => new Date(`${s.rules.shanghaiDay(new Date())}T00:00:00.000Z`)
  const send = (stepId: string, promisedReturnDate: Date) => s.flow.sendStep({ stepId, promisedReturnDate, actorId: 'u-out', source: 'PC' })
  const receiptOf = (releaseId: string, userId: string) => db.releaseReceipt.findFirstOrThrow({ where: { releaseId, userId } })
  const targets = async (rule: 'W2' | 'W3' | 'W5', now = new Date()) => {
    const [t, off] = await Promise.all([s.scan.loadThresholds(), s.scan.loadOffDays()])
    return s.scan.collectTargets(now, t, off, rule)
  }

  it('新建：按人 + 按部门展开（不含发放人、跳过离职），每人一条签收记录和签收待办', async () => {
    const r = await s.rel.createRelease(
      { type: 'DRAWING', workOrderNumber: WO, version: 'A', description: '主梁图纸', userIds: ['u-pm'], groups: [{ department: '生产部' }] },
      'u-tech',
    )
    expect(r.releaseNo).toMatch(/^FF-\d{6}-\d{3}$/)
    const receipts = await db.releaseReceipt.findMany({ where: { releaseId: r.id } })
    expect(receipts.map((x) => x.userId).sort()).toEqual(['u-head', 'u-out', 'u-pm', 'u-worker'])
    expect(receipts.every((x) => x.status === 'PENDING')).toBe(true)
    const todos = await db.todo.findMany({ where: { action: 'SIGN_RELEASE', refType: 'receipt', refId: { in: receipts.map((x) => x.id) }, status: 'OPEN' } })
    expect(todos).toHaveLength(4)
    const mine = await s.todos.listMyTodos('u-worker')
    expect(mine.find((t) => t.action === 'SIGN_RELEASE')).toMatchObject({ title: expect.stringContaining(`签收：图纸 ${r.releaseNo}（A）`), release: { id: r.id } })
    // 第二张同一天：序号 +1
    const r2 = await s.rel.createRelease({ type: 'PROCESS', workOrderNumber: WO, description: '焊接工艺', userIds: ['u-worker'] }, 'u-tech')
    expect(Number(r2.releaseNo.slice(-3))).toBe(Number(r.releaseNo.slice(-3)) + 1)

    // 只有发放人自己的部门 → 报错；接收人离职 → 报错；工件不属于工单 → 报错；没有接收人 → 报错
    await expect(s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: 'x', groups: [{ department: '技术部' }] }, 'u-tech')).rejects.toThrow('没有找到接收人')
    await expect(s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: 'x', userIds: ['u-left'] }, 'u-tech')).rejects.toThrow('不存在或已停用')
    const other = await makePart(OTHER_WO)
    await expect(s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: 'x', partIds: [other.part.id], userIds: ['u-pm'] }, 'u-tech')).rejects.toThrow('不属于该工单')
    await expect(s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: 'x' }, 'u-tech')).rejects.toThrow('请选择接收人')
    // 附件只能用自己上传、没绑定过的
    await db.uploadFile.create({ data: { id: 'a'.repeat(32), storedName: 'x.pdf', mime: 'application/pdf', size: 1, uploaderId: 'u-pm' } })
    await expect(s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: 'x', userIds: ['u-pm'], attachmentIds: ['a'.repeat(32)] }, 'u-tech')).rejects.toThrow('附件无效')
    expect(await db.release.count({ where: { description: 'x' } })).toBe(0) // 失败的整单回滚
  })

  it('签收 / 拒收：只能处理发给自己的；拒收要写原因并通知发放人；签收待办不能转交', async () => {
    const r = await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: WO, description: '签收测试', userIds: ['u-worker', 'u-head'] }, 'u-tech')
    const w = await receiptOf(r.id, 'u-worker')
    const h = await receiptOf(r.id, 'u-head')
    await expect(s.rel.signReceipt(w.id, 'u-head')).rejects.toBeInstanceOf(s.errors.FlowForbidden)
    const todo = await db.todo.findFirstOrThrow({ where: { refType: 'receipt', refId: w.id } })
    await expect(s.todos.transferTodo(todo.id, 'u-pm', { userId: 'u-worker', isAdmin: false })).rejects.toThrow('签收待办不能转交')

    await s.rel.signReceipt(w.id, 'u-worker')
    expect(await db.releaseReceipt.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ status: 'SIGNED', actedAt: expect.any(Date) })
    expect((await db.todo.findUniqueOrThrow({ where: { id: todo.id } })).status).toBe('DONE')
    await expect(s.rel.signReceipt(w.id, 'u-worker')).rejects.toThrow('请刷新')

    expect(() => s.rel.rejectReceipt(h.id, 'u-head', '  ')).toThrow('请填写拒收原因')
    await s.rel.rejectReceipt(h.id, 'u-head', '版本不对，现场是 A 版')
    expect(await db.releaseReceipt.findUniqueOrThrow({ where: { id: h.id } })).toMatchObject({ status: 'REJECTED', reason: '版本不对，现场是 A 版' })
    const note = await db.reminder.findFirstOrThrow({ where: { userId: 'u-tech', kind: 'RELEASE' } })
    expect(note).toMatchObject({ level: 'YELLOW', link: `/releases?id=${r.id}` })
    expect(note.title).toContain('生产经理 拒收了图纸')

    const detail = await s.rel.getRelease(r.id, issuer)
    expect(detail).toMatchObject({ progressText: '有拒收', counts: { SIGNED: 1, REJECTED: 1, PENDING: 0 }, permissions: { sign: false, void: true } })
    expect(detail.receipts.find((x) => x.userId === 'u-head')).toMatchObject({ department: '生产部', statusText: '已拒收' })
  })

  it('W5：未签收提醒 → 黄（接收人部门负责人、项目经理、发放人）→ 红（项目部负责人、分管领导），不转异常；签收后消除', async () => {
    const r = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, description: 'W5 测试', userIds: ['u-worker'] }, 'u-tech')
    const rc = await receiptOf(r.id, 'u-worker')
    const key = s.rules.alertKey('W5', 'receipt', rc.id)
    const recipients = async () => {
      const a = await db.alert.findFirstOrThrow({ where: { refId: rc.id } })
      return { a, users: (await db.reminder.findMany({ where: { alertId: a.id } })).map((x) => `${x.level}:${x.userId}`).sort() }
    }
    const t0 = rc.createdAt
    await s.scan.scanRules(new Date(+t0 + 3 * HOUR))
    expect(await db.alert.findFirst({ where: { activeKey: key } })).toBeNull()
    await s.scan.scanRules(new Date(+t0 + 5 * HOUR))
    expect((await recipients()).users).toEqual(['REMIND:u-worker'])
    await s.scan.scanRules(new Date(+t0 + DAY + HOUR))
    expect((await recipients()).users).toEqual(['REMIND:u-worker', 'YELLOW:u-head', 'YELLOW:u-pm', 'YELLOW:u-tech', 'YELLOW:u-worker'])
    await s.scan.scanRules(new Date(+t0 + 2 * DAY + HOUR))
    const red = await recipients()
    expect(red.a).toMatchObject({ level: 'RED', status: 'ACTIVE' }) // W5 不转异常
    expect(red.users.filter((u) => u.startsWith('RED:'))).toEqual(['RED:u-head', 'RED:u-lead', 'RED:u-pdh', 'RED:u-pm', 'RED:u-tech', 'RED:u-worker'])
    expect(await db.issue.count({ where: { workOrderNumber: WO } })).toBe(0)

    // 我的提醒里 W5 跳到发放单
    const { listReminders } = await import('../../server/services/alerts/reminders')
    const item = (await listReminders('u-worker')).items.find((i) => i.alertId === red.a.id)
    expect(item).toMatchObject({ rule: 'W5', link: `/releases?id=${r.id}`, mobileLink: `/m/release?id=${r.id}` })

    await s.rel.signReceipt(rc.id, 'u-worker')
    expect(await db.alert.findUniqueOrThrow({ where: { id: red.a.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
  })

  it('设计变更：在外工序 → 生产经理 + 外协专员"确认变更影响"；未开工 → 等变更，W2/W3 不计时；确认后恢复', async () => {
    // P1：组焊在外（承诺日已过 → W3）；涂装待开工
    const p1 = await makePart()
    await send(p1.weld.id, new Date(+today() - 5 * DAY))
    // P2：组焊已返厂 → 涂装有"安排发出"待办（W2）
    const p2 = await makePart()
    await send(p2.weld.id, new Date(+today() + 5 * DAY))
    await s.flow.manualReturn({ stepId: p2.weld.id, qty: 1, actorId: 'u-out', source: 'PC' })
    await s.scan.scanRules(new Date(Date.now() + 3 * DAY))
    const w2Key = s.rules.alertKey('W2', 'step', p2.paint.id)
    expect(await db.alert.findFirst({ where: { activeKey: w2Key, status: 'ACTIVE' } })).not.toBeNull()

    const r = await s.rel.createRelease(
      { type: 'CHANGE', workOrderNumber: WO, partIds: [p1.part.id, p2.part.id], version: 'B', description: '孔位变更', userIds: ['u-worker'] },
      'u-tech',
    )
    expect(r.impact).toMatchObject({ started: 1, held: 2 })
    expect(r.impact.confirmers.sort()).toEqual(['u-head', 'u-out'])
    const confirmTodos = await db.todo.findMany({ where: { action: 'CONFIRM_CHANGE', refType: 'release', refId: r.id, status: 'OPEN' } })
    expect(confirmTodos.map((t) => t.ownerId).sort()).toEqual(['u-head', 'u-out'])
    expect((await s.todos.listMyTodos('u-head')).find((t) => t.action === 'CONFIRM_CHANGE')).toMatchObject({ title: expect.stringContaining('确认变更影响：设计变更') })
    const held = await db.routeStep.findMany({ where: { holdReleaseId: r.id } })
    expect(held.map((x) => x.id).sort()).toEqual([p1.paint.id, p2.paint.id].sort())
    // 等变更的步骤：W2 预警立即消除，W2 不再计时
    expect(await db.alert.findFirst({ where: { activeKey: w2Key } })).toBeNull()
    expect((await targets('W2', new Date(Date.now() + 10 * DAY))).some((t) => t.refId === p2.paint.id)).toBe(false)
    // 等变更期间涂装被发出且已逾期：W3 跳过它；在外的组焊（没标等变更）照常 W3
    await send(p1.paint.id, new Date(+today() - 5 * DAY))
    const w3 = await targets('W3')
    expect(w3.some((t) => t.refId === p1.paint.id)).toBe(false)
    expect(w3.find((t) => t.refId === p1.weld.id)?.level).toBe('RED')

    // 详情：需要确认；工人不能确认，外协专员可以，一人确认即关掉两条待办
    const detail = await s.rel.getRelease(r.id, { userId: 'u-out', isAdmin: false })
    expect(detail.change).toMatchObject({ needsConfirm: true, heldSteps: 2 })
    expect(detail.permissions.confirmChange).toBe(true)
    expect((await s.rel.getRelease(r.id, { userId: 'u-worker', isAdmin: false })).permissions.confirmChange).toBe(false)
    await expect(s.rel.confirmChange(r.id, { userId: 'u-worker', isAdmin: false }, null)).rejects.toBeInstanceOf(s.errors.FlowForbidden)
    await s.rel.confirmChange(r.id, { userId: 'u-out', isAdmin: false }, '已通知外协厂按新图扩孔')
    expect(await db.todo.count({ where: { action: 'CONFIRM_CHANGE', refId: r.id, status: 'OPEN' } })).toBe(0)
    expect(await db.release.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ changeConfirmedBy: 'u-out', changeConfirmNote: '已通知外协厂按新图扩孔' })
    await expect(s.rel.confirmChange(r.id, issuer, null)).rejects.toThrow('已经确认过了')

    // 解除后：W3 恢复；W2 从解除时刻重新计时
    expect((await targets('W3')).some((t) => t.refId === p1.paint.id)).toBe(true)
    const p2paint = await db.routeStep.findUniqueOrThrow({ where: { id: p2.paint.id } })
    expect(p2paint.holdReleaseId).toBeNull()
    const w2 = (await targets('W2')).find((t) => t.refId === p2.paint.id)
    expect(w2?.startAt).toEqual(p2paint.holdClearedAt)
  })

  it('W5 变更影响未确认：确认待办按 W5 升级（黄色起通知发放人），确认后预警和等变更一起解除；有人拒收时由发放人负责', async () => {
    const p = await makePart()
    await send(p.weld.id, new Date(+today() + 10 * DAY)) // 在外 → 确认待办；涂装等变更
    const r = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, partIds: [p.part.id], version: 'C', description: '确认超时', userIds: ['u-worker'] }, 'u-tech')
    await s.rel.signReceipt((await receiptOf(r.id, 'u-worker')).id, 'u-worker') // 签收了，只剩确认
    const key = s.rules.alertKey('W5', 'release', r.id)
    const t0 = (await db.todo.findFirstOrThrow({ where: { action: 'CONFIRM_CHANGE', refId: r.id }, orderBy: { createdAt: 'asc' } })).createdAt
    const recipients = async () => {
      const a = await db.alert.findFirstOrThrow({ where: { refType: 'release', refId: r.id } })
      return { a, users: (await db.reminder.findMany({ where: { alertId: a.id } })).map((x) => `${x.level}:${x.userId}`).sort() }
    }
    await s.scan.scanRules(new Date(+t0 + 3 * HOUR))
    expect(await db.alert.findFirst({ where: { activeKey: key } })).toBeNull()
    await s.scan.scanRules(new Date(+t0 + 5 * HOUR))
    expect((await recipients()).users).toEqual(['REMIND:u-head', 'REMIND:u-out'])
    await s.scan.scanRules(new Date(+t0 + DAY + HOUR))
    const yellow = await recipients()
    expect(yellow.a).toMatchObject({ rule: 'W5', level: 'YELLOW', status: 'ACTIVE' })
    const title = (await db.reminder.findFirstOrThrow({ where: { alertId: yellow.a.id, userId: 'u-tech' } })).title
    expect(title).toContain(`设计变更 ${r.releaseNo}（C）`)
    expect(title).toContain('变更影响仍未确认（待 ')
    expect(yellow.users.filter((u) => u.startsWith('YELLOW:'))).toEqual(['YELLOW:u-head', 'YELLOW:u-out', 'YELLOW:u-pm', 'YELLOW:u-tech'])
    await s.scan.scanRules(new Date(+t0 + 2 * DAY + HOUR))
    const red = await recipients()
    expect(red.a).toMatchObject({ level: 'RED', status: 'ACTIVE' })
    expect(red.users.filter((u) => u.startsWith('RED:'))).toEqual(['RED:u-head', 'RED:u-lead', 'RED:u-out', 'RED:u-pdh', 'RED:u-pm', 'RED:u-tech'])
    expect(await db.issue.count({ where: { sourceKey: `ALERT:${red.a.id}` } })).toBe(0) // W5 不转异常（前面用例的 W3 可能已转）
    const { listReminders } = await import('../../server/services/alerts/reminders')
    expect((await listReminders('u-tech')).items.find((i) => i.alertId === red.a.id)).toMatchObject({ link: `/releases?id=${r.id}`, mobileLink: `/m/release?id=${r.id}` })

    // 确认：预警立即解除（不用等下一轮扫描），等变更解除
    await s.rel.confirmChange(r.id, { userId: 'u-head', isAdmin: false }, null)
    expect(await db.alert.findUniqueOrThrow({ where: { id: red.a.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
    expect(await db.routeStep.count({ where: { holdReleaseId: r.id } })).toBe(0)
    expect((await targets('W5', new Date(+t0 + 5 * DAY))).some((t) => t.refType === 'release' && t.refId === r.id)).toBe(false)

    // 没有在加工的工序（无确认待办）、接收人拒收：自动解除走不通 → 由发放人负责，确认后消失
    const q = await makePart()
    const r2 = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, partIds: [q.part.id], description: '拒收后挂着', userIds: ['u-worker'] }, 'u-tech')
    const pendingTarget = (await targets('W5')).find((t) => t.refType === 'release' && t.refId === r2.id)
    expect(pendingTarget).toBeUndefined() // 还有人待签收：由签收预警负责
    await s.rel.rejectReceipt((await receiptOf(r2.id, 'u-worker')).id, 'u-worker', '不是我的')
    expect((await targets('W5')).find((t) => t.refType === 'release' && t.refId === r2.id)).toMatchObject({ ownerIds: ['u-tech'], watcherIds: ['u-tech'] })
    await s.rel.confirmChange(r2.id, issuer, '已改发给正确的人')
    expect((await targets('W5')).some((t) => t.refType === 'release' && t.refId === r2.id)).toBe(false)
  })

  it('设计变更没有在加工的工序：不发确认待办，接收人全部签收后自动解除等变更', async () => {
    const p = await makePart()
    const r = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, partIds: [p.part.id], description: '未开工的变更', userIds: ['u-worker', 'u-head'] }, 'u-tech')
    expect(r.impact).toMatchObject({ started: 0, held: 2, confirmers: [] })
    expect(await db.todo.count({ where: { action: 'CONFIRM_CHANGE', refId: r.id } })).toBe(0)
    await s.rel.signReceipt((await receiptOf(r.id, 'u-worker')).id, 'u-worker')
    expect(await db.routeStep.count({ where: { holdReleaseId: r.id } })).toBe(2) // 还有人没签
    const last = await s.rel.signReceipt((await receiptOf(r.id, 'u-head')).id, 'u-head')
    expect(last.holdsCleared).toBe(2)
    expect((await db.release.findUniqueOrThrow({ where: { id: r.id } })).changeConfirmedAt).not.toBeNull()
  })

  it('作废：只有发放人或管理员；未签收的签收记录和待办作废，等变更解除，之后不能再签', async () => {
    const p = await makePart()
    await send(p.weld.id, new Date(+today() + 3 * DAY)) // 在外 → 有确认待办；涂装等变更
    const r = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, partIds: [p.part.id], description: '作废测试', userIds: ['u-worker', 'u-pm'] }, 'u-tech')
    await s.rel.signReceipt((await receiptOf(r.id, 'u-pm')).id, 'u-pm')
    await expect(s.rel.voidRelease(r.id, { userId: 'u-worker', isAdmin: false })).rejects.toBeInstanceOf(s.errors.FlowForbidden)
    expect(await s.rel.voidRelease(r.id, issuer)).toMatchObject({ cancelled: 1, holdsCleared: 1 })
    expect((await db.releaseReceipt.findMany({ where: { releaseId: r.id } })).map((x) => `${x.userId}:${x.status}`).sort()).toEqual(['u-pm:SIGNED', 'u-worker:CANCELLED'])
    expect(await db.todo.count({ where: { OR: [{ refType: 'release', refId: r.id }, { refType: 'receipt', refId: (await receiptOf(r.id, 'u-worker')).id }], status: 'OPEN' } })).toBe(0)
    await expect(s.rel.signReceipt((await receiptOf(r.id, 'u-worker')).id, 'u-worker')).rejects.toThrow('已作废')
    await expect(s.rel.voidRelease(r.id, { userId: 'u-admin', isAdmin: true })).rejects.toThrow('已经作废')
    expect((await targets('W5')).some((t) => t.meta?.releaseId === r.id)).toBe(false)

    // 新变更覆盖了旧变更的"等变更"；作废新的 → 还给仍有效、未确认的旧变更（W2/W3 不恢复计时）
    const q = await makePart()
    const older = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, partIds: [q.part.id], description: '旧变更', userIds: ['u-worker', 'u-pm'] }, 'u-tech')
    const newer = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, partIds: [q.part.id], description: '新变更', userIds: ['u-worker'] }, 'u-tech')
    expect(await db.routeStep.count({ where: { partId: q.part.id, holdReleaseId: newer.id } })).toBe(2)
    expect(await s.rel.voidRelease(newer.id, issuer)).toMatchObject({ holdsCleared: 2 })
    expect(await db.routeStep.count({ where: { partId: q.part.id, holdReleaseId: older.id } })).toBe(2)
    // 旧的已确认 / 已作废时不还
    const newer2 = await s.rel.createRelease({ type: 'CHANGE', workOrderNumber: WO, partIds: [q.part.id], description: '新变更 2', userIds: ['u-worker'] }, 'u-tech')
    await s.rel.voidRelease(older.id, issuer)
    await s.rel.voidRelease(newer2.id, issuer)
    expect(await db.routeStep.count({ where: { partId: q.part.id, holdReleaseId: { not: null } } })).toBe(0)
  })

  it('列表：我发出的 / 发给我的 / 有人未签收；项目经理只看自己工单，但发给他的照样能看', async () => {
    const r = await s.rel.createRelease({ type: 'DRAWING', workOrderNumber: OTHER_WO, description: '别的工单', userIds: ['u-pm'] }, 'u-tech')
    const visible = [WO] // u-pm 只负责 WO
    const pmList = await s.rel.listReleases({ visibleWorkOrders: visible }, 'u-pm')
    expect(pmList.find((x) => x.id === r.id)).toMatchObject({ myStatus: 'PENDING', progressText: '签收中' })
    const workerList = await s.rel.listReleases({ visibleWorkOrders: visible }, 'u-worker')
    expect(workerList.some((x) => x.id === r.id)).toBe(false)
    expect((await s.rel.listReleases({ mine: 'issued' }, 'u-tech')).every((x) => x.issuerId === 'u-tech')).toBe(true)
    expect((await s.rel.listReleases({ progress: 'PENDING' }, 'u-tech')).every((x) => x.counts.PENDING > 0)).toBe(true)
    await expect(s.rel.assertCanViewRelease(r.id, 'u-worker', (wo) => visible.includes(wo))).rejects.toBeInstanceOf(s.errors.FlowForbidden)
    await expect(s.rel.assertCanViewRelease(r.id, 'u-pm', (wo) => visible.includes(wo))).resolves.toBeUndefined()
    // 发放人：工单后来改派、自己看不到该工单了，照样能看自己发的（列表、详情）
    await expect(s.rel.assertCanViewRelease(r.id, 'u-tech', (wo) => visible.includes(wo))).resolves.toBeUndefined()
    expect((await s.rel.listReleases({ visibleWorkOrders: visible }, 'u-tech')).some((x) => x.id === r.id)).toBe(true)
    expect((await s.rel.listMyReceipts('u-pm', 'pending')).some((x) => x.releaseId === r.id)).toBe(true)
  })
})
