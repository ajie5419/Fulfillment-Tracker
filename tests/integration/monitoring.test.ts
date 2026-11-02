/** W11：真实 fulfillment_test，含真实业务开工后旧停滞预警的扫描消除。 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
const WO = 'T-MON-ACTIVE'
const WOS = [WO, 'T-MON-DONE', 'T-MON-CANCELLED', 'T-MON-DELETED', 'T-MON-BOARD', 'T-MON-COUNT', 'T-MON-CAPSULES']
const now = new Date()
const old = new Date(+now - 20 * 86_400_000)

describe.skipIf(!DB)('状态监控与 W11 扫描（真实 MySQL）', () => {
  let db: PrismaClient
  let scan: typeof import('../../server/services/alerts/scan')
  let monitoring: typeof import('../../server/services/monitoring/status')
  let reminders: typeof import('../../server/services/alerts/reminders')
  let settings: typeof import('../../server/services/alerts/settings')
  let originalThreshold: { remindHours: number | null; yellowDays: number; redDays: number } | null
  let seq = 0

  async function cleanup() {
    const parts = await db.part.findMany({ where: { workOrderNumber: { in: WOS } }, select: { id: true, steps: { select: { id: true } } } })
    const refIds = parts.flatMap((p) => [p.id, ...p.steps.map((s) => s.id)])
    const alerts = await db.alert.findMany({ where: { refId: { in: refIds } }, select: { id: true } })
    await db.reminder.deleteMany({ where: { OR: [{ alertId: { in: alerts.map((a) => a.id) } }, { userId: 'T-MON-OWNER' }] } })
    await db.alert.deleteMany({ where: { id: { in: alerts.map((a) => a.id) } } })
    await db.todo.deleteMany({ where: { refId: { in: refIds } } })
    await db.flowEvent.deleteMany({ where: { stepId: { in: refIds } } })
    await db.purchaseLine.deleteMany({ where: { workOrderNumber: { in: WOS } } })
    await db.part.deleteMany({ where: { workOrderNumber: { in: WOS } } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { in: WOS } } })
    await db.qmsUser.deleteMany({ where: { id: 'T-MON-OWNER' } })
    await db.qmsProcess.deleteMany({ where: { id: 'T-MON-PROCESS' } })
    await db.qmsDepartment.deleteMany({ where: { id: 'T-MON-DEPT' } })
  }

  beforeAll(async () => {
    // 直接调用已安装的 CLI，避免 npx 的注册表检查占用数据库测试的启动超时。
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    scan = await import('../../server/services/alerts/scan')
    monitoring = await import('../../server/services/monitoring/status')
    reminders = await import('../../server/services/alerts/reminders')
    settings = await import('../../server/services/alerts/settings')
    await cleanup()
    originalThreshold = await db.threshold.findUnique({ where: { rule: 'W11' } })
    await settings.saveThreshold('W11', { remindHours: null, yellowDays: 7, redDays: 14 })
    await db.qmsWorkOrder.createMany({ data: WOS.map((workOrderNumber, i) => ({ workOrderNumber, customerName: '监控测试', quantity: 1, deliveryDate: new Date('2026-12-31'), status: i === 1 ? 'COMPLETED' : i === 2 ? 'CANCELLED' : 'IN_PROGRESS', isDeleted: i === 3, updatedAt: now })) })
    await db.qmsDepartment.create({ data: { id: 'T-MON-DEPT', name: '生产部', parentId: '0', status: 1, updatedAt: now } })
    await db.qmsUser.create({ data: { id: 'T-MON-OWNER', username: 'T-MON-OWNER', realName: '监控负责人', departmentId: 'T-MON-DEPT', status: 'ACTIVE', updatedAt: now } })
    await db.qmsProcess.create({ data: { id: 'T-MON-PROCESS', name: '监控组焊', supplierSource: 'Team', updatedAt: now } })
  })

  afterAll(async () => {
    if (!db) return
    await cleanup()
    if (originalThreshold) await db.threshold.upsert({ where: { rule: 'W11' }, create: { rule: 'W11', ...originalThreshold }, update: originalThreshold })
    else await db.threshold.deleteMany({ where: { rule: 'W11' } })
    await db.$disconnect()
  })

  async function makePart(wo = WO, since = old, ownerId: string | null = 'T-MON-OWNER') {
    const part = await db.part.create({ data: { workOrderNumber: wo, name: `监控件-${++seq}`, drawingNo: `MON-${seq}`, statusSince: since, createdAt: old } })
    const step = await db.routeStep.create({ data: { partId: part.id, seq: 1, processId: 'T-MON-PROCESS', mode: 'SELF', ownerId, createdAt: since } })
    await db.part.update({ where: { id: part.id }, data: { currentStepId: step.id } })
    return { part, step }
  }

  it('读取工件 statusSince、工序 max(occurredAt)，缺事件时依次回退，并排除终态及关闭 / 删除工单', async () => {
    const a = await makePart(WO, new Date(+now - 7 * 86_400_000))
    const startedAt = new Date(+now - 10 * 86_400_000)
    const eventAt = new Date(+now - 8 * 86_400_000)
    await db.routeStep.update({ where: { id: a.step.id }, data: { startedAt } })
    // createdAt 与 occurredAt 顺序相反，必须按业务发生时间取最近一条；部分 REPORT 也算。
    await db.flowEvent.createMany({ data: [
      { stepId: a.step.id, type: 'START', source: 'PC', qty: 0, occurredAt: old, createdAt: now },
      { stepId: a.step.id, type: 'REPORT', source: 'PC', qty: 1, occurredAt: eventAt, createdAt: old },
    ] })
    const b = await makePart()
    await db.routeStep.update({ where: { id: b.step.id }, data: { startedAt } })
    const c = await makePart(WO, old, null)
    for (const wo of WOS.slice(1, 4)) await makePart(wo)
    const done = await makePart()
    await db.part.update({ where: { id: done.part.id }, data: { status: 'DONE' } })
    await db.routeStep.create({ data: { partId: c.part.id, seq: 2, processId: 'T-MON-PROCESS', mode: 'SELF', status: 'DONE' } })
    const rows = await monitoring.loadMonitoredEntities(now, { remindHours: null, yellowDays: 7, redDays: 14 })
    expect(rows.find((r) => r.id === a.part.id)).toMatchObject({ days: 7, sinceSource: 'statusSince', level: 'YELLOW' })
    expect(rows.find((r) => r.id === a.step.id)).toMatchObject({ since: eventAt, days: 8, sinceSource: 'flowEvent', owners: [{ id: 'T-MON-OWNER', name: '监控负责人' }], deptNames: ['生产部'] })
    expect(rows.find((r) => r.id === b.step.id)).toMatchObject({ since: startedAt, sinceSource: 'startedAt' })
    expect(rows.find((r) => r.id === c.step.id)).toMatchObject({ since: old, sinceSource: 'createdAt', owners: [], deptNames: [] })
    expect(rows.some((r) => WOS.slice(1).includes(r.workOrderNumber))).toBe(false)
    expect(rows.some((r) => r.partId === done.part.id)).toBe(false)
    expect(rows.every((r) => r.status !== ('DONE' as string))).toBe(true)
    const summary = await monitoring.getStatusMonitoring(now)
    expect(summary.top.length).toBeLessThanOrEqual(10)
    expect(summary.top.every((r, i) => r.level !== 'GREEN' && (!i || summary.top[i - 1]!.days >= r.days))).toBe(true)
    const pending = await monitoring.listMonitoredEntities({ entityType: 'step', status: 'PENDING', page: 1, pageSize: 100 }, now)
    expect(pending.total).toBe(summary.steps.find((r) => r.status === 'PENDING')!.count)
    expect(pending.rows.every((r) => r.entityType === 'step' && r.status === 'PENDING')).toBe(true)
  })

  it('工序 / 工件停滞红线生成预警与提醒、重复扫描幂等，真实开工改变状态后下一轮自动消除', async () => {
    const { part, step } = await makePart()
    await scan.scanRules(now)
    const alerts = await db.alert.findMany({ where: { rule: 'W11', refId: { in: [part.id, step.id] }, activeKey: { not: null } } })
    expect(alerts).toHaveLength(2)
    expect(alerts.every((a) => a.level === 'RED' && a.status === 'ACTIVE')).toBe(true)
    const stepAlert = alerts.find((a) => a.refType === 'step')!
    const partAlert = alerts.find((a) => a.refType === 'part')!
    const reminder = await db.reminder.findFirstOrThrow({ where: { alertId: stepAlert.id, userId: 'T-MON-OWNER' } })
    expect(reminder.title).toContain('工序处于“待开工”已停 20 天')
    expect(reminder.title).toContain(WO)
    expect(reminder.title).toContain(part.name)
    await scan.scanRules(now)
    expect(await db.alert.count({ where: { rule: 'W11', refId: step.id } })).toBe(1)
    expect(await db.reminder.count({ where: { alertId: stepAlert.id, userId: 'T-MON-OWNER' } })).toBe(1)
    const list = await reminders.listAlerts({ rule: 'W11', workOrderNumber: WO }, now)
    expect(list.find((r) => r.id === stepAlert.id)).toMatchObject({ duration: null, canConvert: false, link: expect.stringContaining(`step=${step.id}`) })
    const mine = await reminders.listReminders('T-MON-OWNER', now)
    expect(mine.items.find((r) => r.alertId === partAlert.id)).toMatchObject({ rule: 'W11', workOrderNumber: WO, link: expect.stringContaining(`part=${part.id}`) })
    const { startStep } = await import('../../server/services/flow/flow')
    await startStep({ stepId: step.id, actorId: 'T-MON-OWNER', source: 'PC' })
    const after = new Date()
    expect((await db.part.findUniqueOrThrow({ where: { id: part.id } })).statusSince.getTime()).toBeGreaterThan(+old)
    await scan.scanRules(after)
    expect(await db.alert.findUniqueOrThrow({ where: { id: stepAlert.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
    expect(await db.alert.findUniqueOrThrow({ where: { id: partAlert.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
    expect((await reminders.listReminders('T-MON-OWNER', after)).items.find((r) => r.alertId === stepAlert.id)?.cleared).toBe(true)
    await scan.scanRules(after)
    expect(await db.alert.count({ where: { rule: 'W11', refId: step.id, status: 'ACTIVE' } })).toBe(0)
  })

  it('可调阈值：黄线不生成预警；回落红线以下消除；重新达红线创建新周期预警', async () => {
    const { step } = await makePart(WO, new Date(+now - 14 * 86_400_000))
    await settings.saveThreshold('W11', { remindHours: 1, yellowDays: 7, redDays: 15 })
    expect((await db.threshold.findUniqueOrThrow({ where: { rule: 'W11' } })).remindHours).toBeNull()
    await scan.scanRules(now)
    expect(await db.alert.count({ where: { rule: 'W11', refId: step.id } })).toBe(0)
    await settings.saveThreshold('W11', { remindHours: null, yellowDays: 7, redDays: 14 })
    await scan.scanRules(now)
    const first = await db.alert.findFirstOrThrow({ where: { rule: 'W11', refId: step.id, status: 'ACTIVE' } })
    await settings.saveThreshold('W11', { remindHours: null, yellowDays: 7, redDays: 15 })
    await scan.scanRules(now)
    expect(await db.alert.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
    await settings.saveThreshold('W11', { remindHours: null, yellowDays: 7, redDays: 14 })
    await scan.scanRules(now)
    expect(await db.alert.count({ where: { rule: 'W11', refId: step.id } })).toBe(2)
    expect(await db.alert.count({ where: { rule: 'W11', refId: step.id, status: 'ACTIVE' } })).toBe(1)
    await expect(settings.saveThreshold('W11', { remindHours: null, yellowDays: 15, redDays: 7 })).rejects.toThrow('红色阈值不能小于黄色阈值')
  })

  it('工单关闭后下一轮消除，工件级 W11 计入原看板红色工单统计', async () => {
    const wo = 'T-MON-BOARD'
    const { part, step } = await makePart(wo)
    // 只有工件停滞，工序本身很新，验证 part 预警能映射回工单。
    await db.routeStep.update({ where: { id: step.id }, data: { createdAt: now } })
    await scan.scanRules(now)
    const { getBoard } = await import('../../server/services/issues/board')
    expect((await getBoard([wo], now)).rows[0]).toMatchObject({ workOrderNumber: wo, color: 'RED', redAlerts: 1 })
    await db.qmsWorkOrder.update({ where: { workOrderNumber: wo }, data: { status: 'CANCELLED' } })
    await scan.scanRules(now)
    expect(await db.alert.findFirstOrThrow({ where: { rule: 'W11', refId: part.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
  })

  it('redCount 在完整集合独立计数，恰达红线含工序和工件，真实开工后回落，与红线筛选总数一致', async () => {
    const before = (await monitoring.getStatusMonitoring(now)).redCount
    const boundary = new Date(+now - 14 * 86_400_000)
    const red = []
    for (let i = 0; i < 6; i++) red.push(await makePart('T-MON-COUNT', boundary))
    await makePart('T-MON-COUNT', new Date(+now - 13 * 86_400_000))
    await makePart('T-MON-COUNT', now)
    const summary = await monitoring.getStatusMonitoring(now)
    expect(summary.redCount).toBe(before + 12)
    expect(summary.redCount).toBeGreaterThan(summary.top.length)
    const filter = { level: 'RED' as const, page: 1, pageSize: 100 }
    const list = await monitoring.listMonitoredEntities(filter, now)
    expect(list.total).toBe(summary.redCount)
    expect(list.rows.every((r) => r.level === 'RED')).toBe(true)
    expect(list.rows.filter((r) => r.workOrderNumber === 'T-MON-COUNT')).toHaveLength(12)
    expect((await monitoring.listMonitoredEntities({ ...filter, entityType: 'part' }, now)).rows.filter((r) => r.workOrderNumber === 'T-MON-COUNT')).toHaveLength(6)
    const { startStep } = await import('../../server/services/flow/flow')
    await startStep({ stepId: red[0]!.step.id, actorId: 'T-MON-OWNER', source: 'PC' })
    const after = new Date()
    expect((await monitoring.getStatusMonitoring(after)).redCount).toBe(before + 10)
    expect((await monitoring.listMonitoredEntities(filter, after)).total).toBe(before + 10)
    await db.qmsWorkOrder.update({ where: { workOrderNumber: 'T-MON-COUNT' }, data: { status: 'COMPLETED' } })
    expect((await monitoring.getStatusMonitoring(after)).redCount).toBe(before)
  })

  it('看板采购未到货与缺料分别统计，停滞取本单完整集合最大值且支持黄线，不受 Top 截断 / 预警扫描影响', async () => {
    const wo = 'T-MON-CAPSULES'
    await db.purchaseLine.createMany({ data: [
      { workOrderNumber: wo, materialName: '已到需求日', quantity: 1, needDate: old },
      { workOrderNumber: wo, materialName: '未到需求日', quantity: 1, needDate: new Date(+now + 20 * 86_400_000) },
      { workOrderNumber: wo, materialName: '已到货', quantity: 1, needDate: old, status: 'ARRIVED' },
      { workOrderNumber: wo, materialName: '已取消', quantity: 1, needDate: old, status: 'CANCELLED' },
    ] })
    const a = await makePart(wo, new Date(+now - 7 * 86_400_000))
    const { getBoard } = await import('../../server/services/issues/board')
    expect((await getBoard([wo], now)).rows[0]).toMatchObject({ purchasePending: 2, shortage: 1, stagnationRedDays: null, stagnationYellowDays: 7 })
    await db.routeStep.update({ where: { id: a.step.id }, data: { createdAt: new Date(+now - 18 * 86_400_000) } })
    const b = await makePart(wo, new Date(+now - 21 * 86_400_000))
    const board = await getBoard([wo], now)
    expect(board.rows).toHaveLength(1)
    expect(board.rows[0]).toMatchObject({ purchasePending: 2, shortage: 1, stagnationRedDays: 21, stagnationYellowDays: 7 })
    await db.part.update({ where: { id: b.part.id }, data: { status: 'DONE' } })
    expect((await getBoard([wo], now)).rows[0]!.stagnationRedDays).toBe(18)
    expect((await getBoard([], now)).rows).toEqual([])
  })
})
