/**
 * QMS 数据同步（R2）：真实 MySQL + 模拟 QMS 同步接口（scripts/mock-qms-sync.mjs，走真实 HTTP），直接调用服务层。
 * 覆盖：分页游标推进与中断续跑（不重复、不丢）、同 updatedAt 多行、软删除、连续 3 次失败只提醒一次且恢复后清零、
 * 依赖跳过（外协单位/厂内班组）、多工单报检匹配、厂内外协班组（teams 接口 → kind = TEAM）匹配、旧版 QMS suppliers 里的 TEAM 行兼容、不合格新判定、部门 ID → 名称匹配部门负责人、
 * 演示数据清除不删真实行；A8 幂等：同一批数据同步两次，流转记录和待办不重复。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockIdentityBridge } from '../../scripts/mock-identity-bridge.mjs'
import { loadFixture } from '../../scripts/mock-qms-sync.mjs'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'local-dev-secret-local-dev-secret-0'
const WO1 = 'QMS-WO-2026-001'
const WO2 = 'QMS-WO-2026-002'

type Services = {
  sync: typeof import('../../server/services/sync/sync')
  job: typeof import('../../server/services/sync/job')
  status: typeof import('../../server/services/sync/status')
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  match: typeof import('../../server/services/flow/match')
  scan: typeof import('../../server/services/alerts/scan')
  reminders: typeof import('../../server/services/alerts/reminders')
  issues: typeof import('../../server/services/issues/issues')
  demo: typeof import('../../server/services/dev/demo')
}

type Mock = Awaited<ReturnType<typeof startMockIdentityBridge>>
type MockSync = NonNullable<Mock['sync']>

describe.skipIf(!DB)('QMS 数据同步', () => {
  let db: PrismaClient
  let s: Services
  let mock: Mock
  let qms: MockSync
  let config: { apiBase: string; clientId: string; clientSecret: string; enabled: boolean }
  const ADMIN = 'u-admin'

  /** 一轮完整任务（同步 → 匹配 → 不合格转异常），每页 2 行逼出翻页 */
  const runJob = (extra: Partial<Parameters<Services['job']['runSyncJob']>[0]> = {}) =>
    s.job.runSyncJob({ config, adminIds: [ADMIN], pageLimit: 2, ...extra })
  const syncOnly = (extra: Partial<Parameters<Services['sync']['syncQms']>[0]> = {}) => s.sync.syncQms({ config, adminIds: [ADMIN], pageLimit: 2, ...extra })
  const cursorOf = (resource: string) => db.syncCursor.findUniqueOrThrow({ where: { resource } })
  const counts = () => Promise.all([db.flowEvent.count(), db.todo.count(), db.unmatchedInspection.count(), db.issue.count()])

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      sync: await import('../../server/services/sync/sync'),
      job: await import('../../server/services/sync/job'),
      status: await import('../../server/services/sync/status'),
      steps: await import('../../server/services/flow/steps'),
      flow: await import('../../server/services/flow/flow'),
      match: await import('../../server/services/flow/match'),
      scan: await import('../../server/services/alerts/scan'),
      reminders: await import('../../server/services/alerts/reminders'),
      issues: await import('../../server/services/issues/issues'),
      demo: await import('../../server/services/dev/demo'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.uploadFile.deleteMany()
    await db.issue.deleteMany()
    await db.notifyRole.deleteMany()
    await db.workOrderExt.deleteMany()
    await db.threshold.deleteMany()
    await db.syncCursor.deleteMany()
    await db.jobLock.deleteMany()
    await db.flowEvent.deleteMany()
    await db.todo.deleteMany()
    await db.unmatchedInspection.deleteMany()
    await db.routeStep.deleteMany()
    await db.part.deleteMany()
    await db.qmsInspection.deleteMany()
    await db.qmsWorkOrder.deleteMany()
    await db.qmsSupplier.deleteMany()
    await db.qmsProcess.deleteMany()
    await db.qmsDepartment.deleteMany()
    await db.qmsUser.deleteMany()
    mock = await startMockIdentityBridge({ sync: loadFixture() })
    qms = mock.sync!
    config = { apiBase: mock.url, clientId: 'fulfillment', clientSecret: SECRET, enabled: true }
  })

  afterAll(async () => {
    await mock?.close()
    await db?.$disconnect()
  })

  it('未配置时跳过、不报错；凭据不对时记错误（错误信息里没有密钥）', async () => {
    expect(await s.job.runSyncJob({ config: { ...config, enabled: false }, adminIds: [ADMIN] })).toEqual({ skipped: 'not-configured' })
    expect(await s.job.runSyncJob({ config: { ...config, apiBase: '' }, adminIds: [ADMIN] })).toEqual({ skipped: 'not-configured' })
    expect(await db.syncCursor.count()).toBe(0)
    const r = await syncOnly({ config: { ...config, clientSecret: 'wrong-secret-wrong-secret-wrong-00' }, only: ['departments'] })
    expect(r.resources[0]).toMatchObject({ status: 'failed' })
    const c = await cursorOf('departments')
    expect(c.lastError).toContain('401')
    expect(c.lastError).not.toContain('secret')
    expect(c).toMatchObject({ failCount: 1, since: null, lastSyncedAt: null })
  })

  it('首次全量同步：翻页拉完 7 类资源，游标推进到最后一行；字段按契约写入副本', async () => {
    const r = await runJob()
    expect(r.sync!.resources.map((x) => [x.resource, x.status])).toEqual([
      ['work-orders', 'ok'],
      ['suppliers', 'ok'],
      ['teams', 'ok'],
      ['processes', 'ok'],
      ['departments', 'ok'],
      ['users', 'ok'],
      ['inspections', 'ok'],
    ])
    expect(r.sync!.resources.find((x) => x.resource === 'departments')).toMatchObject({ rows: 7, pages: 4 }) // 每页 2 行
    expect(await db.qmsDepartment.count()).toBe(7)
    // 上一个用例的失败计数被成功清零
    expect(await cursorOf('departments')).toMatchObject({ failCount: 0, lastError: null, since: new Date('2026-09-02T00:00:00.000Z'), afterId: 'dept-lead' })
    expect((await cursorOf('departments')).lastSyncedAt).not.toBeNull()
    // 用户：部门存部门 ID；isActive=false → INACTIVE
    expect(await db.qmsUser.findUniqueOrThrow({ where: { id: 'u-002' } })).toMatchObject({ username: 'shengchan01', departmentId: 'dept-prod', status: 'ACTIVE' })
    expect((await db.qmsUser.findUniqueOrThrow({ where: { id: 'u-007' } })).status).toBe('INACTIVE')
    // 班组来自 teams 接口，写进 qms_supplier（kind = TEAM）；外协单位软删除照抄
    expect(qms.data.suppliers.some((x: { kind?: string }) => x.kind === 'TEAM')).toBe(false)
    expect(await db.qmsSupplier.findUniqueOrThrow({ where: { id: 'team-weld1' } })).toMatchObject({ kind: 'TEAM', name: '组焊一班', status: 'ACTIVE', category: null, outsourcingMode: null })
    expect(await cursorOf('teams')).toMatchObject({ afterId: 'team-weld1', since: new Date('2026-09-04T00:00:00.000Z'), failCount: 0 })
    expect(await db.qmsSupplier.findUniqueOrThrow({ where: { id: 'sup-old' } })).toMatchObject({ isDeleted: true, status: 'Disqualified', kind: 'SUPPLIER' })
    expect(await db.qmsProcess.findUniqueOrThrow({ where: { id: 'prc-weld' } })).toMatchObject({ code: 'WELD', status: 1 })
    const hist = await db.qmsInspection.findUniqueOrThrow({ where: { id: 'qi-hist-002' } })
    expect(hist).toMatchObject({ status: 'INSPECTING', inspectionResult: 'FAIL', linkedIssueNo: 'ZL-20260912-001', closedAt: null, workOrderNumbers: ['QMS-WO-2026-003'] })
    // 履约没在跟踪的工单（没建工件）的历史报检：不进待确认，也不转异常
    expect(await db.unmatchedInspection.count()).toBe(0)
    expect(await db.issue.count()).toBe(0)
    // 看板：最后同步时间 = 各资源 lastSyncedAt 的最小值，没有报错
    const overview = await s.status.syncOverview()
    const synced = await db.syncCursor.findMany()
    expect(overview.lastSyncAt).toEqual(new Date(Math.min(...synced.map((c) => +c.lastSyncedAt!))))
    expect(overview.errors).toEqual([])

    // 没有变化时再跑：每类只请求一页，什么都不写
    const again = await syncOnly()
    expect(again.resources.every((x) => x.status === 'ok' && x.rows === 0 && x.pages === 1)).toBe(true)
  })

  it('前几页成功、后面某页失败：失败次数按整轮累加，不被成功的页清零', async () => {
    const t = '2026-09-30T08:00:00.000Z' // 早于下一个用例的数据，避免游标越过它们
    for (let i = 1; i <= 8; i++) qms.upsert('departments', { id: `dept-z${i}`, name: `z${i}`, parentId: '0', status: 1, isDeleted: false, updatedAt: t })
    for (let run = 1; run <= 3; run++) {
      let calls = 0
      const flaky: typeof fetch = async (url, init) => {
        if (String(url).includes('/departments') && ++calls === 2) throw new TypeError('fetch failed: ECONNRESET')
        return fetch(url, init)
      }
      const r = await syncOnly({ only: ['departments'], fetchImpl: flaky })
      expect(r.resources[0]).toMatchObject({ status: 'failed', pages: 1 })
      expect(await cursorOf('departments')).toMatchObject({ failCount: run })
      expect(r.alerted).toBe(run === 3 ? 1 : 0) // 第 3 次连续失败能触发管理员提醒
    }
    // 整轮成功后才清零
    expect((await syncOnly({ only: ['departments'] })).resources[0]).toMatchObject({ status: 'ok' })
    expect(await cursorOf('departments')).toMatchObject({ failCount: 0, lastError: null })
    expect(await db.qmsDepartment.count({ where: { id: { startsWith: 'dept-z' } } })).toBe(8)
    await db.reminder.deleteMany({ where: { kind: 'SYNC_FAIL' } }) // 不影响后面的提醒用例
  })

  it('中途失败后续跑：已提交的页保留，游标停在最后成功的一页；重跑不重复、不丢（同 updatedAt 多行跨页）', async () => {
    const t = '2026-10-01T08:00:00.123Z'
    for (const id of ['dept-x1', 'dept-x2', 'dept-x3', 'dept-x4', 'dept-x5']) qms.upsert('departments', { id, name: `车间${id.slice(-1)}`, parentId: 'dept-prod', status: 1, isDeleted: false, updatedAt: t })
    // 第 2 次请求（第 2 页）网络中断
    let calls = 0
    const flaky: typeof fetch = async (url, init) => {
      if (String(url).includes('/departments') && ++calls === 2) throw new TypeError('fetch failed: ECONNRESET')
      return fetch(url, init)
    }
    const r1 = await syncOnly({ only: ['departments'], fetchImpl: flaky })
    expect(r1.resources[0]).toMatchObject({ status: 'failed', pages: 1, rows: 2 })
    expect(await cursorOf('departments')).toMatchObject({ since: new Date(t), afterId: 'dept-x2', failCount: 1 })
    expect((await cursorOf('departments')).lastError).toContain('ECONNRESET')
    expect(await db.qmsDepartment.count({ where: { id: { startsWith: 'dept-x' } } })).toBe(2)

    // 续跑：从 (t, dept-x2) 接着拉，同一毫秒的 x3–x5 一个不丢
    const r2 = await syncOnly({ only: ['departments'] })
    expect(r2.resources[0]).toMatchObject({ status: 'ok', rows: 3 })
    expect(await db.qmsDepartment.count({ where: { id: { startsWith: 'dept-x' } } })).toBe(5)
    expect(await cursorOf('departments')).toMatchObject({ since: new Date(t), afterId: 'dept-x5', failCount: 0, lastError: null })

    // 单次运行的页数上限：没追平只是"未追平"，不算失败，下一轮接着拉
    for (const id of ['dept-y1', 'dept-y2', 'dept-y3']) qms.upsert('departments', { id, name: id, parentId: '0', status: 1, isDeleted: false })
    const r3 = await syncOnly({ only: ['departments'], maxPages: 1 })
    expect(r3.resources[0]).toMatchObject({ status: 'partial', rows: 2 })
    expect((await syncOnly({ only: ['departments'] })).resources[0]).toMatchObject({ status: 'ok', rows: 1 })
    expect(await db.qmsDepartment.count({ where: { id: { startsWith: 'dept-y' } } })).toBe(3)
  })

  it('软删除同步：QMS 删掉的行副本里 isDeleted = true，不物理删除', async () => {
    qms.upsert('departments', { id: 'dept-x5', isDeleted: true })
    qms.upsert('users', { id: 'u-007', isDeleted: true })
    await syncOnly({ only: ['departments', 'users'] })
    expect((await db.qmsDepartment.findUniqueOrThrow({ where: { id: 'dept-x5' } })).isDeleted).toBe(true)
    expect((await db.qmsUser.findUniqueOrThrow({ where: { id: 'u-007' } })).isDeleted).toBe(true)
  })

  it('连续 3 次失败只给管理员发一条置顶提醒；同一轮故障不重复发；恢复后清零，再坏再发', async () => {
    const fails = () => db.reminder.findMany({ where: { userId: ADMIN, kind: 'SYNC_FAIL' }, orderBy: { createdAt: 'asc' } })
    qms.failNext('users', 4, 503)
    for (let i = 1; i <= 2; i++) {
      const r = await syncOnly()
      expect(r.resources.find((x) => x.resource === 'users')).toMatchObject({ status: 'failed' })
      expect(r.resources.find((x) => x.resource === 'inspections')).toMatchObject({ status: 'ok' }) // 用户失败不影响报检
      expect(r.alerted).toBe(0)
    }
    expect(await fails()).toHaveLength(0)
    const third = await syncOnly()
    expect(third.alerted).toBe(1)
    const [reminder] = await fails()
    expect(reminder).toMatchObject({ level: 'RED', title: 'QMS 同步连续失败 3 次：用户' })
    expect(reminder!.body).toContain('QMS 同步接口返回 503')
    expect(await cursorOf('users')).toMatchObject({ failCount: 3 })
    expect((await cursorOf('users')).alertedAt).not.toBeNull()
    // "我的提醒"置顶，不混在分组里
    const mine = await s.reminders.listReminders(ADMIN)
    expect(mine.pinned.map((p) => p.id)).toEqual([reminder!.id])
    expect(mine.pinned[0]!.link).toBe('/settings?tab=sync')
    expect(mine.items.some((i) => i.id === reminder!.id)).toBe(false)
    // 第 4 次仍失败：同一轮故障不再发
    expect((await syncOnly()).alerted).toBe(0)
    expect(await fails()).toHaveLength(1)
    expect((await s.status.syncOverview()).errors).toMatchObject([{ resource: 'users', label: '用户', failCount: 4 }])

    // 恢复：失败计数、错误、提醒标记都清掉
    await syncOnly()
    expect(await cursorOf('users')).toMatchObject({ failCount: 0, lastError: null, alertedAt: null })
    expect((await s.status.syncOverview()).errors).toEqual([])
    // 读过的同步提醒回到普通列表
    await s.reminders.markRead(ADMIN, reminder!.id)
    expect((await s.reminders.listReminders(ADMIN)).items.find((i) => i.id === reminder!.id)).toMatchObject({ kind: 'SYNC_FAIL', link: '/settings?tab=sync' })

    // 新一轮故障再连续 3 次：再发一条
    qms.failNext('users', 3, 500)
    for (let i = 0; i < 3; i++) await syncOnly()
    expect(await fails()).toHaveLength(2)
    await syncOnly()
  })

  it('依赖跳过：外协单位同步失败时本轮不同步报检、不做匹配，游标不动', async () => {
    const before = await cursorOf('inspections')
    qms.failNext('suppliers', 1, 502)
    const r = await runJob()
    expect(r.sync!.resources.find((x) => x.resource === 'inspections')).toMatchObject({ status: 'skipped' })
    expect(r.sync!.resources.find((x) => x.resource === 'inspections')!.error).toContain('外协单位')
    expect(r.match).toBeUndefined()
    expect(await cursorOf('inspections')).toMatchObject({ since: before.since, afterId: before.afterId, failCount: 0 })
    await runJob() // 恢复
  })

  it('依赖跳过：厂内班组同步失败时本轮也不同步报检', async () => {
    const before = await cursorOf('inspections')
    qms.failNext('teams', 1, 502)
    const r = await runJob()
    expect(r.sync!.resources.find((x) => x.resource === 'teams')).toMatchObject({ status: 'failed' })
    expect(r.sync!.resources.find((x) => x.resource === 'inspections')).toMatchObject({ status: 'skipped' })
    expect(r.sync!.resources.find((x) => x.resource === 'inspections')!.error).toContain('厂内班组')
    expect(r.match).toBeUndefined()
    expect(await cursorOf('inspections')).toMatchObject({ since: before.since, afterId: before.afterId, failCount: 0 })
    await runJob() // 恢复
  })

  it('旧版 QMS 兼容：suppliers 里仍带 kind = TEAM 的行照旧按班组写入；新 suppliers 行一律是供应商', async () => {
    qms.upsert('suppliers', { id: 'team-legacy', name: '旧接口班组', category: null, outsourcingMode: 'IN_PLANT', status: null, kind: 'TEAM', isDeleted: false })
    qms.upsert('suppliers', { id: 'sup-nokind', name: '不带 kind 的供应商', category: '机加', outsourcingMode: 'EXTERNAL', status: 'Qualified', isDeleted: false })
    await syncOnly({ only: ['suppliers'] })
    expect(await db.qmsSupplier.findUniqueOrThrow({ where: { id: 'team-legacy' } })).toMatchObject({ kind: 'TEAM' })
    expect(await db.qmsSupplier.findUniqueOrThrow({ where: { id: 'sup-nokind' } })).toMatchObject({ kind: 'SUPPLIER' })
    // 之后新版 QMS 从 teams 下发同一 id：按班组覆盖
    qms.data.suppliers = qms.data.suppliers.filter((x: { id: string }) => x.id !== 'team-legacy')
    qms.upsert('teams', { id: 'team-legacy', name: '旧接口班组（新）', status: 'INACTIVE', isDeleted: false })
    await syncOnly({ only: ['teams'] })
    expect(await db.qmsSupplier.findUniqueOrThrow({ where: { id: 'team-legacy' } })).toMatchObject({ kind: 'TEAM', name: '旧接口班组（新）', status: 'INACTIVE', outsourcingMode: null })
    await db.qmsSupplier.deleteMany({ where: { id: { in: ['team-legacy', 'sup-nokind'] } } })
    qms.data.suppliers = qms.data.suppliers.filter((x: { id: string }) => x.id !== 'sup-nokind')
    qms.data.teams = qms.data.teams.filter((x: { id: string }) => x.id !== 'team-legacy')
  })

  it('班组长（生产管理重设计第二批）：设置页维护的班组长单独成表，QMS 再同步同一个班组（改名、停用）和班组长用户时不被覆盖、不被清掉', async () => {
    await db.teamLeader.upsert({ where: { supplierId: 'team-weld1' }, create: { supplierId: 'team-weld1', userId: 'u-002', updatedBy: ADMIN }, update: { userId: 'u-002', updatedBy: ADMIN } })
    const team = qms.data.teams.find((x: { id: string }) => x.id === 'team-weld1')
    const user = qms.data.users.find((x: { id: string }) => x.id === 'u-002')
    qms.upsert('teams', { ...team, name: '组焊一班（改名）', status: 'INACTIVE', updatedAt: undefined })
    qms.upsert('users', { ...user, realName: '生产经理（改名）', updatedAt: undefined })
    await syncOnly({ only: ['teams', 'users'] })
    expect(await db.qmsSupplier.findUniqueOrThrow({ where: { id: 'team-weld1' } })).toMatchObject({ name: '组焊一班（改名）', status: 'INACTIVE', kind: 'TEAM' })
    expect(await db.teamLeader.findUniqueOrThrow({ where: { supplierId: 'team-weld1' } })).toMatchObject({ userId: 'u-002', updatedBy: ADMIN })
    // 整轮任务再跑一次（含全部资源、匹配）也一样
    await runJob()
    expect(await db.teamLeader.findUnique({ where: { supplierId: 'team-weld1' } })).toMatchObject({ userId: 'u-002' })
    // 还原，别影响后面的用例
    qms.upsert('teams', { ...team, updatedAt: undefined })
    qms.upsert('users', { ...user, updatedAt: undefined })
    await syncOnly({ only: ['teams', 'users'] })
    await db.teamLeader.delete({ where: { supplierId: 'team-weld1' } })
  })

  // ───── 匹配 ─────

  let seq = 0
  async function makePart(wo: string, chain: { processId: string; mode: 'SELF' | 'IN_PLANT_OUTSOURCE' | 'EXTERNAL_OUTSOURCE'; supplierId?: string }[]) {
    seq++
    const part = await s.steps.createPart(wo, { name: `同步测试件-${seq}`, quantity: 2, qmsPartId: `BOM-SYNC-${seq}` })
    const steps = []
    for (const c of chain) steps.push(await s.steps.addStep(part.id, c, 'u-001'))
    return { part, steps }
  }
  const nextPromised = () => new Date(`${new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`)
  function inspection(id: string, over: Record<string, unknown>) {
    return qms.upsert('inspections', {
      id,
      requestNo: `BJ-${id}`,
      workOrderNumber: WO1,
      workOrderNumbers: [WO1],
      partId: null,
      partName: '',
      processId: 'prc-weld',
      processName: '组焊',
      supplierId: null,
      supplierName: null,
      teamId: null,
      teamName: null,
      category: 'PROCESS',
      quantity: 2,
      status: 'SUBMITTED',
      inspectionResult: 'PASS',
      unqualifiedQuantity: null,
      linkedIssueId: null,
      linkedIssueNo: null,
      reporterId: 'u-001',
      submittedAt: new Date().toISOString(),
      closedAt: null,
      isDeleted: false,
      ...over,
    })
  }

  it('多工单报检：主工单没有候选、关联工单命中即自动匹配；A8 同一批数据同步两次不重复记返厂和待办', async () => {
    const { part, steps } = await makePart(WO1, [
      { processId: 'prc-weld', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'sup-weld' },
      { processId: 'prc-paint', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'sup-paint' },
    ])
    await s.flow.sendStep({ stepId: steps[0]!.id, promisedReturnDate: nextPromised(), actorId: 'u-001', source: 'PC' })
    // 主工单是 WO2（没有这件），关联工单里有 WO1
    inspection('qi-multi', { workOrderNumber: WO2, workOrderNumbers: [WO2, WO1], partId: part.qmsPartId, supplierId: 'sup-weld', supplierName: '华东组焊厂' })
    const r = await runJob()
    expect(r.match).toMatchObject({ matched: 1, unmatched: 0 })
    const ev = await db.flowEvent.findUniqueOrThrow({ where: { qmsInspectionId: 'qi-multi' } })
    expect(ev).toMatchObject({ stepId: steps[0]!.id, type: 'RETURN', source: 'QMS_INSPECTION', qty: 2 })
    expect(await db.todo.count({ where: { refType: 'step', refId: steps[1]!.id, status: 'OPEN' } })).toBe(1)
    expect((await db.qmsInspection.findUniqueOrThrow({ where: { id: 'qi-multi' } })).workOrderNumbers).toEqual([WO2, WO1])

    // A8：同一批数据再同步两次（含游标重置后整批重拉、报检有更新），流转记录和待办不重复
    const before = await counts()
    await runJob()
    await db.syncCursor.update({ where: { resource: 'inspections' }, data: { since: null, afterId: null } })
    await runJob()
    qms.upsert('inspections', { id: 'qi-multi', status: 'INSPECTING' })
    await runJob()
    expect(await counts()).toEqual(before)
    expect(await db.flowEvent.count({ where: { qmsInspectionId: 'qi-multi' } })).toBe(1)
  })

  it('多工单报检：两个工单各有一个候选 → MULTIPLE 待确认，候选带工单号；可关联到关联工单的步骤', async () => {
    const a = await makePart(WO1, [{ processId: 'prc-mach', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'sup-mach' }])
    const b = await makePart(WO2, [{ processId: 'prc-mach', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'sup-mach' }])
    await db.part.update({ where: { id: b.part.id }, data: { name: a.part.name } })
    for (const p of [a, b]) await s.flow.sendStep({ stepId: p.steps[0]!.id, promisedReturnDate: nextPromised(), actorId: 'u-001', source: 'PC' })
    inspection('qi-multi-2', { workOrderNumber: WO1, workOrderNumbers: [WO1, WO2], partName: a.part.name, processId: 'prc-mach', processName: '机加', supplierId: 'sup-mach' })
    const r = await runJob()
    expect(r.match).toMatchObject({ matched: 0, unmatched: 1 })
    const [row] = (await s.match.listUnmatched()).filter((u) => u.qmsInspectionId === 'qi-multi-2')
    expect(row!.reason).toBe('MULTIPLE')
    expect(row!.candidates.map((c) => c.workOrderNumber).sort()).toEqual([WO1, WO2])
    // 项目经理只看 WO2 时也能看到（任一工单可见即可见）
    expect((await s.match.listUnmatched([WO2])).some((u) => u.qmsInspectionId === 'qi-multi-2')).toBe(true)
    await s.match.resolveUnmatched('qi-multi-2', b.steps[0]!.id, 'u-001')
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: b.steps[0]!.id } })).status).toBe('DONE')
  })

  it('厂内外协：班组来自 teams 接口；报检只有 teamId（没有 supplierId）时按班组匹配到 kind = TEAM 的外协单位', async () => {
    // team-weld1 只在 teams 接口里下发，不在 suppliers 里
    expect(qms.data.teams.map((x: { id: string }) => x.id)).toContain('team-weld1')
    expect(qms.data.suppliers.some((x: { id: string }) => x.id === 'team-weld1')).toBe(false)
    const team = await makePart(WO1, [
      { processId: 'prc-weld', mode: 'IN_PLANT_OUTSOURCE', supplierId: 'team-weld1' },
      { processId: 'prc-assy', mode: 'SELF' },
    ])
    // 同一工单、同物料名、同工序的另一件，外协单位是供应商：按班组过滤后只剩上面这一件
    const other = await makePart(WO1, [{ processId: 'prc-weld', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'sup-weld' }])
    await db.part.update({ where: { id: other.part.id }, data: { name: team.part.name } })
    await s.flow.startStep({ stepId: team.steps[0]!.id, actorId: 'u-001', source: 'PC' })
    await s.flow.sendStep({ stepId: other.steps[0]!.id, promisedReturnDate: nextPromised(), actorId: 'u-001', source: 'PC' })
    inspection('qi-team', { partName: team.part.name, teamId: 'team-weld1', teamName: '组焊一班' })
    inspection('qi-team-x', { partName: team.part.name, teamId: 'team-other', teamName: '别的班组' })
    await runJob()
    expect(await db.flowEvent.findUniqueOrThrow({ where: { qmsInspectionId: 'qi-team' } })).toMatchObject({ stepId: team.steps[0]!.id })
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: team.steps[0]!.id } })).status).toBe('DONE')
    expect(await db.todo.count({ where: { refType: 'step', refId: team.steps[1]!.id, action: 'ARRANGE_START' } })).toBe(1)
    // 班组对不上 → 没有候选，进待确认
    expect(await db.unmatchedInspection.findUniqueOrThrow({ where: { qmsInspectionId: 'qi-team-x' } })).toMatchObject({ reason: 'NO_CANDIDATE' })
  })

  it('不合格新判定：检验中 + FAIL 即生成异常（责任方为班组）；之后改成 已关闭 + 合格 不撤销；只有问题单号也生成；撤销的不生成', async () => {
    const issueOf = (id: string) => db.issue.findUnique({ where: { sourceKey: `QMS:${id}` } })
    // qi-team 已匹配：QMS 判不合格（FAIL，状态仍是检验中，closedAt 为空）
    qms.upsert('inspections', { id: 'qi-team', status: 'INSPECTING', inspectionResult: 'FAIL', unqualifiedQuantity: 1, linkedIssueId: 'qms-issue-9', linkedIssueNo: 'ZL-9' })
    const r = await runJob()
    expect(r.nonconforming).toMatchObject({ created: 1 })
    const issue = await issueOf('qi-team')
    expect(issue).toMatchObject({ source: 'QMS_NONCONFORMING', category: 'OUTSOURCE_QUALITY', responsibleSupplierId: 'team-weld1' })
    expect(issue!.description).toContain('组焊一班')
    expect(issue!.description).toContain('QMS 问题单 ZL-9')
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: issue!.refId! } })).status).toBe('BLOCKED')
    // 复检合格：QMS 覆盖成 CLOSED + PASS，问题单号还在；已生成的异常不撤销、不重复
    qms.upsert('inspections', { id: 'qi-team', status: 'CLOSED', inspectionResult: 'PASS', closedAt: new Date().toISOString() })
    await runJob()
    expect(await db.issue.count({ where: { sourceKey: 'QMS:qi-team' } })).toBe(1)
    expect((await issueOf('qi-team'))!.status).toBe('OPEN')

    // 只有问题单号（结论仍是默认 PASS）：也算不合格
    const p = await makePart(WO1, [{ processId: 'prc-paint', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'sup-paint' }])
    await s.flow.sendStep({ stepId: p.steps[0]!.id, promisedReturnDate: nextPromised(), actorId: 'u-001', source: 'PC' })
    inspection('qi-linked', { partId: p.part.qmsPartId, processId: 'prc-paint', processName: '涂装', supplierId: 'sup-paint', status: 'INSPECTING', linkedIssueNo: 'ZL-10' })
    // 撤销的报检即使 FAIL 也不生成（没匹配过 → 忽略）
    const q = await makePart(WO1, [{ processId: 'prc-mach', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'sup-mach' }])
    await s.flow.sendStep({ stepId: q.steps[0]!.id, promisedReturnDate: nextPromised(), actorId: 'u-001', source: 'PC' })
    inspection('qi-cancel', { partId: q.part.qmsPartId, processId: 'prc-mach', processName: '机加', status: 'CANCELLED', inspectionResult: 'FAIL' })
    await runJob()
    expect(await issueOf('qi-linked')).toMatchObject({ responsibleSupplierId: 'sup-paint' })
    expect(await issueOf('qi-cancel')).toBeNull()
    expect(await db.flowEvent.count({ where: { qmsInspectionId: 'qi-cancel' } })).toBe(0)
  })

  it('部门 ID → 名称：升级阶梯按名称找部门负责人；"本部门"筛选、异常默认责任部门照常', async () => {
    await db.notifyRole.createMany({
      data: [
        { role: 'DEPT_HEAD', userId: 'u-002', department: '生产部' },
        { role: 'DEPT_HEAD', userId: 'u-006', department: '质量部' },
      ],
    })
    // u-001 的部门是 dept-prod（生产部）：黄色时通知生产部负责人 u-002，不通知质量部负责人
    const ctx = await s.scan.loadNotifyContext([{ ownerIds: ['u-001'], workOrderNumber: null }])
    const yellow = s.scan.recipientsFor('YELLOW', { ownerIds: ['u-001'], workOrderNumber: null }, ctx)
    expect(yellow.sort()).toEqual(['u-001', 'u-002'])
    // 本部门：负责人按名称配置 → 部门 ID；自己所在部门直接是 ID
    expect(await s.issues.myDepartmentIds('u-006')).toEqual(['dept-qa'])
    expect(await s.issues.myDepartmentIds('u-001')).toEqual(['dept-prod'])
    // 默认责任部门（按名称）与负责人
    const issue = await s.issues.createIssue({ workOrderNumber: WO1, category: 'WORKSHOP', description: '同步后上报' }, 'u-001')
    expect(issue).toMatchObject({ responsibleDeptId: 'dept-prod', responsibleUserId: 'u-002' })
    // QMS 里改了部门名称：同步后按新名称对应（负责人配置仍是旧名称时不再命中）
    qms.upsert('departments', { id: 'dept-prod', name: '生产制造部' })
    await syncOnly({ only: ['departments'] })
    const ctx2 = await s.scan.loadNotifyContext([{ ownerIds: ['u-001'], workOrderNumber: null }])
    expect(s.scan.recipientsFor('YELLOW', { ownerIds: ['u-001'], workOrderNumber: null }, ctx2)).toEqual(['u-001'])
    qms.upsert('departments', { id: 'dept-prod', name: '生产部' })
    await syncOnly({ only: ['departments'] })
  })

  it('清除演示数据只删 DEMO- 行：同步来的真实行（含与演示用户同 ID 的 u-001）一行不少', async () => {
    const snapshot = () =>
      Promise.all([
        db.qmsWorkOrder.count(),
        db.qmsSupplier.count(),
        db.qmsProcess.count(),
        db.qmsDepartment.count(),
        db.qmsUser.count(),
        db.qmsInspection.count(),
        db.part.count(),
        db.routeStep.count(),
        db.flowEvent.count(),
        db.issue.count(),
      ])
    const before = await snapshot()
    // 配置了同步：不写演示用户；DEMO- 行与真实行共存
    const seeded = await s.demo.seedDemo({ skipUsers: true })
    expect(seeded.users).toBe(0)
    expect(await db.qmsUser.findUniqueOrThrow({ where: { id: 'u-001' } })).toMatchObject({ username: 'waixie01', departmentId: 'dept-prod' })
    // 没配置同步时写演示用户也不覆盖已同步来的同 ID 用户
    await s.demo.seedDemo()
    expect(await db.qmsUser.findUniqueOrThrow({ where: { id: 'u-001' } })).toMatchObject({ username: 'waixie01' })
    expect(await db.qmsWorkOrder.count({ where: { workOrderNumber: { startsWith: 'DEMO-' } } })).toBe(3)
    // R9：演示发放单走真实用户（发放人退回 u-003），清除时一并删掉，连同待办
    expect(seeded.releases).toBe(2)
    const reset = await s.demo.resetDemo()
    expect(reset.parts).toBe(3) // 主梁结构件 + 支腿（R9）+ 回转底座（R12）
    expect(reset.releases).toBe(2)
    // R12：演示装配节点一并删掉（清单级联）
    expect(reset.assemblyNodes).toBe(3)
    expect(await db.assemblyNode.count()).toBe(0)
    expect(await db.release.count()).toBe(0)
    expect(await db.todo.count({ where: { refType: { in: ['receipt', 'release'] } } })).toBe(0)
    expect(await snapshot()).toEqual(before)
    expect(await db.qmsSupplier.count({ where: { id: { startsWith: 'DEMO-' } } })).toBe(0)
    expect(await db.qmsDepartment.count({ where: { id: { startsWith: 'DEMO-' } } })).toBe(0)
    // 清除后再同步一轮，什么都不缺
    const r = await syncOnly()
    expect(r.resources.every((x) => x.status === 'ok' && x.rows === 0)).toBe(true)
  })

  it.each([{ isActive: false, isDeleted: false }, { isActive: true, isDeleted: true }])('user sync revokes every session before recovery: %o', async (state) => {
    const { createSession, resolveSession } = await import('../../server/services/auth/session')
    const id = `AUTH-REVOKE-${state.isDeleted ? 'deleted' : 'inactive'}`
    const otherId = `${id}-other`
    for (const userId of [id, otherId]) qms.upsert('users', { id: userId, username: userId, isActive: true, isDeleted: false })
    expect((await syncOnly({ only: ['users'] })).resources[0]?.status).toBe('ok')
    try {
      const first = await createSession(db, { qmsUserId: id, userName: id })
      const second = await createSession(db, { qmsUserId: id, userName: id })
      const other = await createSession(db, { qmsUserId: otherId, userName: otherId })
      qms.upsert('users', { id, ...state })
      expect((await syncOnly({ only: ['users'] })).resources[0]?.status).toBe('ok')
      expect(await db.session.count({ where: { qmsUserId: id } })).toBe(0)
      qms.upsert('users', { id, isActive: true, isDeleted: false })
      expect((await syncOnly({ only: ['users'] })).resources[0]?.status).toBe('ok')
      expect(await resolveSession(db, first.token)).toBeNull()
      expect(await resolveSession(db, second.token)).toBeNull()
      expect(await resolveSession(db, other.token)).not.toBeNull()
      expect(await createSession(db, { qmsUserId: id, userName: id })).toHaveProperty('token')
    } finally {
      await db.session.deleteMany({ where: { qmsUserId: { in: [id, otherId] } } })
      await db.qmsUser.deleteMany({ where: { id: { in: [id, otherId] } } })
    }
  })
})
