/**
 * 异常闭环与看板（R5）：真实 MySQL 上直接调用服务层，用 now 注入"快进时钟"。
 * 覆盖：状态机全流程与非法迁移、各操作权限、并发迁移只成功一次、QMS 不合格（A7）幂等与步骤有异常/恢复、
 * 红色自动转异常（A4）、黄色手动转、W4 黄/红与待确认消除、每日汇总同日一条、可见范围、照片魔数与大小。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  digest: typeof import('../../server/services/alerts/digest')
  issues: typeof import('../../server/services/issues/issues')
  nonconforming: typeof import('../../server/services/issues/nonconforming')
  kit: typeof import('../../server/services/kitting/kitting')
  board: typeof import('../../server/services/issues/board')
  uploads: typeof import('../../server/services/issues/uploads')
  auth: typeof import('../../server/utils/auth')
}

describe.skipIf(!DB)('异常闭环与看板', () => {
  let db: PrismaClient
  let s: Services
  let uploadDir: string
  const WO = 'T-WO-R5'
  const WO2 = 'T-WO-R5-B' // 另一个项目经理的工单
  const at = (base: Date | number, ms: number) => new Date(+base + ms)
  const admin = { userId: 'u-admin', isAdmin: true }
  const as = (userId: string) => ({ userId, isAdmin: false })

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
      digest: await import('../../server/services/alerts/digest'),
      issues: await import('../../server/services/issues/issues'),
      nonconforming: await import('../../server/services/issues/nonconforming'),
      kit: await import('../../server/services/kitting/kitting'),
      board: await import('../../server/services/issues/board'),
      uploads: await import('../../server/services/issues/uploads'),
      auth: await import('../../server/utils/auth'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    uploadDir = await mkdtemp(join(tmpdir(), 'ft-uploads-'))
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.uploadFile.deleteMany()
    await db.issue.deleteMany() // 处理日志级联删除
    await db.notifyRole.deleteMany()
    await db.workOrderExt.deleteMany()
    await db.offDay.deleteMany()
    await db.threshold.deleteMany() // 表里没有时用默认值
    await db.syncCursor.deleteMany()
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
    await db.deptMapping.deleteMany()
    await db.qmsUser.deleteMany()

    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [WO, WO2].map((wo) => ({ workOrderNumber: wo, customerName: '测试客户', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
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
        { id: 'P-ASSY', name: '装配', supplierSource: 'Supplier', updatedAt: now },
      ],
    })
    await db.qmsDepartment.createMany({
      data: ['技术部', '采购部', '财务部', '质量部', '生产部', '项目部'].map((name, i) => ({ id: `D-${i}`, name, parentId: '0', status: 1, updatedAt: now })),
    })
    // QMS 用户的部门存部门 ID（D-n）；公司领导、信息部没有部门记录
    const deptId = (name: string) => {
      const i = ['技术部', '采购部', '财务部', '质量部', '生产部', '项目部'].indexOf(name)
      return i < 0 ? `D-NONE-${name}` : `D-${i}`
    }
    const user = (id: string, realName: string, department: string) => ({ id, username: id, realName, departmentId: deptId(department), roleId: 'r', status: 'ACTIVE', updatedAt: now })
    await db.qmsUser.createMany({
      data: [
        user('u-out', '外协专员', '生产部'),
        user('u-head', '生产部负责人', '生产部'),
        user('u-qa', '质量部负责人', '质量部'),
        user('u-qa2', '质量员', '质量部'),
        user('u-pm', '项目经理', '项目部'),
        user('u-pm2', '另一个项目经理', '项目部'),
        user('u-pdh', '项目部负责人', '项目部'),
        user('u-lead', '分管领导', '公司领导'),
        user('u-worker', '一线员工', '生产部'),
        user('u-admin', '管理员', '信息部'),
      ],
    })
    await db.notifyRole.createMany({
      data: [
        { role: 'OUTSOURCE_COORDINATOR', userId: 'u-out' },
        { role: 'DEPT_HEAD', userId: 'u-head', department: '生产部' },
        { role: 'DEPT_HEAD', userId: 'u-qa', department: '质量部' },
        { role: 'PROJECT_DEPT_HEAD', userId: 'u-pdh' },
        { role: 'LEADER', userId: 'u-lead' },
      ],
    })
    await db.workOrderExt.createMany({
      data: [
        { workOrderNumber: WO, projectManagerId: 'u-pm' },
        { workOrderNumber: WO2, projectManagerId: 'u-pm2' },
      ],
    })
  })

  afterAll(async () => {
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true })
    await db?.$disconnect()
  })

  let seqNo = 0
  /** 组焊（厂外）→ 涂装（厂外）→ 装配（自制），负责人外协专员 / 生产部负责人 */
  async function makePart(wo = WO) {
    seqNo++
    const part = await s.steps.createPart(wo, { name: `R5件-${seqNo}`, quantity: 2, qmsPartId: `BOM-R5-${seqNo}` })
    const weld = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-WELD' }, 'u-out')
    const paint = await s.steps.addStep(part.id, { processId: 'P-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-PAINT' }, 'u-out')
    const assy = await s.steps.addStep(part.id, { processId: 'P-ASSY', mode: 'SELF' }, 'u-head')
    return { part, weld, paint, assy }
  }
  const today = () => new Date(`${s.rules.shanghaiDay(new Date())}T00:00:00.000Z`)
  const send = (stepId: string, promisedReturnDate = new Date(+today() + 7 * DAY)) =>
    s.flow.sendStep({ stepId, promisedReturnDate, actorId: 'u-out', source: 'MOBILE' })
  const report = (over: Partial<Parameters<Services['issues']['createIssue']>[0]> = {}, reporter = 'u-worker') =>
    s.issues.createIssue({ workOrderNumber: WO, category: 'WORKSHOP', description: '装配缺螺栓', ...over }, reporter)

  /** 模拟 QMS：一条能匹配上的返厂报检，可选直接判不合格（QMS 实际行为：FAIL + 问题单，状态仍是检验中） */
  async function inspect(p: Awaited<ReturnType<typeof makePart>>, opts: { qty?: number; fail?: number } = {}) {
    const id = `T-INS-${randomBytes(4).toString('hex')}`
    await db.qmsInspection.create({
      data: {
        id,
        requestNo: `RQ-${id}`,
        workOrderNumber: p.part.workOrderNumber,
        partId: p.part.qmsPartId,
        partName: p.part.name,
        processId: 'P-WELD',
        processName: '组焊',
        supplierId: 'S-WELD',
        supplierName: '组焊厂',
        quantity: opts.qty ?? 2,
        status: opts.fail !== undefined ? 'INSPECTING' : 'SUBMITTED',
        inspectionResult: opts.fail !== undefined ? 'FAIL' : 'PASS',
        unqualifiedQuantity: opts.fail ?? null,
        linkedIssueNo: opts.fail !== undefined ? `QI-${id}` : null,
        submittedAt: new Date(),
        closedAt: null,
        updatedAt: new Date(),
      },
    })
    return id
  }
  const issueOf = (id: string) => db.issue.findUniqueOrThrow({ where: { id } })
  const logsOf = async (id: string) => (await db.issueLog.findMany({ where: { issueId: id }, orderBy: { createdAt: 'asc' } })).map((l) => `${l.fromStatus ?? '-'}>${l.toStatus ?? '-'}`)

  it('上报：编号 YC-YYMMDD-NNN、按分类默认责任部门和部门负责人、外协单位只给外协分类', async () => {
    const a = await report()
    const b = await report({ category: 'OUTSOURCE_QUALITY', responsibleSupplierId: 'S-WELD' })
    const prefix = `YC-${s.rules.shanghaiDay(new Date()).slice(2).replaceAll('-', '')}-`
    expect(a.issueNo).toMatch(new RegExp(`^${prefix}\\d{3}$`))
    expect(Number(b.issueNo.slice(prefix.length))).toBe(Number(a.issueNo.slice(prefix.length)) + 1)
    expect(a).toMatchObject({ source: 'MANUAL', status: 'OPEN', reporterId: 'u-worker', responsibleDeptId: 'D-4', responsibleUserId: 'u-head' }) // 车间 → 生产部
    expect(b).toMatchObject({ responsibleDeptId: 'D-3', responsibleUserId: 'u-qa', responsibleSupplierId: 'S-WELD' }) // 外协-质量 → 质量部
    const c = await report({ category: 'DESIGN' }) // 技术部没有负责人 → 责任人为空
    expect(c).toMatchObject({ responsibleDeptId: 'D-0', responsibleUserId: null })
    await expect(report({ category: 'DESIGN', responsibleSupplierId: 'S-WELD' })).rejects.toThrow('外协单位')
    await expect(report({ workOrderNumber: 'NOPE' })).rejects.toThrow('工单不存在')
    expect(await logsOf(a.id)).toEqual(['->OPEN'])

    // 编号并发：同时上报 5 条，编号各不相同（撞唯一键的自动重试）
    const many = await Promise.all(Array.from({ length: 5 }, () => report()))
    expect(new Set(many.map((m) => m.issueNo)).size).toBe(5)
  })

  it('状态机全流程：受理（默认要求解决日 +3 天）→ 处理 → 退回 → 处理 → 关闭；非法迁移报错', async () => {
    const issue = await report()
    // 非法迁移
    await expect(s.issues.resolveIssue(issue.id, admin, '已处理')).rejects.toThrow('不能填写处理结果')
    await expect(s.issues.closeIssue(issue.id, admin)).rejects.toThrow('不能确认关闭')
    await expect(s.issues.rejectIssue(issue.id, admin, '不行')).rejects.toThrow('不能退回')

    await s.issues.acceptIssue(issue.id, as('u-head'))
    const accepted = await issueOf(issue.id)
    expect(accepted.status).toBe('ACCEPTED')
    expect(s.rules.dateFieldDay(accepted.dueDate!)).toBe(s.rules.shanghaiDay(Date.now() + 3 * DAY))
    await expect(s.issues.acceptIssue(issue.id, as('u-head'))).rejects.toThrow('不能受理')
    await expect(s.issues.resolveIssue(issue.id, as('u-head'), '  ')).rejects.toThrow('请填写处理结果')

    await s.issues.resolveIssue(issue.id, as('u-head'), '已补发螺栓')
    await s.issues.rejectIssue(issue.id, as('u-worker'), '数量不够')
    expect((await issueOf(issue.id)).status).toBe('ACCEPTED')
    await s.issues.resolveIssue(issue.id, as('u-head'), '再次补发')
    await s.issues.addIssueNote(issue.id, as('u-pm'), '看过了')
    await s.issues.closeIssue(issue.id, as('u-worker'), '确认')
    expect((await issueOf(issue.id)).status).toBe('CLOSED')
    await expect(s.issues.acceptIssue(issue.id, admin)).rejects.toThrow('已关闭')
    expect(await logsOf(issue.id)).toEqual(['->OPEN', 'OPEN>ACCEPTED', 'ACCEPTED>RESOLVED', 'RESOLVED>ACCEPTED', 'ACCEPTED>RESOLVED', '->-', 'RESOLVED>CLOSED'])

    const detail = await s.issues.getIssue(issue.id, as('u-worker'))
    expect(detail.logs.map((l) => l.actorName)).toEqual(['一线员工', '生产部负责人', '生产部负责人', '一线员工', '生产部负责人', '项目经理', '一线员工'])
    expect(detail.logs[2]!.note).toBe('处理结果：已补发螺栓')
  })

  it('权限：受理/处理、改派、确认关闭/退回各自的人；无权 403（FlowForbidden）', async () => {
    const { FlowForbidden } = await import('../../server/services/flow/errors')
    const issue = await report() // 生产部 / u-head，上报人 u-worker，项目经理 u-pm
    // 受理：责任人、责任部门负责人、管理员；其他人（含项目经理、别的部门负责人）不行
    for (const who of ['u-pm', 'u-qa', 'u-worker', 'u-pdh']) await expect(s.issues.acceptIssue(issue.id, as(who))).rejects.toBeInstanceOf(FlowForbidden)
    // 改派：责任部门负责人、项目经理、项目部负责人、管理员；一线、别的工单的项目经理不行
    for (const who of ['u-worker', 'u-pm2', 'u-out']) await expect(s.issues.reassignIssue(issue.id, as(who), { responsibleUserId: 'u-out' })).rejects.toBeInstanceOf(FlowForbidden)
    await s.issues.reassignIssue(issue.id, as('u-pm'), { responsibleUserId: 'u-out', dueDate: new Date(+today() + 5 * DAY) })
    expect(await issueOf(issue.id)).toMatchObject({ status: 'OPEN', responsibleUserId: 'u-out' })
    await expect(s.issues.reassignIssue(issue.id, as('u-pdh'), {})).rejects.toThrow('没有修改任何内容')
    // 改责任部门不指定人：默认新部门负责人
    await s.issues.reassignIssue(issue.id, as('u-pdh'), { responsibleDeptId: 'D-3' })
    expect(await issueOf(issue.id)).toMatchObject({ responsibleDeptId: 'D-3', responsibleUserId: 'u-qa' })
    // 现在责任人 u-qa：原生产部负责人不能再受理
    await expect(s.issues.acceptIssue(issue.id, as('u-head'))).rejects.toBeInstanceOf(FlowForbidden)
    await s.issues.acceptIssue(issue.id, as('u-qa'))
    await expect(s.issues.resolveIssue(issue.id, as('u-pm'), 'x')).rejects.toBeInstanceOf(FlowForbidden)
    await s.issues.resolveIssue(issue.id, as('u-qa'), '处理好了')
    // 确认关闭/退回：上报人、项目经理、项目部负责人、管理员；责任人自己不行
    for (const who of ['u-qa', 'u-head', 'u-pm2']) {
      await expect(s.issues.closeIssue(issue.id, as(who))).rejects.toBeInstanceOf(FlowForbidden)
      await expect(s.issues.rejectIssue(issue.id, as(who), '不行')).rejects.toBeInstanceOf(FlowForbidden)
    }
    await s.issues.rejectIssue(issue.id, as('u-pdh'), '再看看')
    await s.issues.resolveIssue(issue.id, admin, '管理员代处理')
    await s.issues.closeIssue(issue.id, as('u-pm'))
    expect((await issueOf(issue.id)).status).toBe('CLOSED')

    // 列表上的 can 与服务端判断一致
    const fresh = await report()
    const [row] = (await s.issues.listIssues({ workOrderNumber: WO, status: 'OPEN' }, as('u-head'))).filter((r) => r.id === fresh.id)
    expect(row!.can).toMatchObject({ accept: true, reassign: true, close: false })
    const [pmRow] = (await s.issues.listIssues({ workOrderNumber: WO, status: 'OPEN' }, as('u-pm'))).filter((r) => r.id === fresh.id)
    expect(pmRow!.can).toMatchObject({ accept: false, reassign: true })
  })

  it('并发：同一条异常同时受理两次，只成功一次', async () => {
    const issue = await report()
    const results = await Promise.allSettled([s.issues.acceptIssue(issue.id, as('u-head')), s.issues.acceptIssue(issue.id, admin), s.issues.acceptIssue(issue.id, as('u-head'))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter((x) => x.status === 'rejected')) expect(String((r as PromiseRejectedResult).reason?.message)).toMatch(/状态已变化|不能受理/)
    expect(await logsOf(issue.id)).toEqual(['->OPEN', 'OPEN>ACCEPTED'])
  })

  it('QMS 不合格（A7）：重复扫两次只一条；步骤有异常，W2 不计时；关闭后步骤恢复已完成', async () => {
    const p = await makePart()
    await send(p.weld.id)
    const ins = await inspect(p)
    expect((await s.match.matchInspection(ins)).status).toBe('matched')
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: p.weld.id } })).status).toBe('DONE')

    // 判定前（QMS 默认 PASS、检验中）不生成
    await db.qmsInspection.update({ where: { id: ins }, data: { status: 'INSPECTING' } })
    expect((await s.nonconforming.syncNonconforming()).created.filter((c) => c.inspectionId === ins)).toHaveLength(0)
    // QMS 判不合格：FAIL + 不合格数量，状态仍是检验中、没有关闭时间
    await db.qmsInspection.update({ where: { id: ins }, data: { inspectionResult: 'FAIL', unqualifiedQuantity: 1 } })
    // 并发两次 + 再一次：只一条
    const [r1, r2] = await Promise.all([s.nonconforming.syncNonconforming(), s.nonconforming.syncNonconforming()])
    await s.nonconforming.syncNonconforming()
    expect([...r1.created, ...r2.created].filter((c) => c.inspectionId === ins)).toHaveLength(1)
    const issues = await db.issue.findMany({ where: { sourceKey: `QMS:${ins}` } })
    expect(issues).toHaveLength(1)
    const issue = issues[0]!
    expect(issue).toMatchObject({
      source: 'QMS_NONCONFORMING',
      category: 'OUTSOURCE_QUALITY',
      responsibleSupplierId: 'S-WELD',
      responsibleDeptId: 'D-3',
      responsibleUserId: 'u-qa',
      refType: 'STEP',
      refId: p.weld.id,
      reporterId: null,
      status: 'OPEN',
    })
    expect(issue.description).toContain(`RQ-${ins}`)
    expect(issue.description).toContain('不合格 1 件')
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: p.weld.id } })).status).toBe('BLOCKED')
    // 工件页能看到"有异常"并跳到该异常
    const parts = await s.steps.listParts(WO)
    expect(parts.find((x) => x.id === p.part.id)!.steps[0]!.issues).toEqual([{ id: issue.id, issueNo: issue.issueNo }])

    // 上一道有异常：涂装的"安排发出"待办不计 W2
    const todo = await db.todo.findFirstOrThrow({ where: { refType: 'step', refId: p.paint.id, status: 'OPEN' } })
    await s.scan.scanRules(at(todo.createdAt, 5 * DAY))
    expect(await db.alert.count({ where: { rule: 'W2', refId: p.paint.id } })).toBe(0)

    // 没有上报人：质量部负责人受理处理，项目经理确认关闭 → 步骤恢复已完成；之后 W2 从关闭时刻重新计时
    await expect(s.issues.closeIssue(issue.id, as('u-pm'))).rejects.toThrow('不能确认关闭')
    await s.issues.acceptIssue(issue.id, as('u-qa'))
    await s.issues.resolveIssue(issue.id, as('u-qa'), '返修合格')
    const closed = await s.issues.closeIssue(issue.id, as('u-pm'))
    expect(closed.stepRestored).toBe('DONE')
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: p.weld.id } })).status).toBe('DONE')
    const closedAt = (await db.issueLog.findFirstOrThrow({ where: { issueId: issue.id, toStatus: 'CLOSED' } })).createdAt
    await s.scan.scanRules(at(closedAt, 2 * DAY - HOUR))
    expect(await db.alert.count({ where: { rule: 'W2', refId: p.paint.id } })).toBe(0)
    await s.scan.scanRules(at(closedAt, 2 * DAY))
    expect((await db.alert.findFirstOrThrow({ where: { rule: 'W2', refId: p.paint.id } })).level).toBe('YELLOW')
  })

  it('QMS 不合格：部分返回时被拦下，两条异常都关闭才恢复；未匹配的报检人工关联后才生成', async () => {
    const p = await makePart()
    await send(p.weld.id)
    const ins1 = await inspect(p, { qty: 1, fail: 1 })
    await s.match.matchInspection(ins1)
    const created = (await s.nonconforming.syncNonconforming()).created.filter((c) => c.stepId === p.weld.id)
    expect(created).toHaveLength(1)
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: p.weld.id } })).status).toBe('BLOCKED')
    // 第二条报检对不上（名称写错）→ 待确认；人工关联前不生成异常
    const ins2 = `T-INS-${randomBytes(4).toString('hex')}`
    await db.qmsInspection.create({
      data: {
        id: ins2, requestNo: `RQ-${ins2}`, workOrderNumber: WO, partName: '写错的名字', processName: '组焊', quantity: 1,
        status: 'INSPECTING', inspectionResult: 'FAIL', unqualifiedQuantity: 1, submittedAt: new Date(), updatedAt: new Date(),
      },
    })
    expect((await s.match.matchInspection(ins2)).status).toBe('unmatched')
    expect((await s.nonconforming.syncNonconforming()).created.filter((c) => c.inspectionId === ins2)).toHaveLength(0)
    // 有异常的步骤不在自动匹配候选里，人工关联到它：只记事件
    await s.match.resolveUnmatched(ins2, p.weld.id, 'u-out')
    const c2 = (await s.nonconforming.syncNonconforming()).created.filter((c) => c.inspectionId === ins2)
    expect(c2).toHaveLength(1)

    const close = async (id: string) => {
      await s.issues.acceptIssue(id, as('u-qa'))
      await s.issues.resolveIssue(id, as('u-qa'), '返修')
      return s.issues.closeIssue(id, admin)
    }
    expect((await close(created[0]!.issueId)).stepRestored).toBeNull() // 还有一条未关闭
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: p.weld.id } })).status).toBe('BLOCKED')
    expect((await close(c2[0]!.issueId)).stepRestored).toBe('DONE') // 两次返厂共 2 件 = 全部返回
    const part = await db.part.findUniqueOrThrow({ where: { id: p.part.id } })
    expect(part.currentStepId).toBe(p.paint.id) // 工件指针推进到下一道
  })

  it('并发：同一步骤上两条不合格异常同时关闭，步骤仍恢复（不会两边都以为对方未关闭）', async () => {
    const p = await makePart()
    await send(p.weld.id)
    const ins1 = await inspect(p, { qty: 1, fail: 1 })
    await s.match.matchInspection(ins1)
    const ins2 = `T-INS-${randomBytes(4).toString('hex')}`
    await db.qmsInspection.create({
      data: {
        id: ins2, requestNo: `RQ-${ins2}`, workOrderNumber: WO, partName: '写错的名字', processName: '组焊', quantity: 1,
        status: 'INSPECTING', inspectionResult: 'FAIL', unqualifiedQuantity: 1, submittedAt: new Date(), updatedAt: new Date(),
      },
    })
    await s.match.matchInspection(ins2)
    await s.match.resolveUnmatched(ins2, p.weld.id, 'u-out')
    const created = (await s.nonconforming.syncNonconforming()).created.filter((c) => c.stepId === p.weld.id)
    expect(created).toHaveLength(2)
    for (const c of created) {
      await s.issues.acceptIssue(c.issueId, as('u-qa'))
      await s.issues.resolveIssue(c.issueId, as('u-qa'), '返修')
    }
    const results = await Promise.all(created.map((c) => s.issues.closeIssue(c.issueId, admin)))
    expect(results.filter((r) => r.stepRestored === 'DONE')).toHaveLength(1)
    expect((await db.routeStep.findUniqueOrThrow({ where: { id: p.weld.id } })).status).toBe('DONE')
  })

  it('final-step rejection withdraws kitting until every related issue is closed, including legacy DONE flags', async () => {
    const part = await s.steps.createPart(WO, { name: 'Final rejection regression', quantity: 2, qmsPartId: `FINAL-${randomBytes(4).toString('hex')}` })
    const step = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-WELD' }, 'u-out')
    const node = await db.assemblyNode.create({
      data: { workOrderNumber: WO, name: 'Rejected part kit', needDate: today(), parts: { create: { partId: part.id } } }, include: s.kit.NODE_LINKS,
    })
    const view = async () => (await s.kit.loadKits([node], new Date())).get(node.id)!
    try {
      await send(step.id)
      const inspectionId = `FINAL-INS-${randomBytes(4).toString('hex')}`
      await db.qmsInspection.create({ data: {
        id: inspectionId, requestNo: inspectionId, workOrderNumber: WO, partId: part.qmsPartId, partName: part.name,
        processId: 'P-WELD', processName: '组焊', supplierId: 'S-WELD', quantity: 2, status: 'INSPECTING',
        inspectionResult: 'FAIL', unqualifiedQuantity: 1, submittedAt: new Date(Date.now() + 1000), updatedAt: new Date(),
      } })
      expect((await s.match.matchInspection(inspectionId)).status).toBe('matched')
      expect((await db.part.findUniqueOrThrow({ where: { id: part.id } })).status).toBe('DONE')
      expect(await view()).toMatchObject({ ready: 1, percent: 100 })
      const created = (await s.nonconforming.syncNonconforming()).created.find((r) => r.inspectionId === inspectionId)!
      expect(created).toBeDefined()
      expect((await db.part.findUniqueOrThrow({ where: { id: part.id } })).status).toBe('ACTIVE')
      expect(await view()).toMatchObject({ ready: 0, percent: 0, shortages: [{ reasonCode: 'BLOCKED' }] })
      expect((await s.nonconforming.syncNonconforming()).created).toHaveLength(0)

      // Existing inconsistent rows must be excluded even before any repair/write has touched them.
      await db.part.update({ where: { id: part.id }, data: { status: 'DONE' } })
      expect((await s.kit.loadKitCounts([node])).get(node.id)).toMatchObject({ ready: 0, readyDay: null })
      expect(await view()).toMatchObject({ ready: 0, shortages: [{ reasonCode: 'BLOCKED' }] })
      expect(await db.assemblyNode.count({ where: { AND: [{ id: node.id }, s.kit.incompleteWhere()] } })).toBe(1)
      expect((await s.kit.nodeOptions(WO)).parts.find((p) => p.id === part.id)?.ready).toBe(false)

      const second = await s.issues.issueTransaction((tx) => s.issues.createSystemIssue(tx, {
        sourceKey: `TEST-REJECTION:${step.id}`, source: 'QMS_NONCONFORMING', workOrderNumber: WO,
        category: 'OUTSOURCE_QUALITY', refType: 'STEP', refId: step.id, description: 'Second rejection', note: 'Second rejection',
      }))
      const close = async (id: string) => {
        await s.issues.acceptIssue(id, admin)
        await s.issues.resolveIssue(id, admin, 'Reinspection accepted')
        return s.issues.closeIssue(id, admin)
      }
      expect((await close(created.issueId)).stepRestored).toBeNull()
      expect(await view()).toMatchObject({ ready: 0 })
      expect((await close(second.id)).stepRestored).toBe('DONE')
      expect((await db.part.findUniqueOrThrow({ where: { id: part.id } })).status).toBe('DONE')
      expect(await view()).toMatchObject({ ready: 1, percent: 100, shortages: [] })
      expect(await db.assemblyNode.count({ where: { AND: [{ id: node.id }, s.kit.incompleteWhere()] } })).toBe(0)
    } finally {
      await db.assemblyNode.delete({ where: { id: node.id } })
    }
  })

  it('reconciles completion after deleting unused processes or appending a new one', async () => {
    const part = await s.steps.createPart(WO, { name: 'Route edit regression', quantity: 2 })
    const first = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'SELF' }, 'u-head')
    const last = await s.steps.addStep(part.id, { processId: 'P-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-PAINT' }, 'u-out')
    const state = async () => (await db.part.findUniqueOrThrow({ where: { id: part.id } })).status
    await send(last.id)
    await s.flow.manualReturn({ stepId: last.id, qty: 2, actorId: 'u-out', source: 'PC' })
    expect(await state()).toBe('ACTIVE')
    await s.steps.deleteStep(first.id)
    expect(await state()).toBe('DONE')
    const appended = await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'SELF' }, 'u-head')
    expect(await state()).toBe('ACTIVE')
    await s.steps.deleteStep(appended.id)
    expect(await state()).toBe('DONE')
    const empty = await s.steps.createPart(WO, { name: 'Empty route regression', quantity: 1 })
    const unused = await s.steps.addStep(empty.id, { processId: 'P-WELD', mode: 'SELF' }, 'u-head')
    await s.steps.deleteStep(unused.id)
    expect((await db.part.findUniqueOrThrow({ where: { id: empty.id } })).status).toBe('ACTIVE')
  })

  it('红色自动转异常（A4）：同事务生成异常、预警已转异常；不再重复生成预警、不再通知', async () => {
    const p = await makePart()
    await send(p.weld.id)
    await s.flow.manualReturn({ stepId: p.weld.id, qty: 2, actorId: 'u-out', source: 'MOBILE' })
    const t0 = (await db.todo.findFirstOrThrow({ where: { refType: 'step', refId: p.paint.id, status: 'OPEN' } })).createdAt
    const key = `W2:step:${p.paint.id}`
    await s.scan.scanRules(at(t0, 2 * DAY))
    const r = await s.scan.scanRules(at(t0, 4 * DAY))
    expect(r.converted).toBeGreaterThanOrEqual(1)
    const alert = await db.alert.findUniqueOrThrow({ where: { activeKey: key } })
    expect(alert).toMatchObject({ level: 'RED', status: 'CONVERTED' })
    const issue = await db.issue.findUniqueOrThrow({ where: { sourceKey: `ALERT:${alert.id}` } })
    expect(issue).toMatchObject({ source: 'ALERT', category: 'OUTSOURCE_SCHEDULE', responsibleUserId: 'u-out', responsibleSupplierId: 'S-PAINT', refType: 'STEP', refId: p.paint.id, reporterId: null })
    expect(issue.description).toContain('仍未发出')
    const reminders = await db.reminder.count({ where: { alertId: alert.id } })

    // 再扫：不新建预警、不再通知、不再生成异常
    await s.scan.scanRules(at(t0, 6 * DAY))
    await s.scan.scanRules(at(t0, 8 * DAY))
    expect(await db.alert.count({ where: { rule: 'W2', refId: p.paint.id } })).toBe(1)
    expect(await db.reminder.count({ where: { alertId: alert.id } })).toBe(reminders)
    expect(await db.issue.count({ where: { source: 'ALERT', refId: p.paint.id } })).toBe(1)
    // 预警列表：显示已转异常
    const list = await s.reminders.listAlerts({ workOrderNumber: WO })
    expect(list.find((a) => a.id === alert.id)).toMatchObject({ status: 'CONVERTED', issue: { id: issue.id, issueNo: issue.issueNo }, canConvert: false })

    // 自制步骤停滞 → 分类"车间"
    const q = await makePart()
    for (const st of [q.weld, q.paint]) {
      await send(st.id)
      await s.flow.manualReturn({ stepId: st.id, qty: 2, actorId: 'u-out', source: 'MOBILE' })
    }
    const t1 = (await db.todo.findFirstOrThrow({ where: { refType: 'step', refId: q.assy.id, status: 'OPEN' } })).createdAt
    await s.scan.scanRules(at(t1, 4 * DAY))
    const a2 = await db.alert.findUniqueOrThrow({ where: { activeKey: `W2:step:${q.assy.id}` } })
    expect((await db.issue.findUniqueOrThrow({ where: { sourceKey: `ALERT:${a2.id}` } })).category).toBe('WORKSHOP')
  })

  it('黄色手动转：责任人、项目经理、管理员可点；其他人 403；重复点只成功一次', async () => {
    const { FlowForbidden } = await import('../../server/services/flow/errors')
    const p = await makePart()
    await send(p.weld.id)
    await s.flow.manualReturn({ stepId: p.weld.id, qty: 2, actorId: 'u-out', source: 'MOBILE' })
    const t0 = (await db.todo.findFirstOrThrow({ where: { refType: 'step', refId: p.paint.id, status: 'OPEN' } })).createdAt
    await s.scan.scanRules(at(t0, 2 * DAY))
    const alert = await db.alert.findUniqueOrThrow({ where: { activeKey: `W2:step:${p.paint.id}` } })
    expect(alert.level).toBe('YELLOW')

    const rows = await s.reminders.listAlerts({ workOrderNumber: WO, viewer: as('u-out') })
    expect(rows.find((a) => a.id === alert.id)!.canConvert).toBe(true)
    expect((await s.reminders.listAlerts({ workOrderNumber: WO, viewer: as('u-worker') })).find((a) => a.id === alert.id)!.canConvert).toBe(false)
    await expect(s.reminders.convertAlert(alert.id, as('u-worker'))).rejects.toBeInstanceOf(FlowForbidden)
    await expect(s.reminders.convertAlert(alert.id, as('u-pm2'))).rejects.toBeInstanceOf(FlowForbidden)
    // 别的工单的项目经理看不到
    await expect(s.reminders.convertAlert(alert.id, as('u-pm2'), [WO2])).rejects.toThrow('无权查看')

    const results = await Promise.allSettled([s.reminders.convertAlert(alert.id, as('u-pm')), s.reminders.convertAlert(alert.id, as('u-out'))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const issue = await db.issue.findUniqueOrThrow({ where: { sourceKey: `ALERT:${alert.id}` } })
    expect(issue.source).toBe('ALERT')
    expect(['u-pm', 'u-out']).toContain(issue.reporterId) // 手动转的，点按钮的人是上报人（可确认关闭）
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe('CONVERTED')
    await expect(s.reminders.convertAlert(alert.id, admin)).rejects.toThrow('已经转为异常')

    // 已转异常的黄色预警到了红色阈值也不再升级、不再通知
    const before = await db.reminder.count({ where: { alertId: alert.id } })
    await s.scan.scanRules(at(t0, 5 * DAY))
    expect(await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ level: 'YELLOW', status: 'CONVERTED' })
    expect(await db.reminder.count({ where: { alertId: alert.id } })).toBe(before)
    expect(await db.issue.count({ where: { source: 'ALERT', refId: p.paint.id } })).toBe(1)

    // 红色不能手动转（会自动转）；W4 不能转
    const p2 = await makePart()
    await send(p2.weld.id)
    await s.flow.manualReturn({ stepId: p2.weld.id, qty: 2, actorId: 'u-out', source: 'MOBILE' })
    const t2 = (await db.todo.findFirstOrThrow({ where: { refType: 'step', refId: p2.paint.id, status: 'OPEN' } })).createdAt
    await s.scan.scanRules(at(t2, 4 * DAY))
    const red = await db.alert.findUniqueOrThrow({ where: { activeKey: `W2:step:${p2.paint.id}` } })
    await expect(s.reminders.convertAlert(red.id, admin)).rejects.toThrow('已经转为异常')
  })

  it('W4：待受理满 1 天黄；过要求解决日 1 天黄、3 天红（不转异常）；待确认消除', async () => {
    const issue = await report()
    const key = `W4:issue:${issue.id}`
    const c = issue.createdAt
    await s.scan.scanRules(at(c, DAY - 1000))
    expect(await db.alert.count({ where: { activeKey: key } })).toBe(0)
    await s.scan.scanRules(at(c, DAY))
    const yellow = await db.alert.findUniqueOrThrow({ where: { activeKey: key } })
    expect(yellow).toMatchObject({ rule: 'W4', refType: 'issue', level: 'YELLOW' })
    // 黄：责任人 + 责任部门（生产部）负责人 + 项目经理
    expect((await db.reminder.findMany({ where: { alertId: yellow.id } })).map((r) => r.userId).sort()).toEqual(['u-head', 'u-pm'])
    const mine = await s.reminders.listReminders('u-pm')
    expect(mine.items.find((i) => i.alertId === yellow.id)).toMatchObject({ rule: 'W4', link: `/issues?id=${issue.id}`, mobileLink: `/m/issues?id=${issue.id}` })

    // 受理后"待受理超时"解除；要求解决日昨天 → 超期 1 天黄；再过 2 天 → 红，通知项目部负责人、领导，不转异常
    const yesterday = new Date(+today() - DAY)
    await s.issues.acceptIssue(issue.id, as('u-head'), { dueDate: yesterday })
    expect(await db.alert.findUniqueOrThrow({ where: { id: yellow.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
    const now = new Date()
    await s.scan.scanRules(now)
    expect((await db.alert.findUniqueOrThrow({ where: { activeKey: key } })).level).toBe('YELLOW')
    await s.scan.scanRules(at(now, 2 * DAY))
    const red = await db.alert.findUniqueOrThrow({ where: { activeKey: key } })
    expect(red).toMatchObject({ level: 'RED', status: 'ACTIVE' })
    expect((await db.reminder.findMany({ where: { alertId: red.id, level: 'RED' } })).map((r) => r.userId).sort()).toEqual(['u-head', 'u-lead', 'u-pdh', 'u-pm'])
    expect(await db.issue.count({ where: { sourceKey: `ALERT:${red.id}` } })).toBe(0)
    const row = (await s.issues.listIssues({ workOrderNumber: WO }, admin, at(now, 2 * DAY))).find((r) => r.id === issue.id)!
    expect(row).toMatchObject({ overdue: true, overdueDays: 3, alertLevel: 'RED' })

    // 填处理结果（待确认）→ 立即消除；再扫描不再出现
    await s.issues.resolveIssue(issue.id, as('u-head'), '处理完')
    expect(await db.alert.findUniqueOrThrow({ where: { id: red.id } })).toMatchObject({ status: 'CLEARED', activeKey: null })
    await s.scan.scanRules(at(now, 5 * DAY))
    expect(await db.alert.count({ where: { refId: issue.id, status: 'ACTIVE' } })).toBe(0)

    // 没有责任人：通知项目部负责人
    const orphan = await report({ category: 'DESIGN' })
    await s.scan.scanRules(at(orphan.createdAt, DAY))
    const oa = await db.alert.findUniqueOrThrow({ where: { activeKey: `W4:issue:${orphan.id}` } })
    expect((await db.reminder.findMany({ where: { alertId: oa.id } })).map((r) => r.userId)).toContain('u-pdh')
  })

  it('可见范围：项目经理只看自己负责的工单；有角色、没负责工单的看全部', async () => {
    const pm2 = await s.auth.resolveScope('u-pm2', false)
    expect(pm2).toEqual({ all: false, workOrders: new Set([WO2]) })
    expect(s.auth.canSee(pm2, WO)).toBe(false)
    expect(s.auth.canSee(pm2, WO2)).toBe(true)
    expect(s.auth.canSee(pm2, null)).toBe(true)
    expect((await s.auth.resolveScope('u-pm2', true)).all).toBe(true) // 管理员
    for (const u of ['u-worker', 'u-head', 'u-pdh', 'u-lead', 'u-out']) expect((await s.auth.resolveScope(u, false)).all).toBe(true)
    // 既是项目经理又有角色 → 全部
    await db.workOrderExt.update({ where: { workOrderNumber: WO2 }, data: { projectManagerId: 'u-head' } })
    expect((await s.auth.resolveScope('u-head', false)).all).toBe(true)
    await db.workOrderExt.update({ where: { workOrderNumber: WO2 }, data: { projectManagerId: 'u-pm2' } })

    // 列表过滤
    const other = await report({ workOrderNumber: WO2 })
    const visible = s.auth.scopeWorkOrders(pm2)
    const rows = await s.issues.listIssues({ visibleWorkOrders: visible }, as('u-pm2'))
    expect(rows.every((r) => r.workOrderNumber === WO2)).toBe(true)
    expect(rows.some((r) => r.id === other.id)).toBe(true)
    const board = await s.board.getBoard(visible)
    expect(board.rows.map((r) => r.workOrderNumber)).toEqual([WO2])
  })

  it('异常列表分批读取：相同时间的第 501 条待办与超期记录不遗漏，可见范围仍有效', async () => {
    const workOrderNumber = `${WO}-LIST`
    const time = new Date('2026-10-28T04:00:00Z')
    const prefix = `list-${randomBytes(5).toString('hex')}`
    await db.qmsWorkOrder.create({ data: { workOrderNumber, customerName: '列表完整性测试', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: time } })
    try {
      await db.issue.createMany({ data: Array.from({ length: 501 }, (_, i) => ({
        id: `${prefix}-${String(500 - i).padStart(3, '0')}`,
        issueNo: `${prefix}-${i}`,
        workOrderNumber,
        category: 'OTHER' as const,
        description: 'List completeness regression',
        source: 'MANUAL' as const,
        status: 'ACCEPTED' as const,
        responsibleUserId: i === 500 ? 'u-worker' : 'u-out',
        dueDate: i === 500 ? new Date('2026-10-25') : null,
        createdAt: time,
        updatedAt: time,
      })) })
      const targetId = `${prefix}-000`
      const filter = { workOrderNumber, visibleWorkOrders: [workOrderNumber] }
      const all = await s.issues.listIssues(filter, as('u-worker'), time)
      expect(all).toHaveLength(501)
      expect(new Set(all.map((r) => r.id)).size).toBe(501)
      expect(all[0]!.id).toBe(targetId) // Globally prioritize overdue records, including later batches.
      expect((await s.issues.listIssues({ ...filter, mine: 'todo' }, as('u-worker'), time)).map((r) => r.id)).toEqual([targetId])
      expect((await s.issues.listIssues({ ...filter, overdue: true }, as('u-worker'), time)).map((r) => r.id)).toEqual([targetId])
      expect(await s.issues.listIssues({ ...filter, visibleWorkOrders: [WO] }, admin, time)).toEqual([])
    } finally {
      await db.issue.deleteMany({ where: { workOrderNumber } })
      await db.qmsWorkOrder.delete({ where: { workOrderNumber } })
    }
  })

  it('每日汇总：07:30 前不生成；同人同日只一条；按可见范围统计；旧汇总自动已读', async () => {
    const day = s.rules.shanghaiDay(new Date())
    const bj = (hhmm: string) => new Date(`${day}T${hhmm}:00+08:00`)
    expect(await s.digest.generateDailyDigest({ now: bj('07:29') })).toMatchObject({ notYet: true, created: 0 })
    // 昨天的汇总（未读）→ 生成今天的后自动已读
    await db.reminder.create({ data: { userId: 'u-lead', kind: 'DIGEST', title: '旧汇总', dedupeKey: `DIGEST:2000-01-01:u-lead`, level: 'REMIND' } })
    const r1 = await s.digest.generateDailyDigest({ now: bj('07:30') })
    expect(r1.notYet).toBe(false)
    // 部门负责人 u-head、u-qa、项目部负责人、领导、两个项目经理
    expect(r1.recipients).toBe(6)
    expect(r1.created).toBe(6)
    const [r2, r3] = await Promise.all([s.digest.generateDailyDigest({ now: bj('08:00') }), s.digest.generateDailyDigest({ now: bj('09:15') })])
    expect(r2.created + r3.created).toBe(0)
    expect(await db.reminder.count({ where: { kind: 'DIGEST', dedupeKey: { startsWith: `DIGEST:${day}:` } } })).toBe(6)
    expect((await db.reminder.findUniqueOrThrow({ where: { dedupeKey: 'DIGEST:2000-01-01:u-lead' } })).readAt).not.toBeNull()

    // 项目经理只统计自己工单的
    const pm2 = await db.reminder.findUniqueOrThrow({ where: { dedupeKey: `DIGEST:${day}:u-pm2` } })
    const lead = await db.reminder.findUniqueOrThrow({ where: { dedupeKey: `DIGEST:${day}:u-lead` } })
    const openIssues = (title: string) => Number(/未关闭异常 (\d+) 条/.exec(title)![1])
    expect(openIssues(pm2.title)).toBe(await db.issue.count({ where: { workOrderNumber: WO2, status: { not: 'CLOSED' } } }))
    expect(openIssues(lead.title)).toBe(await db.issue.count({ where: { status: { not: 'CLOSED' } } }))
    expect(lead.body!.split('\n').length).toBeLessThanOrEqual(5)
    expect(lead.body!.split('\n')[0]).toMatch(/^【红】/) // 红优先
    expect(pm2.body).not.toContain(WO + '）')

    // 我的提醒：汇总置顶单独返回，不混在分组里；不弹窗
    const mine = await s.reminders.listReminders('u-lead')
    expect(mine.digest).toMatchObject({ id: lead.id, kind: 'DIGEST' })
    expect(mine.items.some((i) => i.id === lead.id)).toBe(false)
    expect((await s.reminders.newReminders('u-lead', new Date(Date.now() - 3 * DAY))).items.some((i) => i.id === lead.id)).toBe(false)
  })

  it('看板：红黄绿、在途、超期、未关闭异常；QMS 最后同步时间', async () => {
    expect((await s.board.getBoard(undefined)).lastSyncAt).toBeNull()
    // 最后同步时间 = 各类资源 lastSyncedAt 的最小值；有资源从没同步成功过时为空
    await db.syncCursor.create({ data: { resource: 'inspections', lastRunAt: new Date('2026-10-16T01:00:00Z'), lastSyncedAt: new Date('2026-10-16T01:00:00Z') } })
    expect((await s.board.getBoard(undefined)).lastSyncAt).toBeNull()
    for (const [i, resource] of ['work-orders', 'suppliers', 'teams', 'processes', 'departments', 'users'].entries()) {
      await db.syncCursor.create({ data: { resource, lastSyncedAt: new Date(`2026-10-16T0${i + 2}:00:00Z`) } })
    }
    await db.syncCursor.update({ where: { resource: 'users' }, data: { lastError: 'QMS 同步接口返回 503', failCount: 2 } })
    const board = await s.board.getBoard(undefined)
    expect(board.lastSyncAt).toEqual(new Date('2026-10-16T01:00:00Z'))
    expect(board.syncOldest).toBe('报检')
    expect(board.syncErrors).toEqual([{ resource: 'users', label: '用户', lastError: 'QMS 同步接口返回 503', failCount: 2 }])
    const row = board.rows.find((r) => r.workOrderNumber === WO)!
    expect(row.color).toBe('RED') // 前面的用例留下了活动红色预警
    expect(row.projectManagerName).toBe('项目经理')
    expect(row.outCount).toBe(await db.routeStep.count({ where: { status: 'OUT', part: { workOrderNumber: WO } } }))
    expect(row.openIssues).toBe(await db.issue.count({ where: { workOrderNumber: WO, status: { not: 'CLOSED' } } }))

    // 一个干净的工单：绿 → 过承诺日的在途 + 超期异常 → 黄 → 超期 3 天 → 红
    await db.qmsWorkOrder.create({ data: { workOrderNumber: 'T-WO-R5-C', customerName: 'c', quantity: 1, deliveryDate: new Date('2027-01-01'), status: 'IN_PROGRESS', updatedAt: new Date() } })
    const color = async () => (await s.board.getBoard(undefined)).rows.find((r) => r.workOrderNumber === 'T-WO-R5-C')!
    expect((await color()).color).toBe('GREEN')
    const p = await makePart('T-WO-R5-C')
    await send(p.weld.id, new Date(+today() - DAY))
    expect(await color()).toMatchObject({ color: 'GREEN', outCount: 1, overdueCount: 1 }) // 在途超期只计数，颜色看预警
    const issue = await report({ workOrderNumber: 'T-WO-R5-C' })
    await s.issues.acceptIssue(issue.id, admin, { dueDate: new Date(+today() - DAY) })
    expect(await color()).toMatchObject({ color: 'YELLOW', overdueCount: 2, openIssues: 1 })
    await s.issues.reassignIssue(issue.id, admin, { dueDate: new Date(+today() - 3 * DAY) })
    expect((await color()).color).toBe('RED')
  })

  it('照片：按魔数只收 JPG/PNG/WebP、超 8MB 拒绝；绑定后按工单可见，未绑定只有上传人能读', async () => {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(100)])
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(100)])
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), randomBytes(50)])
    expect(s.uploads.sniffImage(jpg)?.mime).toBe('image/jpeg')
    expect(s.uploads.sniffImage(png)?.mime).toBe('image/png')
    expect(s.uploads.sniffImage(webp)?.mime).toBe('image/webp')
    // 扩展名/类型都不可信：文本、HTML、GIF、SVG 一律拒绝
    for (const bad of [Buffer.from('hello.jpg'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('GIF89a......')]) {
      await expect(s.uploads.saveUpload(uploadDir, bad, 'u-worker')).rejects.toThrow('只能上传')
    }
    await expect(s.uploads.saveUpload(uploadDir, Buffer.concat([jpg, Buffer.alloc(8 * 1024 * 1024)]), 'u-worker')).rejects.toThrow('8MB')

    const f1 = await s.uploads.saveUpload(uploadDir, jpg, 'u-worker')
    const f2 = await s.uploads.saveUpload(uploadDir, png, 'u-worker')
    expect(f1.storedName).toBe(`${f1.id}.jpg`)
    expect((await readdir(uploadDir)).sort()).toEqual([f1.storedName, f2.storedName].sort())
    const all = () => true
    expect((await s.uploads.readUpload(uploadDir, f1.id, 'u-worker', all))?.data.equals(jpg)).toBe(true)
    expect(await s.uploads.readUpload(uploadDir, f1.id, 'u-pm', all)).toBeNull() // 未绑定：别人读不到
    expect(await s.uploads.readUpload(uploadDir, '../../etc/passwd', 'u-worker', all)).toBeNull()

    // 别人的照片不能拿来上报；自己的可以，最多 3 张
    await expect(report({ photoIds: [f1.id] }, 'u-pm')).rejects.toThrow('照片无效')
    await expect(report({ photoIds: [f1.id, f2.id, 'a'.repeat(32), 'b'.repeat(32)] })).rejects.toThrow('最多 3 张')
    const issue = await report({ workOrderNumber: WO2, photoIds: [f1.id, f2.id] })
    expect(issue.photos).toEqual([f1.id, f2.id])
    await expect(report({ photoIds: [f1.id] })).rejects.toThrow('已被使用')
    // 绑定后：按工单可见范围
    const pm = await s.auth.resolveScope('u-pm', false)
    const pm2 = await s.auth.resolveScope('u-pm2', false)
    expect(await s.uploads.readUpload(uploadDir, f1.id, 'u-pm', (wo) => s.auth.canSee(pm, wo))).toBeNull()
    expect((await s.uploads.readUpload(uploadDir, f1.id, 'u-pm2', (wo) => s.auth.canSee(pm2, wo)))?.file.mime).toBe('image/jpeg')
    const detail = await s.issues.getIssue(issue.id, as('u-pm2'))
    expect(detail.photos).toEqual([{ id: f1.id, url: `/api/files/${f1.id}` }, { id: f2.id, url: `/api/files/${f2.id}` }])
  })

  it('R13 部门对照：异常责任部门是对到生产部的班组时，生产部负责人能受理；"本部门"含班组', async () => {
    const { FlowForbidden } = await import('../../server/services/flow/errors')
    const now = new Date()
    await db.qmsDepartment.createMany({
      data: [
        { id: 'D-R13-MFG', name: '制造中心', parentId: '0', status: 1, updatedAt: now },
        { id: 'D-R13-TEAM', name: '组焊班', parentId: 'D-R13-MFG', status: 1, updatedAt: now },
      ],
    })
    await db.deptMapping.create({ data: { qmsDepartmentId: 'D-R13-MFG', businessDept: 'PRODUCTION' } })
    try {
      const issue = await report()
      await s.issues.reassignIssue(issue.id, as('u-pdh'), { responsibleDeptId: 'D-R13-TEAM', responsibleUserId: 'u-qa2' })
      // 质量部负责人不是责任部门负责人；生产部负责人经部门对照是
      await expect(s.issues.acceptIssue(issue.id, as('u-qa'))).rejects.toBeInstanceOf(FlowForbidden)
      const detail = await s.issues.getIssue(issue.id, as('u-head'))
      expect(detail.can).toMatchObject({ accept: true, reassign: true })
      await s.issues.acceptIssue(issue.id, as('u-head'))
      // "本部门"：按名称的生产部 + 对照到生产部的制造中心及其下级班组
      expect((await s.issues.myDepartmentIds('u-head')).sort()).toEqual(['D-4', 'D-R13-MFG', 'D-R13-TEAM'])
      expect(await s.issues.myDepartmentIds('u-qa')).toEqual(['D-3'])
    } finally {
      await db.deptMapping.deleteMany({ where: { qmsDepartmentId: { startsWith: 'D-R13-' } } })
    }
  })
})
