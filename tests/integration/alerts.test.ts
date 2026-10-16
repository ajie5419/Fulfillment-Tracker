/**
 * 预警与提醒（R4）：真实 MySQL 上直接调用服务层，用 now 注入"快进时钟"。
 * 覆盖验收 A4（Q12 重演）、A5（漏报兜底）、A6（匹配失败 4 小时提醒）、停工日不计时、只升不降。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DB = process.env.TEST_DATABASE_URL
const HOUR = 3_600_000
const DAY = 86_400_000

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  match: typeof import('../../server/services/flow/match')
  scan: typeof import('../../server/services/alerts/scan')
  rules: typeof import('../../server/services/alerts/rules')
  reminders: typeof import('../../server/services/alerts/reminders')
}

describe.skipIf(!DB)('预警与提醒', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-A'
  const at = (base: Date, ms: number) => new Date(+base + ms)

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      steps: await import('../../server/services/flow/steps'),
      flow: await import('../../server/services/flow/flow'),
      match: await import('../../server/services/flow/match'),
      scan: await import('../../server/services/alerts/scan'),
      rules: await import('../../server/services/alerts/rules'),
      reminders: await import('../../server/services/alerts/reminders'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.uploadFile.deleteMany()
    await db.issue.deleteMany() // 处理日志级联删除
    await db.notifyRole.deleteMany()
    await db.workOrderExt.deleteMany()
    await db.offDay.deleteMany()
    await db.threshold.deleteMany() // 表里没有时用默认值
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

    const now = new Date()
    await db.qmsWorkOrder.create({
      data: { workOrderNumber: WO, customerName: '测试客户', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now },
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
      ],
    })
    const user = (id: string, realName: string, department: string) => ({ id, username: id, realName, department, roleId: 'r', status: 'ACTIVE', updatedAt: now })
    await db.qmsUser.createMany({
      data: [
        user('u-out', '外协专员', '生产部'),
        user('u-head', '生产部负责人', '生产部'),
        user('u-pm', '项目经理', '项目部'),
        user('u-pdh', '项目部负责人', '项目部'),
        user('u-lead', '分管领导', '公司领导'),
        user('u-qa', '质量部负责人', '质量部'),
      ],
    })
    await db.notifyRole.createMany({
      data: [
        { role: 'OUTSOURCE_COORDINATOR', userId: 'u-out' },
        { role: 'DEPT_HEAD', userId: 'u-head', department: '生产部' },
        { role: 'DEPT_HEAD', userId: 'u-qa', department: '质量部' }, // 别的部门的负责人不该收到
        { role: 'PROJECT_DEPT_HEAD', userId: 'u-pdh' },
        { role: 'LEADER', userId: 'u-lead' },
      ],
    })
    await db.workOrderExt.create({ data: { workOrderNumber: WO, projectManagerId: 'u-pm' } })
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  let seqNo = 0
  /** 组焊（厂外）→ 涂装（厂外），负责人都是外协专员 */
  async function makePart() {
    seqNo++
    const part = await s.steps.createPart(WO, { name: `主梁-${seqNo}`, quantity: 1, qmsPartId: `BOM-A-${seqNo}` })
    const weld = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-WELD' }, 'u-out')
    const paint = await s.steps.addStep(part.id, { processId: 'P-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-PAINT' }, 'u-out')
    return { part, weld, paint }
  }
  const today = () => new Date(`${s.rules.shanghaiDay(new Date())}T00:00:00.000Z`)
  const send = (stepId: string, promisedReturnDate = new Date(+today() + 7 * DAY)) =>
    s.flow.sendStep({ stepId, promisedReturnDate, actorId: 'u-out', source: 'MOBILE' })
  /** 组焊发出并补登返厂 → 涂装生成"安排发出"待办，返回待办创建时间（W2 计时起点） */
  async function weldReturned() {
    const p = await makePart()
    await send(p.weld.id)
    await s.flow.manualReturn({ stepId: p.weld.id, qty: 1, actorId: 'u-out', source: 'MOBILE' })
    const todo = await db.todo.findFirstOrThrow({ where: { refType: 'step', refId: p.paint.id, status: 'OPEN' } })
    return { ...p, t0: todo.createdAt }
  }
  const alertOf = (key: string) => db.alert.findMany({ where: { OR: [{ activeKey: key }, { refId: key.split(':')[2] }] }, orderBy: { createdAt: 'asc' } })
  const remindersOf = async (alertId: string) =>
    (await db.reminder.findMany({ where: { alertId }, orderBy: [{ level: 'asc' }, { userId: 'asc' }] })).map((r) => `${r.level}:${r.userId}`)

  it('Q12 重演（A4）：第 3 天 W2 黄，第 5 天红并自动转异常；重复扫描不重复提醒；登记发出后释放', async () => {
    const { paint, t0 } = await weldReturned()
    const key = `W2:step:${paint.id}`

    // 第 2 天：还没到 2 天，不预警
    await s.scan.scanRules(at(t0, 2 * DAY - 1000))
    expect(await alertOf(key)).toHaveLength(0)

    // 第 3 天（满 2 天）：黄 → 外协专员 + 生产部负责人 + 项目经理
    const r1 = await s.scan.scanRules(at(t0, 2 * DAY))
    expect(r1.skipped).toBe(false)
    const [alert] = await alertOf(key)
    expect(alert).toMatchObject({ rule: 'W2', refType: 'step', level: 'YELLOW', status: 'ACTIVE', activeKey: key })
    expect(await remindersOf(alert!.id)).toEqual(['YELLOW:u-head', 'YELLOW:u-out', 'YELLOW:u-pm'])
    const title = (await db.reminder.findFirstOrThrow({ where: { alertId: alert!.id, userId: 'u-out' } })).title
    expect(title).toBe(`【黄】主梁-${seqNo} · 涂装：组焊返厂 2 天仍未发出（${WO}）`)

    // 重复扫描：不新增预警和提醒
    await s.scan.scanRules(at(t0, 2 * DAY))
    await s.scan.scanRules(at(t0, 3 * DAY))
    expect(await alertOf(key)).toHaveLength(1)
    expect(await remindersOf(alert!.id)).toHaveLength(3)

    // 只升不降：阈值调大后仍是黄
    await db.threshold.create({ data: { rule: 'W2', yellowDays: 10, redDays: 20 } })
    await s.scan.scanRules(at(t0, 3 * DAY))
    expect((await alertOf(key))[0]!.level).toBe('YELLOW')
    await db.threshold.deleteMany({ where: { rule: 'W2' } })

    // 第 5 天（满 4 天）：红 → 再加项目部负责人、分管领导
    await s.scan.scanRules(at(t0, 4 * DAY))
    await s.scan.scanRules(at(t0, 4 * DAY + HOUR))
    const [red] = await alertOf(key)
    // 红色自动转异常（R5）：预警改为已转异常，activeKey 保留
    expect(red).toMatchObject({ id: alert!.id, level: 'RED', status: 'CONVERTED', activeKey: key })
    const issue = await db.issue.findUniqueOrThrow({ where: { sourceKey: `ALERT:${alert!.id}` } })
    expect(issue).toMatchObject({ source: 'ALERT', category: 'OUTSOURCE_SCHEDULE', refType: 'STEP', refId: paint.id, responsibleUserId: 'u-out', status: 'OPEN' })
    expect(await remindersOf(alert!.id)).toEqual([
      'YELLOW:u-head', 'YELLOW:u-out', 'YELLOW:u-pm',
      'RED:u-head', 'RED:u-lead', 'RED:u-out', 'RED:u-pdh', 'RED:u-pm',
    ])
    expect((await db.reminder.findFirstOrThrow({ where: { alertId: alert!.id, userId: 'u-lead' } })).title).toMatch(/^【红】.*组焊返厂 4 天仍未发出/)
    expect(await db.reminder.count({ where: { userId: 'u-qa' } })).toBe(0)

    // 我的提醒：领导能看到，带跳转到工件页
    const mine = await s.reminders.listReminders('u-lead')
    // 已转异常：提醒跳到生成的异常
    expect(mine.items[0]).toMatchObject({ level: 'RED', rule: 'W2', cleared: false, issueNo: issue.issueNo, link: `/issues?id=${issue.id}` })
    expect(mine.unread).toBe(1)

    // 登记发出 → 已转异常的预警只释放 activeKey，状态不变；异常不随之关闭；再扫描也不会重新出现
    await send(paint.id)
    expect((await alertOf(key))[0]).toMatchObject({ status: 'CONVERTED', activeKey: null })
    await s.scan.scanRules(at(t0, 6 * DAY))
    expect((await db.alert.findMany({ where: { rule: 'W2', refId: paint.id } })).map((a) => a.status)).toEqual(['CONVERTED'])
    expect((await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).status).toBe('OPEN')
  })

  it('扫描兜底消除：对象离开待开工（未经 sendStep），下一轮扫描消除', async () => {
    const { paint, t0 } = await weldReturned()
    await s.scan.scanRules(at(t0, 2 * DAY))
    expect((await alertOf(`W2:step:${paint.id}`))[0]!.status).toBe('ACTIVE')
    await db.routeStep.update({ where: { id: paint.id }, data: { status: 'IN_PROGRESS' } })
    const r = await s.scan.scanRules(at(t0, 2 * DAY))
    expect(r.cleared).toBeGreaterThanOrEqual(1)
    expect((await db.alert.findFirstOrThrow({ where: { rule: 'W2', refId: paint.id } })).status).toBe('CLEARED')
  })

  it('W3 漏报兜底（A5）：超期 1 天黄，补登返厂后消除；要求完成日已过直接红', async () => {
    const { weld } = await makePart()
    await send(weld.id, today()) // 今天到期
    const key = `W3:step:${weld.id}`
    const now = new Date()

    await s.scan.scanRules(now)
    expect((await alertOf(key))[0]).toMatchObject({ level: 'REMIND' }) // 到期当天：提醒责任人
    expect(await remindersOf((await alertOf(key))[0]!.id)).toEqual(['REMIND:u-out'])

    await s.scan.scanRules(at(now, DAY))
    const [alert] = await alertOf(key)
    expect(alert).toMatchObject({ rule: 'W3', level: 'YELLOW', status: 'ACTIVE' })
    expect(await remindersOf(alert!.id)).toEqual(['REMIND:u-out', 'YELLOW:u-head', 'YELLOW:u-out', 'YELLOW:u-pm'])
    expect((await db.reminder.findFirstOrThrow({ where: { alertId: alert!.id, level: 'YELLOW', userId: 'u-out' } })).title).toMatch(/^【黄】.*组焊厂超承诺返回日 1 天未返/)

    // 预警列表能看到
    const list = await s.reminders.listAlerts({ rule: 'W3', workOrderNumber: WO })
    expect(list.find((a) => a.id === alert!.id)).toMatchObject({ level: 'YELLOW', owners: [{ id: 'u-out', name: '外协专员' }] })

    await s.flow.manualReturn({ stepId: weld.id, qty: 1, actorId: 'u-out', source: 'MOBILE' })
    expect((await alertOf(key))[0]).toMatchObject({ status: 'CLEARED', activeKey: null })
    expect(await db.flowEvent.count({ where: { stepId: weld.id, type: 'RETURN_MANUAL' } })).toBe(1) // 记一次漏报（补登）
    await s.scan.scanRules(at(now, 5 * DAY))
    expect(await db.alert.count({ where: { refId: weld.id, status: 'ACTIVE' } })).toBe(0)

    // 要求完成日已过：承诺日还早也直接红
    const other = await makePart()
    await s.steps.updateStep(other.weld.id, { dueDate: new Date(+today() - DAY) })
    await send(other.weld.id, new Date(+today() + 10 * DAY))
    await s.scan.scanRules(new Date())
    const [red] = await alertOf(`W3:step:${other.weld.id}`)
    expect(red).toMatchObject({ level: 'RED' })
    expect((await remindersOf(red!.id)).filter((x) => x.startsWith('RED'))).toEqual(['RED:u-head', 'RED:u-lead', 'RED:u-out', 'RED:u-pdh', 'RED:u-pm'])
  })

  it('W1 匹配失败（A6）：4 小时出提醒（外协专员），人工关联后消除', async () => {
    const { weld } = await makePart()
    await send(weld.id)
    const id = `T-INS-${randomBytes(4).toString('hex')}`
    await db.qmsInspection.create({
      data: {
        id, requestNo: id, workOrderNumber: WO, partName: '写错的名字', processName: '组焊', quantity: 1,
        status: 'SUBMITTED', inspectionResult: 'PASS', submittedAt: new Date(), updatedAt: new Date(),
      },
    })
    expect(await s.match.matchInspection(id)).toMatchObject({ status: 'unmatched' })
    const created = (await db.unmatchedInspection.findUniqueOrThrow({ where: { qmsInspectionId: id } })).createdAt
    const key = `W1:unmatched:${id}`

    await s.scan.scanRules(at(created, 4 * HOUR - 1000))
    expect(await db.alert.count({ where: { activeKey: key } })).toBe(0)
    await s.scan.scanRules(at(created, 4 * HOUR))
    const alert = await db.alert.findUniqueOrThrow({ where: { activeKey: key } })
    expect(alert).toMatchObject({ rule: 'W1', refType: 'unmatched', level: 'REMIND' })
    expect(await remindersOf(alert.id)).toEqual(['REMIND:u-out'])
    expect((await db.reminder.findFirstOrThrow({ where: { alertId: alert.id } })).title).toBe(`【提醒】待确认匹配 写错的名字 · 组焊：返厂报检 4 小时未确认关联（${WO}）`)
    expect((await s.reminders.listReminders('u-out')).items.find((i) => i.alertId === alert.id)).toMatchObject({ link: '/unmatched', mobileLink: null })

    await s.match.resolveUnmatched(id, weld.id, 'u-out')
    expect(await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
    await s.scan.scanRules(at(created, 2 * DAY))
    expect(await db.alert.count({ where: { refId: id, status: 'ACTIVE' } })).toBe(0)
  })

  it('停工日不计时', async () => {
    const { paint, t0 } = await weldReturned()
    const key = `W2:step:${paint.id}`
    const d1 = s.rules.shanghaiDay(at(t0, DAY))
    const d2 = s.rules.shanghaiDay(at(t0, 2 * DAY))
    await db.offDay.createMany({ data: [d1, d2].map((d) => ({ date: new Date(`${d}T00:00:00.000Z`) })) })
    try {
      await s.scan.scanRules(at(t0, 2 * DAY)) // 自然日满 2 天，扣掉停工日不到
      expect(await db.alert.count({ where: { activeKey: key } })).toBe(0)
      await s.scan.scanRules(at(t0, 4 * DAY)) // 自然日满 4 天，扣掉 2 个停工日 = 2 天 → 黄，不是红
      expect((await db.alert.findUniqueOrThrow({ where: { activeKey: key } })).level).toBe('YELLOW')
    } finally {
      await db.offDay.deleteMany()
    }
  })

  it('扫描加锁：租约被占用时直接跳过，租约过期后可再抢', async () => {
    await db.jobLock.upsert({
      where: { name: 'scan-rules' },
      create: { name: 'scan-rules', lockedUntil: new Date(Date.now() + 60_000), holder: 'other' },
      update: { lockedUntil: new Date(Date.now() + 60_000), holder: 'other' },
    })
    expect(await s.scan.scanRules()).toMatchObject({ skipped: true })
    // 模拟持锁进程崩溃：租约到期后自动可抢
    await db.jobLock.update({ where: { name: 'scan-rules' }, data: { lockedUntil: new Date(Date.now() - 1) } })
    expect((await s.scan.scanRules()).skipped).toBe(false)
    expect((await db.jobLock.findUniqueOrThrow({ where: { name: 'scan-rules' } })).holder).toBeNull()
  })

  it('W1、W3 的提醒阈值不能清空；新提醒超过 20 条时游标不越过未取到的', async () => {
    const settings = await import('../../server/services/alerts/settings')
    await expect(settings.saveThreshold('W1', { remindHours: null, yellowDays: 1, redDays: 3 })).rejects.toThrow('必须设置提醒阈值')
    await expect(settings.saveThreshold('W2', { remindHours: null, yellowDays: 2, redDays: 4 })).resolves.toBeTruthy()

    const base = Date.now() - 5_000
    await db.reminder.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({ userId: 'u-many', title: `t${i}`, level: 'YELLOW' as const, createdAt: new Date(base + i) })),
    })
    const r = await s.reminders.newReminders('u-many', new Date(base - 1))
    expect(r.items).toHaveLength(25) // 不截断，避免游标越过没取到的
    await db.reminder.deleteMany({ where: { userId: 'u-many' } })
  })

  it('提醒已读：单条、全部；新提醒轮询只返回未读黄红', async () => {
    const mine = await s.reminders.listReminders('u-pm')
    expect(mine.unread).toBeGreaterThan(0)
    const since = new Date(Date.now() - 10 * 60_000)
    const fresh = await s.reminders.newReminders('u-pm', since)
    expect(fresh.items.length).toBeGreaterThan(0)
    expect(fresh.items.every((i) => i.level !== 'REMIND' && !i.readAt)).toBe(true)

    await s.reminders.markRead('u-pm', mine.items[0]!.id)
    expect((await s.reminders.listReminders('u-pm')).unread).toBe(mine.unread - 1)
    await expect(s.reminders.markRead('u-out', mine.items[0]!.id)).rejects.toThrow('提醒不存在') // 别人的提醒
    await s.reminders.markAllRead('u-pm')
    expect((await s.reminders.listReminders('u-pm')).unread).toBe(0)
    expect((await s.reminders.newReminders('u-pm', since)).items).toEqual([])
  })
})
