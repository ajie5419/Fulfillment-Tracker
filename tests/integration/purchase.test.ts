/**
 * 关键物料到货 + 付款（R10）：真实 MySQL 上直接调用服务层，用 now 注入"快进时钟"。
 * 覆盖：采购行增改删与可见范围、Excel 导入（合法行 / 行错误整批不导 / 重复）、QMS 进货检验自动到货（及不进外协"待确认匹配"）、
 * 手工确认 / 撤销到货、延误原因与统计、W6 两个触发与升级、付款申请排序与"标记已付"权限、"可以开工"待办。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
const DAY = 86_400_000

type Services = {
  steps: typeof import('../../server/services/flow/steps')
  flow: typeof import('../../server/services/flow/flow')
  match: typeof import('../../server/services/flow/match')
  todos: typeof import('../../server/services/flow/todos')
  scan: typeof import('../../server/services/alerts/scan')
  rules: typeof import('../../server/services/alerts/rules')
  board: typeof import('../../server/services/issues/board')
  pur: typeof import('../../server/services/purchases/purchases')
  incoming: typeof import('../../server/services/purchases/incoming')
  imp: typeof import('../../server/services/purchases/import')
  pay: typeof import('../../server/services/purchases/payments')
  errors: typeof import('../../server/services/flow/errors')
}

describe.skipIf(!DB)('关键物料到货与付款（R10）', () => {
  let db: PrismaClient
  let s: Services
  const WO = 'T-WO-R10'
  const OTHER_WO = 'T-WO-R10-B'

  async function clean() {
    await db.reminder.deleteMany()
    await db.alert.deleteMany()
    await db.paymentRequest.deleteMany() // 关联行级联删除
    await db.purchaseLine.deleteMany()
    await db.incomingCheck.deleteMany()
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
      match: await import('../../server/services/flow/match'),
      todos: await import('../../server/services/flow/todos'),
      scan: await import('../../server/services/alerts/scan'),
      rules: await import('../../server/services/alerts/rules'),
      board: await import('../../server/services/issues/board'),
      pur: await import('../../server/services/purchases/purchases'),
      incoming: await import('../../server/services/purchases/incoming'),
      imp: await import('../../server/services/purchases/import'),
      pay: await import('../../server/services/purchases/payments'),
      errors: await import('../../server/services/flow/errors'),
    }
    db = (await import('../../server/utils/prisma')).prisma
    await clean()

    const now = new Date()
    await db.qmsWorkOrder.createMany({
      data: [WO, OTHER_WO].map((wo) => ({ workOrderNumber: wo, customerName: '测试客户', quantity: 1, deliveryDate: new Date('2026-12-31'), status: 'IN_PROGRESS', updatedAt: now })),
    })
    await db.qmsSupplier.createMany({
      data: [
        { id: 'S-OUT', name: '外协厂', updatedAt: now },
        { id: 'S-BRG', name: '轴承厂', updatedAt: now },
        { id: 'S-HYD', name: '液压件公司', updatedAt: now },
      ],
    })
    await db.qmsProcess.createMany({
      data: [
        { id: 'P-CUT', name: '下料', updatedAt: now },
        { id: 'P-WELD', name: '组焊', updatedAt: now },
      ],
    })
    const DEPTS = ['采购部', '财务部', '生产部', '项目部', '公司领导', '仓库']
    await db.qmsDepartment.createMany({ data: DEPTS.map((name, i) => ({ id: `PD-${i}`, name, parentId: '0', status: 1, updatedAt: now })) })
    const user = (id: string, realName: string, dept: string) => ({ id, username: id, realName, departmentId: `PD-${DEPTS.indexOf(dept)}`, status: 'ACTIVE', updatedAt: now })
    await db.qmsUser.createMany({
      data: [
        user('u-buyer', '采购员', '采购部'),
        user('u-purhead', '采购部长', '采购部'),
        user('u-fin', '财务', '财务部'),
        user('u-out', '外协专员', '生产部'),
        user('u-prodhead', '生产经理', '生产部'),
        user('u-pm', '项目经理', '项目部'),
        user('u-pdh', '项目部负责人', '项目部'),
        user('u-lead', '分管领导', '公司领导'),
        user('u-wh', '仓管员', '仓库'),
      ],
    })
    await db.notifyRole.createMany({
      data: [
        { role: 'DEPT_HEAD', userId: 'u-purhead', department: '采购部' },
        { role: 'DEPT_HEAD', userId: 'u-prodhead', department: '生产部' },
        { role: 'FINANCE', userId: 'u-fin' },
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
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const line = (over: Partial<Parameters<Services['pur']['createLine']>[0]> = {}) =>
    s.pur.createLine({ workOrderNumber: WO, materialName: '回转支承', quantity: 1, unit: '套', needDate: dayOff(20), ...over }, 'u-buyer')
  let seq = 0
  /** 下料（自制，负责人可指定）→ 组焊（厂外） */
  async function makePart(firstOwner: string | null = 'u-out') {
    seq++
    const part = await s.steps.createPart(WO, { name: `工件-${seq}`, quantity: 1 })
    const first = await s.steps.addStep(part.id, { processId: 'P-CUT', mode: 'SELF', ownerId: firstOwner }, 'u-out')
    if (!firstOwner) await db.routeStep.update({ where: { id: first.id }, data: { ownerId: null } })
    await s.steps.addStep(part.id, { processId: 'P-WELD', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-OUT' }, 'u-out')
    return { part, first }
  }
  async function incomingInspection(id: string, over: Record<string, unknown> = {}) {
    const now = new Date()
    await db.qmsInspection.create({
      data: {
        id,
        requestNo: `RQ-${id}`,
        workOrderNumber: WO,
        workOrderNumbers: [WO],
        partName: '回转支承',
        processName: '进货检验',
        category: 'INCOMING',
        supplierId: 'S-BRG',
        quantity: 1,
        status: 'SUBMITTED',
        inspectionResult: 'PASS',
        submittedAt: now,
        updatedAt: now,
        ...over,
      },
    })
  }

  it('新建 / 修改 / 删除：供应商选 QMS 存 ID 和名称、手填只存名称；工件必须属于该工单；关联付款后不能删', async () => {
    const qms = await line({ supplierId: 'S-BRG', supplierName: '随便写的会被忽略' })
    expect(qms).toMatchObject({ supplierId: 'S-BRG', supplierName: '轴承厂', status: 'OPEN', createdBy: 'u-buyer' })
    const free = await line({ materialName: 'Q355B 钢板', supplierName: ' 手填钢厂 ', spec: 'δ=20' })
    expect(free).toMatchObject({ supplierId: null, supplierName: '手填钢厂' })
    const { part } = await makePart()
    const other = await s.steps.createPart(OTHER_WO, { name: '别的工单的工件', quantity: 1 })
    await expect(line({ partId: other.id })).rejects.toThrow('不属于该工单')
    await expect(line({ supplierId: 'S-NONE' })).rejects.toThrow('供应商不存在')
    await expect(line({ buyerId: 'u-nobody' })).rejects.toThrow('采购负责人不存在')
    await expect(s.pur.createLine({ workOrderNumber: 'WO-NONE', materialName: 'x', quantity: 1, needDate: dayOff(1) }, 'u-buyer')).rejects.toThrow('工单不存在')
    await expect(line({ arrivedDate: dayOff(1) })).rejects.toThrow('不能晚于今天')

    await s.pur.updateLine(free.id, { partId: part.id, promisedDate: dayOff(10), quantity: 30.5, buyerId: 'u-buyer', supplierId: 'S-HYD' })
    expect(await db.purchaseLine.findUniqueOrThrow({ where: { id: free.id } })).toMatchObject({ partId: part.id, promisedDate: dayOff(10), supplierId: 'S-HYD', supplierName: '液压件公司', buyerId: 'u-buyer' })
    expect(Number((await db.purchaseLine.findUniqueOrThrow({ where: { id: free.id } })).quantity)).toBe(30.5)
    // 只传备注：其他字段不动
    await s.pur.updateLine(free.id, { note: '进口' })
    expect(await db.purchaseLine.findUniqueOrThrow({ where: { id: free.id } })).toMatchObject({ note: '进口', supplierId: 'S-HYD', spec: 'δ=20' })
    await expect(s.pur.updateLine(free.id, { arrivedDate: dayOff(0) })).rejects.toThrow('还没到货')

    // 取消 / 重新启用
    await s.pur.updateLine(qms.id, { status: 'CANCELLED' })
    expect((await db.purchaseLine.findUniqueOrThrow({ where: { id: qms.id } })).status).toBe('CANCELLED')
    await s.pur.updateLine(qms.id, { status: 'OPEN' })

    // 关联了付款申请的不能删；没关联的可以删
    await s.pay.createPayment({ purchaseLineIds: [free.id], amount: 100, requestDate: dayOff(0), blocksDelivery: false }, 'u-buyer')
    await expect(s.pur.deleteLine(free.id)).rejects.toThrow('已关联付款申请')
    await s.pur.deleteLine(qms.id)
    expect(await db.purchaseLine.findUnique({ where: { id: qms.id } })).toBeNull()
  })

  it('列表按可见工单过滤；统计不受视图筛选影响', async () => {
    await db.purchaseLine.deleteMany({ where: { payments: { none: {} } } })
    await line({ materialName: '可见的' })
    await s.pur.createLine({ workOrderNumber: OTHER_WO, materialName: '别人的', quantity: 1, needDate: dayOff(5) }, 'u-buyer')
    const pm = await s.pur.listLines({ view: 'all', visibleWorkOrders: [WO] })
    expect(pm.rows.map((r) => r.materialName)).toContain('可见的')
    expect(pm.rows.map((r) => r.materialName)).not.toContain('别人的')
    const all = await s.pur.listLines({ view: 'all' })
    expect(all.rows.map((r) => r.materialName)).toEqual(expect.arrayContaining(['可见的', '别人的']))
    const arrivedView = await s.pur.listLines({ view: 'arrived', visibleWorkOrders: [WO] })
    expect(arrivedView.rows).toHaveLength(0)
    expect(arrivedView.stats.open).toBe(pm.stats.open)
  })

  it('手工确认到货：默认今天、不能晚于今天、不能重复；延误时记原因（没延误不记）；撤销后回到未到货', async () => {
    const onTime = await line({ materialName: '准时件', needDate: dayOff(5), promisedDate: dayOff(3) })
    const r = await s.pur.confirmArrival(onTime.id, { delayReason: 'PAYMENT', source: 'MOBILE' }, 'u-wh')
    expect(r).toMatchObject({ late: false, readySent: false })
    expect(await db.purchaseLine.findUniqueOrThrow({ where: { id: onTime.id } })).toMatchObject({
      status: 'ARRIVED',
      arrivedDate: today(),
      arrivalSource: 'MOBILE',
      arrivedBy: 'u-wh',
      delayReason: null, // 没晚，不记
    })
    await expect(s.pur.confirmArrival(onTime.id, { source: 'PC' }, 'u-wh')).rejects.toThrow('已经确认到货')

    const late = await line({ materialName: '晚到件', needDate: dayOff(-3), promisedDate: dayOff(-5) })
    await expect(s.pur.confirmArrival(late.id, { arrivedDate: dayOff(1), source: 'PC' }, 'u-wh')).rejects.toThrow('不能晚于今天')
    expect((await s.pur.confirmArrival(late.id, { arrivedDate: dayOff(-1), delayReason: 'SUPPLIER', delayNote: '排产推迟', source: 'PC' }, 'u-buyer')).late).toBe(true)
    expect(await db.purchaseLine.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ delayReason: 'SUPPLIER', delayNote: '排产推迟', arrivedDate: dayOff(-1) })
    // 改到货日（填错了）
    await s.pur.updateLine(late.id, { arrivedDate: dayOff(-2) })
    expect((await db.purchaseLine.findUniqueOrThrow({ where: { id: late.id } })).arrivedDate).toEqual(dayOff(-2))

    await s.pur.undoArrival(onTime.id)
    expect(await db.purchaseLine.findUniqueOrThrow({ where: { id: onTime.id } })).toMatchObject({ status: 'OPEN', arrivedDate: null, arrivalSource: null, arrivedBy: null })
    await expect(s.pur.undoArrival(onTime.id)).rejects.toThrow('还没到货')
    const cancelled = await line({ materialName: '取消件' })
    await s.pur.updateLine(cancelled.id, { status: 'CANCELLED' })
    await expect(s.pur.confirmArrival(cancelled.id, { source: 'PC' }, 'u-wh')).rejects.toThrow('已取消')
  })

  it('延误原因：付款原因和管理原因分开统计；没填的单列', async () => {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    const a = await line({ materialName: 'A', needDate: dayOff(-5) }) // 未到货，已过需求日 → 延误
    await s.pur.updateLine(a.id, { delayReason: 'PAYMENT', delayNote: '预付款未付' })
    const b = await line({ materialName: 'B', needDate: dayOff(-5), promisedDate: dayOff(-6) })
    await s.pur.confirmArrival(b.id, { arrivedDate: dayOff(-1), delayReason: 'DEMAND_CHANGE', source: 'PC' }, 'u-buyer')
    await line({ materialName: 'C', needDate: dayOff(10), promisedDate: dayOff(-1) }) // 超承诺日，没填原因
    await line({ materialName: 'D', needDate: dayOff(10) }) // 没延误
    const { stats, rows } = await s.pur.listLines({ view: 'late' })
    expect(rows.map((r) => r.materialName).sort()).toEqual(['A', 'B', 'C'])
    expect(stats.delay).toEqual({ late: 3, payment: 1, management: 1, byReason: { PAYMENT: 1, SUPPLIER: 0, DEMAND_CHANGE: 1, OTHER: 0 }, unfilled: 1 })
    expect(stats.shortage).toBe(1) // A：未到货且已过需求日
    expect(rows.find((r) => r.materialName === 'A')).toMatchObject({ progressText: '缺料', delayReasonText: '付款', lateDays: 5 })
  })

  it('Excel 导入：合法行全部导入；有错误行整批不导并列出行号；重新上传同一文件报"导入过了"', async () => {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    const { part } = await makePart()
    const book = async (rows: (string | number | Date | null)[][], header = ['工单号*', '物料名称*', '规格型号', '数量*', '单位', '供应商', '需求日*', '承诺到货日', '实际到货日', '采购负责人', '工件（名称或图号）', '备注']) => {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('关键物料')
      ws.addRow(header)
      for (const r of rows) ws.addRow(r)
      return Buffer.from(await wb.xlsx.writeBuffer())
    }
    const canSee = (wo: string) => wo === WO
    const good = await book([
      [WO, '回转支承', '013.45', 1, '套', '轴承厂', dayOff(30), dayOff(25), null, '采购员', part.name, '进口'],
      [WO, '钢板', 'δ=20', '30.5', 't', '手填钢厂', ymd(dayOff(15)), null, ymd(dayOff(-1)), null, null, null],
      [null, null, null, null, null, null, null, null, null, null, null, null], // 空行跳过
    ])
    expect(await s.imp.importPurchases(good, 'u-buyer', canSee)).toEqual({ imported: 2, errors: [], warnings: [], rows: 2 })
    const lines = await db.purchaseLine.findMany({ where: { workOrderNumber: WO }, orderBy: { materialName: 'asc' } })
    expect(lines.find((l) => l.materialName === '回转支承')).toMatchObject({ supplierId: 'S-BRG', supplierName: '轴承厂', buyerId: 'u-buyer', partId: part.id, needDate: dayOff(30), promisedDate: dayOff(25), status: 'OPEN', note: '进口' })
    expect(lines.find((l) => l.materialName === '钢板')).toMatchObject({ supplierId: null, supplierName: '手填钢厂', status: 'ARRIVED', arrivedDate: dayOff(-1), arrivalSource: 'PC' })

    // 同一文件再传：两行都"导入过了"，什么都不导
    const again = await s.imp.importPurchases(good, 'u-buyer', canSee)
    expect(again.imported).toBe(0)
    expect(again.errors.map((e) => e.row)).toEqual([2, 3])
    expect(again.errors[0]!.messages[0]).toContain('导入过了')

    // 一行好、几行坏：整批不导，行号是 Excel 行号
    const bad = await book([
      [WO, '减速机', null, 2, '台', null, ymd(dayOff(20)), null, null, null, null, null],
      [OTHER_WO, '马达', null, 1, null, null, ymd(dayOff(20)), null, null, null, null, null],
      [WO, null, null, 0, null, null, '2026-02-30', null, null, '不存在的人', '不存在的工件', null],
    ])
    const r = await s.imp.importPurchases(bad, 'u-buyer', canSee)
    expect(r.imported).toBe(0)
    expect(r.errors).toEqual([
      { row: 3, messages: [`无权查看工单 ${OTHER_WO}`] },
      { row: 4, messages: ['物料名称必填', '数量要大于 0，最多 3 位小数', '需求日不是有效日期（如 2026-11-20）', '采购负责人"不存在的人"不存在或已停用', `工单 ${WO} 下没有工件"不存在的工件"`] },
    ])
    expect(await db.purchaseLine.count({ where: { materialName: '减速机' } })).toBe(0)

    // 表头不对 / 不是 Excel
    await expect(s.imp.importPurchases(await book([[WO]], ['工单', '名称']), 'u-buyer', canSee)).rejects.toThrow('缺少列：工单号、物料名称、数量、需求日')
    await expect(s.imp.importPurchases(Buffer.from('PK\u0003\u0004 not really a zip'), 'u-buyer', canSee)).rejects.toThrow('不是有效的 Excel')
    // 模板本身能被读回（表头对得上，没有数据）
    await expect(s.imp.importPurchases(await s.imp.buildTemplate(), 'u-buyer', canSee)).rejects.toThrow('没有数据')
  })

  it('QMS 进货检验（INCOMING）：恰好一条对上 → 自动到货；多条 / 供应商不同不自动；每条只处理一次；不进外协"待确认匹配"', async () => {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    const { part } = await makePart() // 工单下有工件：外协返厂匹配会处理这个工单的报检
    const brg = await line({ supplierId: 'S-BRG', promisedDate: dayOff(5), createdBy: undefined } as never)
    await incomingInspection('INS-1')
    const r = await s.incoming.matchIncomingInspections()
    expect(r).toEqual([{ inspectionId: 'INS-1', result: 'MATCHED', purchaseLineId: brg.id }])
    expect(await db.purchaseLine.findUniqueOrThrow({ where: { id: brg.id } })).toMatchObject({ status: 'ARRIVED', arrivalSource: 'QMS_INSPECTION', qmsInspectionId: 'INS-1', arrivedBy: null, arrivedDate: today() })
    // 幂等：再跑不重复处理
    expect(await s.incoming.matchIncomingInspections()).toEqual([])
    // 进货检验不是外协返厂：不进"待确认匹配"
    const m = await s.match.matchPendingInspections()
    expect(m.find((x) => x.inspectionId === 'INS-1')).toBeUndefined()
    expect(await db.unmatchedInspection.count()).toBe(0)
    expect((await s.match.matchInspection('INS-1')).status).toBe('ignored')
    // 普通工序报检照旧进待确认（没有在外的步骤）
    await incomingInspection('INS-PROC', { category: 'PROCESS', processName: '组焊', partName: part.name })
    await s.match.matchPendingInspections()
    expect(await db.unmatchedInspection.findUnique({ where: { qmsInspectionId: 'INS-PROC' } })).toMatchObject({ reason: 'NO_CANDIDATE' })

    // 撤销自动到货：这一行之后只能手工确认，新的报检对不上
    await s.pur.undoArrival(brg.id)
    await incomingInspection('INS-2')
    expect(await s.incoming.matchIncomingInspections()).toEqual([{ inspectionId: 'INS-2', result: 'NO_CANDIDATE' }])
    expect((await db.purchaseLine.findUniqueOrThrow({ where: { id: brg.id } })).status).toBe('OPEN')

    // 两条同名同供应商 → MULTIPLE，都不动；手工确认其中一条后，同一条报检也不会再去"对上"剩下那条
    const m1 = await line({ materialName: '液压马达', supplierId: 'S-HYD' })
    const m2 = await line({ materialName: '液压马达', supplierId: 'S-HYD', spec: '另一型号' })
    await incomingInspection('INS-3', { partName: ' 液压马达', supplierId: 'S-HYD' })
    expect(await s.incoming.matchIncomingInspections()).toEqual([{ inspectionId: 'INS-3', result: 'MULTIPLE' }])
    await s.pur.confirmArrival(m1.id, { source: 'PC' }, 'u-wh')
    expect(await s.incoming.matchIncomingInspections()).toEqual([])
    expect((await db.purchaseLine.findUniqueOrThrow({ where: { id: m2.id } })).status).toBe('OPEN')

    // 供应商不同不对上；没有分类但工序名是"进货检验"的也算进货检验；撤销的报检不处理
    const hyd = await line({ materialName: '密封件', supplierId: 'S-HYD' })
    await incomingInspection('INS-4', { partName: '密封件', supplierId: 'S-BRG' })
    await incomingInspection('INS-5', { partName: '密封件', supplierId: 'S-HYD', category: null, status: 'CANCELLED' })
    expect(await s.incoming.matchIncomingInspections()).toEqual([{ inspectionId: 'INS-4', result: 'NO_CANDIDATE' }])
    await incomingInspection('INS-6', { partName: '密封件', supplierId: 'S-HYD', category: null })
    expect(await s.incoming.matchIncomingInspections()).toEqual([{ inspectionId: 'INS-6', result: 'MATCHED', purchaseLineId: hyd.id }])
    // 别的工单（没有采购行）的进货检验不处理、不记录
    await incomingInspection('INS-7', { workOrderNumber: 'WO-ELSEWHERE', workOrderNumbers: ['WO-ELSEWHERE'] })
    expect(await s.incoming.matchIncomingInspections()).toEqual([])
    expect(await db.incomingCheck.findUnique({ where: { qmsInspectionId: 'INS-7' } })).toBeNull()
  })

  it('W6：承诺日已过 → 黄（采购负责人、采购部负责人、项目经理；卡交期付款没付时加财务）→ 红（加项目部负责人、分管领导），不转异常；到货后消除', async () => {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    await db.alert.deleteMany()
    await db.reminder.deleteMany()
    const steel = await line({ materialName: '钢板', needDate: dayOff(10), promisedDate: dayOff(0), buyerId: 'u-buyer' })
    await s.pay.createPayment({ purchaseLineIds: [steel.id], amount: 186000, requestDate: dayOff(-3), blocksDelivery: true, note: '预付款' }, 'u-buyer')
    const key = s.rules.alertKey('W6', 'purchase', steel.id)
    const users = async () => {
      const a = await db.alert.findFirstOrThrow({ where: { refType: 'purchase', refId: steel.id } })
      return { a, users: (await db.reminder.findMany({ where: { alertId: a.id } })).map((x) => `${x.level}:${x.userId}`).sort() }
    }
    const at = (days: number) => new Date(+today() + days * DAY + 3 * 3_600_000)
    await s.scan.scanRules(at(0)) // 承诺日当天：不预警
    expect(await db.alert.findFirst({ where: { activeKey: key } })).toBeNull()
    await s.scan.scanRules(at(1))
    const y = await users()
    expect(y.a).toMatchObject({ rule: 'W6', level: 'YELLOW' })
    expect(y.users).toEqual(['YELLOW:u-buyer', 'YELLOW:u-fin', 'YELLOW:u-pm', 'YELLOW:u-purhead'])
    const title = (await db.reminder.findFirstOrThrow({ where: { alertId: y.a.id } })).title
    expect(title).toContain('【黄】关键物料 钢板')
    expect(title).toContain('已超 1 天未到；卡交期付款待付')
    await s.scan.scanRules(at(3))
    const r = await users()
    expect(r.a).toMatchObject({ level: 'RED', status: 'ACTIVE' }) // 不转异常
    expect(r.users.filter((u) => u.startsWith('RED:'))).toEqual(['RED:u-buyer', 'RED:u-fin', 'RED:u-lead', 'RED:u-pdh', 'RED:u-pm', 'RED:u-purhead'])
    // 只看这条 W6 预警有没有转异常：前面用例留下的工序待办在快进的时钟下可能触发 W1–W3 转异常（与 W6 无关，结果随运行时刻变化）
    expect(await db.issue.count({ where: { sourceKey: `ALERT:${r.a.id}` } })).toBe(0)
    // 提醒跳到采购到货页 / 手机到货确认页
    const list = await s.scan.collectTargets(at(3), await s.scan.loadThresholds(), [], 'W6')
    expect(list.map((t) => t.refId)).toEqual([steel.id])

    await s.pur.confirmArrival(steel.id, { source: 'PC' }, 'u-wh')
    expect((await db.alert.findUniqueOrThrow({ where: { id: r.a.id } })).status).toBe('CLEARED')
  })

  it('W6：没有承诺日、需求日前 7 天内 → 黄（没指定采购负责人 → 采购部负责人）；需求日过了 → 红；取消后消除', async () => {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    const motor = await line({ materialName: '进口马达', needDate: dayOff(9) })
    const at = (days: number) => new Date(+today() + days * DAY + 3 * 3_600_000)
    await s.scan.scanRules(at(1)) // 还剩 8 天：不预警
    expect(await db.alert.findFirst({ where: { refId: motor.id } })).toBeNull()
    await s.scan.scanRules(at(2)) // 还剩 7 天
    const a = await db.alert.findFirstOrThrow({ where: { refId: motor.id } })
    expect(a.level).toBe('YELLOW')
    const rem = await db.reminder.findMany({ where: { alertId: a.id } })
    expect(rem.map((x) => x.userId).sort()).toEqual(['u-pm', 'u-purhead']) // 没有卡交期付款：不通知财务
    expect(rem[0]!.title).toContain('还剩 7 天）仍无承诺到货日')
    await s.scan.scanRules(at(10))
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).level).toBe('RED')
    await s.pur.updateLine(motor.id, { status: 'CANCELLED' })
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CLEARED')
    // 看板：缺料 = 未到货且已到需求日
    await line({ materialName: '缺的料', needDate: dayOff(0) })
    const board = await s.board.getBoard(undefined)
    expect(board.rows.find((x) => x.workOrderNumber === WO)?.shortage).toBe(1)
  })

  it('付款申请：按影响排序；只有财务或管理员能改状态；申请人或管理员能删没付的；同一工单才能一起申请', async () => {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    const near = await line({ materialName: '近', needDate: dayOff(3) })
    const far = await line({ materialName: '远', needDate: dayOff(40) })
    const done = await line({ materialName: '已到', needDate: dayOff(1) })
    await s.pur.confirmArrival(done.id, { source: 'PC' }, 'u-wh')
    const other = await s.pur.createLine({ workOrderNumber: OTHER_WO, materialName: '别的工单', quantity: 1, needDate: dayOff(2) }, 'u-buyer')
    await expect(s.pay.createPayment({ purchaseLineIds: [near.id, other.id], amount: 1, requestDate: dayOff(0), blocksDelivery: false }, 'u-buyer')).rejects.toThrow('同一个工单')

    const mk = (ids: string[], blocksDelivery: boolean) => s.pay.createPayment({ purchaseLineIds: ids, amount: 1000, requestDate: dayOff(0), blocksDelivery }, 'u-buyer')
    const pNear = await mk([near.id], false)
    const pFarBlocking = await mk([far.id], true)
    const pDone = await mk([done.id], false)
    const pBoth = await mk([far.id, near.id], false)

    const viewer = { userId: 'u-pm', isAdmin: false }
    const list = await s.pay.listPayments({ status: 'ALL' }, viewer)
    expect(list.map((p) => p.id)).toEqual([pFarBlocking.id, pNear.id, pBoth.id, pDone.id].filter((x, i, a) => a.indexOf(x) === i).sort((a, b) => {
      // 卡交期 → 需求日近（pNear、pBoth 同为 +3 天，申请日相同按创建先后）→ 都到货的最后
      const order = [pFarBlocking.id, pNear.id, pBoth.id, pDone.id]
      return order.indexOf(a) - order.indexOf(b)
    }))
    expect(list.find((p) => p.id === pBoth.id)?.nearestNeedDate).toEqual(dayOff(3))
    expect(list.find((p) => p.id === pDone.id)?.nearestNeedDate).toEqual(dayOff(1)) // 显示需求日；排序仍将无 OPEN 行的排最后
    expect(list[0]!.permissions).toEqual({ setStatus: false, delete: false })

    // 项目经理不能标已付；财务、管理员可以
    await expect(s.pay.setPaymentStatus(pNear.id, 'PAID', null, viewer)).rejects.toBeInstanceOf(s.errors.FlowForbidden)
    await expect(s.pay.setPaymentStatus(pNear.id, 'PAID', null, { userId: 'u-buyer', isAdmin: false })).rejects.toThrow('只有财务或管理员')
    await s.pay.setPaymentStatus(pNear.id, 'PAID', '已电汇', { userId: 'u-fin', isAdmin: false })
    expect(await db.paymentRequest.findUniqueOrThrow({ where: { id: pNear.id } })).toMatchObject({ status: 'PAID', statusBy: 'u-fin', financeNote: '已电汇' })
    await s.pay.setPaymentStatus(pFarBlocking.id, 'ON_HOLD', undefined, { userId: 'u-admin', isAdmin: true })
    expect((await s.pay.listPayments({}, { userId: 'u-fin', isAdmin: false })).map((p) => p.id)).not.toContain(pNear.id) // 默认只看没付的
    expect((await s.pay.listPayments({ status: 'PAID' }, { userId: 'u-fin', isAdmin: false }))[0]!.permissions.setStatus).toBe(true)

    // 删除：已付的不能删；不是申请人不能删
    await expect(s.pay.deletePayment(pNear.id, { userId: 'u-buyer', isAdmin: false })).rejects.toThrow('已付的不能删除')
    await expect(s.pay.deletePayment(pDone.id, { userId: 'u-pm', isAdmin: false })).rejects.toBeInstanceOf(s.errors.FlowForbidden)
    await s.pay.deletePayment(pDone.id, { userId: 'u-buyer', isAdmin: false })
    expect(await db.paymentRequest.findUnique({ where: { id: pDone.id } })).toBeNull()
    // 采购行上能看到付款情况
    const row = (await s.pur.listLines({ view: 'all' })).rows.find((r) => r.id === far.id)!
    expect(row.payments.map((p) => p.statusText).sort()).toEqual(['待付', '暂缓'])
    expect(row.blockedByPayment).toBe(true)
  })

  it('可以开工：工件的关键物料全部到货时给第一道工序负责人发待办；开工后关闭；又挂上未到货的作废没处理的待办', async () => {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    const { part, first } = await makePart('u-out')
    const a = await line({ materialName: '物料甲', partId: part.id })
    const b = await line({ materialName: '物料乙', partId: part.id })
    const c = await line({ materialName: '物料丙', partId: part.id })
    const ready = () => db.todo.findMany({ where: { refType: 'part', refId: part.id, action: 'READY_TO_START' }, orderBy: { createdAt: 'asc' } })

    expect((await s.pur.confirmArrival(a.id, { source: 'PC' }, 'u-wh')).readySent).toBe(false)
    await s.pur.updateLine(c.id, { status: 'CANCELLED' }) // 取消的不算
    expect(await ready()).toHaveLength(0)
    expect((await s.pur.confirmArrival(b.id, { source: 'MOBILE' }, 'u-wh')).readySent).toBe(true)
    const [todo] = await ready()
    expect(todo).toMatchObject({ ownerId: 'u-out', status: 'OPEN' })
    // 我的待办：带第一道工序，页面按方式给"开工"按钮
    const mine = (await s.todos.listMyTodos('u-out')).find((t) => t.id === todo!.id)!
    expect(mine).toMatchObject({ actionText: '可以开工', title: `可以开工：${part.name} · 下料`, step: { id: first.id, mode: 'SELF', status: 'PENDING' } })
    expect(mine.suggestion).toContain('关键物料已全部到货（2 项）')
    // 可见范围：项目经理只看自己工单时，别的工单的工件待办不列出
    expect((await s.todos.listMyTodos('u-out', [OTHER_WO])).find((t) => t.id === todo!.id)).toBeUndefined()

    // 再挂上一项未到货 → 没处理的"可以开工"作废；它到了再发一条
    const d = await line({ materialName: '物料丁', partId: part.id })
    expect((await db.todo.findUniqueOrThrow({ where: { id: todo!.id } })).status).toBe('CANCELLED')
    await s.pur.confirmArrival(d.id, { source: 'PC' }, 'u-wh')
    const second = (await ready()).find((t) => t.status === 'OPEN')!
    expect(second.ownerId).toBe('u-out')
    // 改备注之类的保存不会重复发
    await s.pur.updateLine(d.id, { note: '备注' })
    expect((await ready()).filter((t) => t.status === 'OPEN')).toHaveLength(1)

    // 开工 → 关闭
    await s.flow.startStep({ stepId: first.id, actorId: 'u-out', source: 'PC' })
    expect((await db.todo.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('DONE')

    // 第一道没有负责人 → 发给生产部负责人；第一道已经开工 → 不发
    const p2 = await makePart(null)
    const x = await line({ materialName: '物料戊', partId: p2.part.id })
    await s.pur.confirmArrival(x.id, { source: 'PC' }, 'u-wh')
    expect((await db.todo.findFirstOrThrow({ where: { refType: 'part', refId: p2.part.id } })).ownerId).toBe('u-prodhead')
    const p3 = await makePart('u-out')
    await s.flow.startStep({ stepId: p3.first.id, actorId: 'u-out', source: 'PC' })
    const y = await line({ materialName: '物料己', partId: p3.part.id })
    expect((await s.pur.confirmArrival(y.id, { source: 'PC' }, 'u-wh')).readySent).toBe(false)

    // 最后一项缺料被删除 / 取消时，剩下的都到了 → 也发
    const p4 = await makePart('u-out')
    const g = await line({ materialName: '物料庚', partId: p4.part.id })
    const h = await line({ materialName: '物料辛', partId: p4.part.id })
    await s.pur.confirmArrival(g.id, { source: 'PC' }, 'u-wh')
    await s.pur.deleteLine(h.id)
    expect(await db.todo.count({ where: { refType: 'part', refId: p4.part.id, status: 'OPEN' } })).toBe(1)
    // QMS 进货检验自动到货同样触发
    const p5 = await makePart('u-out')
    await line({ materialName: '自动到货件', partId: p5.part.id, supplierId: 'S-BRG' })
    await incomingInspection('INS-READY', { partName: '自动到货件' })
    await s.incoming.matchIncomingInspections()
    expect(await db.todo.count({ where: { refType: 'part', refId: p5.part.id, status: 'OPEN', ownerId: 'u-out' } })).toBe(1)
    // 同一工件的最后两项同时确认：恰好发一条（不会因为事务快照谁都不发，也不会发两条）
    for (let round = 0; round < 3; round++) {
      const p6 = await makePart('u-out')
      const l1 = await line({ materialName: `并发甲${round}`, partId: p6.part.id })
      const l2 = await line({ materialName: `并发乙${round}`, partId: p6.part.id })
      await Promise.all([s.pur.confirmArrival(l1.id, { source: 'PC' }, 'u-wh'), s.pur.confirmArrival(l2.id, { source: 'MOBILE' }, 'u-buyer')])
      expect(await db.todo.count({ where: { refType: 'part', refId: p6.part.id, action: 'READY_TO_START', status: 'OPEN' } })).toBe(1)
    }
  })

  it('paginates after filtering and ordering while keeping full-scope statistics', async () => {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    await db.purchaseLine.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({
        workOrderNumber: WO,
        materialName: `旧物料${i}`,
        quantity: 1,
        needDate: dayOff(-400 + (i % 100)),
        status: 'ARRIVED' as const,
        arrivedDate: dayOff(-300),
        delayReason: i < 10 ? ('SUPPLIER' as const) : null,
        createdBy: 'u-buyer',
      })),
    })
    const open = await line({ materialName: '新的未到货', needDate: dayOff(30) })
    const late = await line({ materialName: 'Late-Item', needDate: dayOff(-1), promisedDate: dayOff(-2) })
    await s.pur.updateLine(late.id, { delayReason: 'PAYMENT' })
    const all = await s.pur.listLines({ view: 'all' })
    expect(all.total).toBe(522)
    expect(all.rows).toHaveLength(50)
    expect(all).toMatchObject({ page: 1, pageSize: 50 })
    const pages = await Promise.all(Array.from({ length: 11 }, (_, i) => s.pur.listLines({ view: 'all', page: i + 1 })))
    expect(new Set(pages.flatMap((p) => p.rows.map((r) => r.id))).size).toBe(522)
    expect(pages[10]!.rows).toHaveLength(22)
    expect(pages.every((p) => p.stats.arrived === 520)).toBe(true)
    expect(all.rows.slice(0, 2).map((r) => r.id).sort()).toEqual([open.id, late.id].sort()) // 未到货的在前
    expect((await s.pur.listLines({ view: 'open' })).rows.map((r) => r.id).sort()).toEqual([open.id, late.id].sort())
    const { stats } = all
    // 旧行：到货日（-300）晚于需求日（-400..-301）→ 都算延误；10 条供应商原因
    expect(stats).toMatchObject({ open: 2, shortage: 1, noPromise: 1, arrived: 520 })
    expect(stats.delay).toEqual({ late: 521, payment: 1, management: 10, byReason: { PAYMENT: 1, SUPPLIER: 10, DEMAND_CHANGE: 0, OTHER: 0 }, unfilled: 510 })
    const lateView = await s.pur.listLines({ view: 'late' })
    expect(lateView.total).toBe(521)
    expect(lateView.rows[0]!.id).toBe(late.id)
    expect((await s.pur.listLines({ view: 'shortage' })).rows.map((r) => r.id)).toEqual([late.id])
    // 关键字不区分大小写，在截断前筛
    expect((await s.pur.listLines({ view: 'all', q: 'late-ITEM' })).rows.map((r) => r.id)).toEqual([late.id])
    expect((await s.pur.listLines({ view: 'arrived', q: '旧物料519' })).rows.map((r) => r.materialName)).toEqual(['旧物料519'])
  })

  async function seedPagination() {
    await db.paymentRequest.deleteMany()
    await db.purchaseLine.deleteMany()
    await db.purchaseLine.createMany({ data: Array.from({ length: 1001 }, (_, i) => ({
      id: `pagination-${String(i).padStart(4, '0')}`, workOrderNumber: WO,
      materialName: `Paged material ${i}`, quantity: 1, createdBy: 'u-buyer',
      createdAt: new Date('2026-10-28T00:00:00Z'), needDate: dayOff(i < 520 ? 1 : 2),
      status: i < 520 ? 'OPEN' as const : i < 1000 ? 'ARRIVED' as const : 'CANCELLED' as const,
      arrivedDate: i >= 520 && i < 1000 ? dayOff(i % 3) : null,
    })) })
    return line({ workOrderNumber: OTHER_WO, materialName: 'Hidden material' })
  }

  it('covers 1001 records, ties, status boundaries, group totals and visibility on every page', async () => {
    const hidden = await seedPagination()
    const results = []
    for (let page = 1; page <= 11; page++) results.push(await s.pur.listLines({ view: 'all', page, pageSize: 100, visibleWorkOrders: [WO] }))
    const ids = results.flatMap((p) => p.rows.map((r) => r.id))
    expect(ids).toHaveLength(1001)
    expect(new Set(ids).size).toBe(1001)
    expect(ids).not.toContain(hidden.id)
    expect(results.every((p) => p.total === 1001 && p.groups[WO]?.count === 1001 && p.groups[WO]?.total === 1000 && p.groups[WO]?.done === 480)).toBe(true)
    expect(ids.slice(0, 520)).toEqual(Array.from({ length: 520 }, (_, i) => `pagination-${String(i).padStart(4, '0')}`))
    const arrivals = results.flatMap((p) => p.rows).filter((r) => r.status === 'ARRIVED')
    expect(arrivals.every((r, i) => !i || +arrivals[i - 1]!.arrivedDate! >= +r.arrivedDate!)).toBe(true)
    expect((await s.pur.listLines({ view: 'all', visibleWorkOrders: [] })).total).toBe(0)
    const found = await s.pur.listLines({ view: 'all', q: 'Paged material 999', visibleWorkOrders: [WO] })
    expect(found.rows.map((r) => r.id)).toEqual(['pagination-0999'])
    expect(found.groups[WO]).toEqual({ done: 1, total: 1, count: 1 })
    const last = await s.pur.listLines({ view: 'all', page: 9999, pageSize: 100, visibleWorkOrders: [WO] })
    expect(last).toMatchObject({ page: 11, total: 1001 })
    await db.purchaseLine.delete({ where: { id: 'pagination-1000' } })
    expect(await s.pur.listLines({ view: 'all', page: 11, pageSize: 100, visibleWorkOrders: [WO] })).toMatchObject({ page: 10, total: 1000 })
  })

  it('searches and hydrates material choices beyond 500 within the selected visible work order', async () => {
    await seedPagination()
    const base = { workOrderNumber: WO, visibleWorkOrders: [WO], page: 1, pageSize: 20 }
    const first = await s.pur.listLineOptions(base)
    expect(first.rows).toHaveLength(20)
    expect(first.total).toBe(1000)
    expect((await s.pur.listLineOptions({ ...base, q: 'material 999' })).rows.map((r) => r.id)).toEqual(['pagination-0999'])
    expect((await s.pur.listLineOptions({ ...base, ids: ['pagination-0999'] })).rows.map((r) => r.id)).toEqual(['pagination-0999'])
    expect((await s.pur.listLineOptions({ ...base, visibleWorkOrders: [] })).rows).toEqual([])
    expect((await s.pur.listLineOptions({ ...base, workOrderNumber: OTHER_WO })).rows).toEqual([])
    await db.purchaseLine.update({ where: { id: 'pagination-0999' }, data: { status: 'CANCELLED' } })
    expect((await s.pur.listLineOptions({ ...base, ids: ['pagination-0999'] })).rows).toEqual([])
  })
})
