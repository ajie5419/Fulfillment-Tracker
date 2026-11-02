/** 真实 MySQL：全景复用看板分类，超期口径在列表 / 看板 / 总览 / 驾驶舱一致。 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cockpitMetrics, mergeCockpitItems } from '../../shared/board-cockpit'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
const now = new Date('2040-05-15T04:00:00Z')
const day = (value: string) => new Date(`${value}T00:00:00Z`)
const fixtures = [
  { key: 'normal', status: 'IN_PROGRESS', issueStatus: 'OPEN', due: '2040-05-20', created: '2040-05-15', color: 'GREEN', overdue: false, days: 0, pm: 'T-PAN-PM-A', line: 'A' },
  { key: 'wait', status: 'IN_PROGRESS', issueStatus: 'OPEN', due: '2040-05-20', created: '2040-05-12', color: 'YELLOW', overdue: true, days: 0, pm: 'T-PAN-PM-A', line: 'A' },
  { key: 'due', status: 'IN_PROGRESS', issueStatus: 'ACCEPTED', due: '2040-05-14', created: '2040-05-12', color: 'YELLOW', overdue: true, days: 1, pm: 'T-PAN-PM-B', line: 'A' },
  { key: 'red', status: 'IN_PROGRESS', issueStatus: 'ACCEPTED', due: '2040-05-10', created: '2040-05-10', color: 'RED', overdue: true, days: 5, pm: 'T-PAN-PM-B', line: 'B' },
  { key: 'resolved', status: 'IN_PROGRESS', issueStatus: 'RESOLVED', due: '2040-05-10', created: '2040-05-10', color: 'GREEN', overdue: false, days: 0, pm: null, line: null },
  { key: 'closed', status: 'IN_PROGRESS', issueStatus: 'CLOSED', due: '2040-05-10', created: '2040-05-10', color: 'GREEN', overdue: false, days: 0, pm: null, line: null },
  { key: 'completed', status: 'COMPLETED', pm: 'T-PAN-PM-A', line: 'A' },
  { key: 'open', status: 'OPEN', pm: 'T-PAN-PM-B', line: 'B' },
  { key: 'cancelled', status: 'CANCELLED', pm: 'T-PAN-PM-C', line: 'C' },
  { key: 'deleted', status: 'IN_PROGRESS', isDeleted: true, pm: 'T-PAN-PM-C', line: 'C' },
] as const
const workOrderNumber = (key: string) => `T-PAN-${key}`
const numbers = fixtures.map((f) => workOrderNumber(f.key))

describe.skipIf(!DB)('项目全景与超期统一（服务）', () => {
  let db: PrismaClient
  let board: typeof import('../../server/services/issues/board')
  let panorama: typeof import('../../server/services/issues/panorama')
  let issues: typeof import('../../server/services/issues/issues')
  let overview: typeof import('../../server/services/issues/overview')
  let auth: typeof import('../../server/utils/auth')
  let priorThreshold: Awaited<ReturnType<PrismaClient['threshold']['findUnique']>>

  async function clean() {
    await db.issue.deleteMany({ where: { workOrderNumber: { in: numbers } } })
    await db.workOrderExt.deleteMany({ where: { workOrderNumber: { in: numbers } } })
    await db.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { in: numbers } } })
    await db.qmsUser.deleteMany({ where: { id: { in: ['T-PAN-PM-A', 'T-PAN-PM-B', 'T-PAN-PM-C'] } } })
  }

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    db = (await import('../../server/utils/prisma')).prisma
    board = await import('../../server/services/issues/board')
    panorama = await import('../../server/services/issues/panorama')
    issues = await import('../../server/services/issues/issues')
    overview = await import('../../server/services/issues/overview')
    auth = await import('../../server/utils/auth')
    await clean()
    priorThreshold = await db.threshold.findUnique({ where: { rule: 'W4' } })
    await db.threshold.upsert({ where: { rule: 'W4' }, create: { rule: 'W4', yellowDays: 2, redDays: 5 }, update: { yellowDays: 2, redDays: 5 } })
    await db.qmsUser.createMany({ data: ['A', 'B', 'C'].map((id) => ({ id: `T-PAN-PM-${id}`, username: `pan-${id}`, realName: `经理${id}`, status: 'ACTIVE', updatedAt: now })) })
    await db.qmsWorkOrder.createMany({ data: fixtures.map((f) => ({
      workOrderNumber: workOrderNumber(f.key), customerName: '全景测试客户', quantity: 1, deliveryDate: day('2040-06-01'),
      status: f.status, isDeleted: 'isDeleted' in f && f.isDeleted, updatedAt: now,
    })) })
    await db.workOrderExt.createMany({ data: fixtures.map((f) => ({ workOrderNumber: workOrderNumber(f.key), projectManagerId: f.pm, productLine: f.line })) })
    for (const f of fixtures) if ('issueStatus' in f) await db.issue.create({ data: {
      issueNo: `YC-PAN-${f.key}`, workOrderNumber: workOrderNumber(f.key), category: 'OTHER', description: f.key, source: 'MANUAL',
      status: f.issueStatus, dueDate: day(f.due), createdAt: day(f.created),
    } })
  })

  afterAll(async () => {
    if (!db) return
    await clean()
    if (priorThreshold) await db.threshold.upsert({ where: { rule: 'W4' }, create: priorThreshold, update: priorThreshold })
    else await db.threshold.deleteMany({ where: { rule: 'W4' } })
    await db.$disconnect()
  })

  it('列表、看板、总览及驾驶舱使用统一超期结果，读取不改变预警持久化', async () => {
    const before = await db.alert.findMany({ orderBy: { id: 'asc' } })
    const list = await issues.listIssues({ visibleWorkOrders: numbers }, { userId: 'viewer', isAdmin: false }, now)
    const result = await board.getBoard(numbers, now)
    for (const f of fixtures) if ('issueStatus' in f) {
      expect(list.find((i) => i.workOrderNumber === workOrderNumber(f.key))).toMatchObject({ overdue: f.overdue, overdueDays: f.days })
      expect(result.rows.find((r) => r.workOrderNumber === workOrderNumber(f.key))).toMatchObject({ color: f.color, overdueIssues: Number(f.overdue) })
    }
    expect(result.rows.reduce((sum, r) => sum + r.overdueIssues, 0)).toBe(3)
    const ov = await overview.getOverview(now)
    const global = await board.getBoard(undefined, now)
    expect(ov.summary.overdueIssues).toBe(global.rows.reduce((sum, r) => sum + r.overdueIssues, 0))
    expect(cockpitMetrics(ov, null)[1].value).toBe(ov.summary.overdueIssues)
    const items = mergeCockpitItems({ redWorkOrders: [], issues: list, stagnation: [] })
    expect(items).toHaveLength(3)
    expect(items.find((i) => i.workOrderNumber === workOrderNumber('wait'))).toMatchObject({ duration: '待受理超时', days: null })
    expect(await db.alert.findMany({ orderBy: { id: 'asc' } })).toEqual(before)
  })

  it('在制绿色 / 红黄、已完工、未开工按指定状态计数，排除删除与取消', async () => {
    const result = await panorama.getPanorama(numbers, now)
    expect(result.counts).toEqual({ inProgress: 6, normal: 3, abnormal: 3, completed: 1, notStarted: 1, unaccepted: null, unacceptedAvailable: false })
    expect(result.byManager).toEqual([
      { projectManagerId: 'T-PAN-PM-B', projectManagerName: '经理B', inProgress: 2, abnormal: 2 },
      { projectManagerId: 'T-PAN-PM-A', projectManagerName: '经理A', inProgress: 2, abnormal: 1 },
      { projectManagerId: null, projectManagerName: '未指定项目经理', inProgress: 2, abnormal: 0 },
    ])
    expect(result.byProductLine).toEqual([{ productLine: 'A', inProgress: 3, abnormal: 2 }, { productLine: null, inProgress: 2, abnormal: 0 }, { productLine: 'B', inProgress: 1, abnormal: 1 }])
    const rows = (await board.getBoard(numbers, now, { withClosed: true })).rows.filter((r) => r.status === 'IN_PROGRESS')
    expect(result.counts.normal).toBe(rows.filter((r) => r.color === 'GREEN').length)
    expect(result.counts.abnormal).toBe(rows.filter((r) => r.color === 'RED' || r.color === 'YELLOW').length)
  })

  it('项目经理只统计自己的可见工单，管理员范围同看板，空范围返回零', async () => {
    const scope = auth.scopeWorkOrders(await auth.resolveScope('T-PAN-PM-A', false))
    const mine = await panorama.getPanorama(scope, now)
    expect(mine.counts).toMatchObject({ inProgress: 2, abnormal: 1, normal: 1, completed: 1, notStarted: 0 })
    expect(mine.byManager.map((m) => m.projectManagerId)).toEqual(['T-PAN-PM-A'])
    expect(mine.byProductLine.map((p) => p.productLine)).toEqual(['A'])
    expect(auth.scopeWorkOrders(await auth.resolveScope('T-PAN-PM-A', true))).toBeUndefined()
    expect((await panorama.getPanorama([], now)).counts).toEqual({ inProgress: 0, normal: 0, abnormal: 0, completed: 0, notStarted: 0, unaccepted: null, unacceptedAvailable: false })
  })
})
