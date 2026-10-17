/** 关键物料与付款（R10）的纯函数：到货进度、W6 两个触发与升级、进货检验匹配、付款排序、延误统计、Excel 行校验 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS as T } from '../../server/services/alerts/rules'
import {
  comparePayments,
  delayStats,
  findPurchaseCandidates,
  isIncomingInspection,
  judgeW6,
  lineProgress,
  normalizeName,
  w6Summary,
} from '../../server/services/purchases/constants'
import { type ImportContext, type RawRow, parseDateCell, parseQuantity, validateRows } from '../../server/services/purchases/import'

const d = (day: string) => new Date(`${day}T00:00:00.000Z`)
/** 工厂时区 2026-10-17 10:00 */
const NOW = new Date('2026-10-17T02:00:00.000Z')

describe('lineProgress：到货进度', () => {
  const base = { status: 'OPEN' as const, needDate: d('2026-10-25'), promisedDate: d('2026-10-20'), arrivedDate: null }
  it('未到货：待到货 / 无承诺日 / 超承诺日 / 缺料（需求日 ≤ 今天）', () => {
    expect(lineProgress(base, NOW)).toMatchObject({ text: '待到货', late: false, shortage: false })
    expect(lineProgress({ ...base, promisedDate: null }, NOW)).toMatchObject({ text: '无承诺日', late: false })
    expect(lineProgress({ ...base, promisedDate: d('2026-10-15') }, NOW)).toMatchObject({ text: '超承诺日', late: true, lateDays: 2, shortage: false })
    expect(lineProgress({ ...base, needDate: d('2026-10-17') }, NOW)).toMatchObject({ text: '缺料', shortage: true, late: false })
    expect(lineProgress({ ...base, needDate: d('2026-10-14') }, NOW)).toMatchObject({ text: '缺料', shortage: true, late: true, lateDays: 3 })
  })
  it('已到货：晚于需求日或承诺日 = 延误到货；不算缺料', () => {
    const arrived = { ...base, status: 'ARRIVED' as const }
    expect(lineProgress({ ...arrived, arrivedDate: d('2026-10-19') }, NOW)).toMatchObject({ text: '已到货', late: false })
    expect(lineProgress({ ...arrived, arrivedDate: d('2026-10-22') }, NOW)).toMatchObject({ text: '延误到货', late: true, lateDays: 2, shortage: false })
    expect(lineProgress({ ...arrived, promisedDate: null, arrivedDate: d('2026-10-26') }, NOW)).toMatchObject({ late: true, lateDays: 1 })
  })
  it('已取消：不算延误、不算缺料', () => {
    expect(lineProgress({ ...base, status: 'CANCELLED', needDate: d('2026-10-01') }, NOW)).toEqual({ text: '已取消', late: false, shortage: false, lateDays: 0 })
  })
})

describe('judgeW6：关键物料未到货', () => {
  const t = T.W6
  it('默认阈值：需求日前 7 天无承诺日、超承诺日 1 天黄 3 天红', () => {
    expect(t).toEqual({ remindHours: 168, yellowDays: 1, redDays: 3 })
  })
  it('触发 1：承诺到货日已过 → 1 天黄、3 天红（停工日不计）', () => {
    const need = d('2026-11-30')
    expect(judgeW6({ needDate: need, promisedDate: d('2026-10-17'), now: NOW, offDays: [] }, t)).toMatchObject({ level: null, trigger: null })
    expect(judgeW6({ needDate: need, promisedDate: d('2026-10-16'), now: NOW, offDays: [] }, t)).toMatchObject({ level: 'YELLOW', trigger: 'OVERDUE', overdueDays: 1 })
    expect(judgeW6({ needDate: need, promisedDate: d('2026-10-15'), now: NOW, offDays: [] }, t)).toMatchObject({ level: 'YELLOW', overdueDays: 2 })
    expect(judgeW6({ needDate: need, promisedDate: d('2026-10-14'), now: NOW, offDays: [] }, t)).toMatchObject({ level: 'RED', overdueDays: 3 })
    // 中间一天停工：只算 2 天
    expect(judgeW6({ needDate: need, promisedDate: d('2026-10-14'), now: NOW, offDays: ['2026-10-16'] }, t)).toMatchObject({ level: 'YELLOW', overdueDays: 2 })
  })
  it('触发 1 升级：需求日也过了直接红；黄阈值调大时先"提醒"', () => {
    expect(judgeW6({ needDate: d('2026-10-16'), promisedDate: d('2026-10-16'), now: NOW, offDays: [] }, t)).toMatchObject({ level: 'RED', needPassed: true })
    expect(judgeW6({ needDate: d('2026-11-30'), promisedDate: d('2026-10-16'), now: NOW, offDays: [] }, { ...t, yellowDays: 2, redDays: 4 })).toMatchObject({ level: 'REMIND', trigger: 'OVERDUE' })
  })
  it('承诺日还没到（哪怕晚于需求日）不预警', () => {
    expect(judgeW6({ needDate: d('2026-10-16'), promisedDate: d('2026-10-20'), now: NOW, offDays: [] }, t)).toMatchObject({ level: null, trigger: null })
  })
  it('触发 2：没有承诺日，距需求日 ≤ 7 天 → 黄；需求日已过 → 红；还早 → 不预警', () => {
    expect(judgeW6({ needDate: d('2026-10-25'), promisedDate: null, now: NOW, offDays: [] }, t)).toMatchObject({ level: null, trigger: null, daysLeft: 8 })
    expect(judgeW6({ needDate: d('2026-10-24'), promisedDate: null, now: NOW, offDays: [] }, t)).toMatchObject({ level: 'YELLOW', trigger: 'NO_PROMISE', daysLeft: 7 })
    expect(judgeW6({ needDate: d('2026-10-17'), promisedDate: null, now: NOW, offDays: [] }, t)).toMatchObject({ level: 'YELLOW', daysLeft: 0 })
    expect(judgeW6({ needDate: d('2026-10-16'), promisedDate: null, now: NOW, offDays: [] }, t)).toMatchObject({ level: 'RED', needPassed: true })
    // N 改成 3 天
    expect(judgeW6({ needDate: d('2026-10-21'), promisedDate: null, now: NOW, offDays: [] }, { ...t, remindHours: 72 })).toMatchObject({ level: null })
  })
  it('标题文字', () => {
    const l = { needDate: d('2026-10-20'), promisedDate: null, supplierName: '某厂' }
    expect(w6Summary(judgeW6({ ...l, now: NOW, offDays: [] }, t), l)).toBe('需求日 2026-10-20（还剩 3 天）仍无承诺到货日')
    const o = { needDate: d('2026-10-16'), promisedDate: d('2026-10-14'), supplierName: '某厂' }
    expect(w6Summary(judgeW6({ ...o, now: NOW, offDays: [] }, t), o)).toBe('某厂承诺 2026-10-14 到货，已超 3 天未到（需求日 2026-10-16 已过）')
  })
})

describe('进货检验自动到货：判定与匹配', () => {
  it('isIncomingInspection 与 QMS 口径一致：有分类按分类；没分类看工序名"进货检验"', () => {
    expect(isIncomingInspection({ category: 'INCOMING', processName: '组焊' })).toBe(true)
    expect(isIncomingInspection({ category: ' incoming ', processName: '' })).toBe(true)
    expect(isIncomingInspection({ category: 'PROCESS', processName: '进货检验' })).toBe(false)
    expect(isIncomingInspection({ category: null, processName: ' 进货检验 ' })).toBe(true)
    expect(isIncomingInspection({ category: null, processName: '涂装' })).toBe(false)
  })
  it('normalizeName：全角半角、空白、大小写不敏感', () => {
    expect(normalizeName(' Ｑ355B 钢板 ')).toBe(normalizeName('q355b钢板'))
  })

  const line = (over: Partial<Parameters<typeof findPurchaseCandidates>[1][number]> = {}) => ({
    id: 'L1',
    workOrderNumber: 'WO-1',
    materialName: '回转支承',
    supplierId: 'S-1',
    status: 'OPEN' as const,
    qmsInspectionId: null,
    createdAt: new Date('2026-10-01T02:00:00Z'),
    ...over,
  })
  const ins = { workOrderNumber: 'WO-1', workOrderNumbers: ['WO-1'], partName: '回转支承 ', supplierId: 'S-1', submittedAt: new Date('2026-10-17T01:00:00Z') }
  it('工单 + 物料名称 + 供应商（都有 ID 时）对上', () => {
    expect(findPurchaseCandidates(ins, [line()]).map((l) => l.id)).toEqual(['L1'])
    expect(findPurchaseCandidates(ins, [line({ supplierId: 'S-2' })])).toEqual([])
    // 采购行是手填供应商（没有 ID）或报检没有供应商：不比较供应商
    expect(findPurchaseCandidates(ins, [line({ supplierId: null })])).toHaveLength(1)
    expect(findPurchaseCandidates({ ...ins, supplierId: null }, [line()])).toHaveLength(1)
    expect(findPurchaseCandidates(ins, [line({ materialName: '回转支撑' })])).toEqual([])
    expect(findPurchaseCandidates(ins, [line({ workOrderNumber: 'WO-2' })])).toEqual([])
  })
  it('关联工单也算；已到货、已取消、自动到货用过（撤销后）的不算', () => {
    expect(findPurchaseCandidates({ ...ins, workOrderNumbers: ['WO-1', 'WO-2'] }, [line({ workOrderNumber: 'WO-2' })])).toHaveLength(1)
    expect(findPurchaseCandidates(ins, [line({ status: 'ARRIVED' })])).toEqual([])
    expect(findPurchaseCandidates(ins, [line({ status: 'CANCELLED' })])).toEqual([])
    expect(findPurchaseCandidates(ins, [line({ qmsInspectionId: 'old' })])).toEqual([])
  })
  it('报检早于登记日（工厂时区）不算；同一天算', () => {
    expect(findPurchaseCandidates(ins, [line({ createdAt: new Date('2026-10-18T01:00:00Z') })])).toEqual([])
    // 登记在 10-17 15:00（工厂时区），报检 10-17 09:00：同一天，算
    expect(findPurchaseCandidates(ins, [line({ createdAt: new Date('2026-10-17T07:00:00Z') })])).toHaveLength(1)
  })
  it('多条对上：都返回（调用方不自动确认）', () => {
    expect(findPurchaseCandidates(ins, [line(), line({ id: 'L2' })])).toHaveLength(2)
  })
})

describe('comparePayments：按影响排序', () => {
  const p = (id: string, over: Partial<Parameters<typeof comparePayments>[0]> = {}) => ({
    id,
    status: 'PENDING' as const,
    blocksDelivery: false,
    nearestNeedDate: d('2026-11-01') as Date | null,
    requestDate: d('2026-10-01'),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  })
  it('没付的在前 → 卡交期在前 → 需求日近的在前（没有未到货的排后）→ 申请日早的在前', () => {
    const rows = [
      p('paid-blocking', { status: 'PAID', blocksDelivery: true, nearestNeedDate: d('2026-10-18') }),
      p('normal-far', { nearestNeedDate: d('2026-12-01') }),
      p('normal-none', { nearestNeedDate: null }),
      p('blocking-far', { blocksDelivery: true, nearestNeedDate: d('2026-12-01') }),
      p('normal-near-late', { nearestNeedDate: d('2026-10-20'), requestDate: d('2026-10-05') }),
      p('normal-near-early', { nearestNeedDate: d('2026-10-20'), requestDate: d('2026-10-02') }),
      p('blocking-near', { blocksDelivery: true, nearestNeedDate: d('2026-10-19'), status: 'ON_HOLD' }),
    ]
    expect(rows.sort(comparePayments).map((r) => r.id)).toEqual([
      'blocking-near',
      'blocking-far',
      'normal-near-early',
      'normal-near-late',
      'normal-far',
      'normal-none',
      'paid-blocking',
    ])
  })
})

describe('delayStats：付款原因和管理原因分开', () => {
  it('只算延误的；付款单列，供应商 / 我方需求变化 / 其他合并为管理原因；没填的单列', () => {
    const s = delayStats([
      { late: true, delayReason: 'PAYMENT' },
      { late: true, delayReason: 'PAYMENT' },
      { late: true, delayReason: 'SUPPLIER' },
      { late: true, delayReason: 'DEMAND_CHANGE' },
      { late: true, delayReason: 'OTHER' },
      { late: true, delayReason: null },
      { late: false, delayReason: 'PAYMENT' }, // 没延误的不算
    ])
    expect(s).toEqual({ late: 6, payment: 2, management: 3, byReason: { PAYMENT: 2, SUPPLIER: 1, DEMAND_CHANGE: 1, OTHER: 1 }, unfilled: 1 })
  })
})

describe('Excel 行校验', () => {
  it('日期单元格：Excel 日期、文本、序号；不存在的日期拒绝', () => {
    expect(parseDateCell(d('2026-11-20'))).toBe('2026-11-20')
    expect(parseDateCell('2026/1/5')).toBe('2026-01-05')
    expect(parseDateCell('2026年1月5日')).toBe('2026-01-05')
    expect(parseDateCell(46346)).toBe('2026-11-20')
    expect(parseDateCell('2026-02-30')).toBeUndefined()
    expect(parseDateCell('下周')).toBeUndefined()
    expect(parseDateCell(null)).toBeNull()
  })
  it('数量：大于 0、最多 3 位小数', () => {
    expect(parseQuantity(2)).toBe(2)
    expect(parseQuantity('1,200.5')).toBe(1200.5)
    expect(parseQuantity(0)).toBeUndefined()
    expect(parseQuantity(1.2345)).toBeUndefined()
    expect(parseQuantity('abc')).toBeUndefined()
  })

  const ctx: ImportContext = {
    workOrders: new Set(['WO-1', 'WO-HIDDEN']),
    canSee: (wo) => wo !== 'WO-HIDDEN',
    suppliers: [{ id: 'S-1', name: '轴承厂' }],
    users: [
      { id: 'u-1', username: 'zhang', realName: '张三' },
      { id: 'u-2', username: 'li1', realName: '李四' },
      { id: 'u-3', username: 'li2', realName: '李四' },
    ],
    parts: [
      { id: 'P-1', workOrderNumber: 'WO-1', name: '回转平台', drawingNo: 'DWG-1' },
      { id: 'P-2', workOrderNumber: 'WO-1', name: '支腿', drawingNo: 'DWG-2' },
      { id: 'P-3', workOrderNumber: 'WO-1', name: '支腿', drawingNo: 'DWG-3' },
    ],
    existing: [{ workOrderNumber: 'WO-1', materialName: '减速机', spec: null, needDate: d('2026-11-01') }],
    today: '2026-10-17',
  }
  const row = (n: number, v: RawRow['values']): RawRow => ({ row: n, values: { workOrderNumber: 'WO-1', materialName: '回转支承', quantity: 1, needDate: '2026-11-20', ...v } })

  it('合法行：供应商名称一致时关联 QMS 供应商，采购负责人按账号或姓名，工件按图号或名称', () => {
    const r = validateRows([row(2, { supplier: '轴承厂', buyer: '张三', part: 'DWG-1', promisedDate: d('2026-11-10') }), row(3, { materialName: '钢板', supplier: '手填钢厂', buyer: 'li2', part: 'DWG-2' })], ctx)
    expect(r.errors).toEqual([])
    expect(r.lines[0]).toMatchObject({ row: 2, supplierId: 'S-1', supplierName: '轴承厂', buyerId: 'u-1', partId: 'P-1', promisedDate: '2026-11-10' })
    expect(r.lines[1]).toMatchObject({ supplierId: null, supplierName: '手填钢厂', buyerId: 'u-3', partId: 'P-2' })
  })
  it('每行列出全部问题：必填、日期、数量、工单不存在 / 不可见、重名、找不到、到货日在未来、重复', () => {
    const r = validateRows(
      [
        { row: 2, values: { workOrderNumber: null, materialName: null, quantity: null, needDate: null } },
        row(3, { workOrderNumber: 'WO-X' }),
        row(4, { workOrderNumber: 'WO-HIDDEN' }),
        row(5, { needDate: '2026-13-01', quantity: -1 }),
        row(6, { buyer: '李四', part: '支腿' }),
        row(7, { buyer: '王五', part: '不存在' }),
        row(8, { arrivedDate: '2026-10-18' }),
        row(9, { materialName: '减速机', needDate: '2026-11-01' }),
        row(10, { materialName: '链条' }),
        row(11, { materialName: ' 链条 ' }),
      ],
      ctx,
    )
    const by = Object.fromEntries(r.errors.map((e) => [e.row, e.messages.join('；')]))
    expect(by[2]).toBe('工单号必填；物料名称必填；数量必填；需求日必填')
    expect(by[3]).toContain('工单 WO-X 不存在')
    expect(by[4]).toContain('无权查看工单 WO-HIDDEN')
    expect(by[5]).toContain('需求日不是有效日期')
    expect(by[5]).toContain('数量要大于 0')
    expect(by[6]).toContain('采购负责人"李四"有重名')
    expect(by[6]).toContain('工件"支腿"有重名')
    expect(by[7]).toContain('采购负责人"王五"不存在')
    expect(by[7]).toContain('没有工件"不存在"')
    expect(by[8]).toContain('实际到货日不能晚于今天')
    expect(by[9]).toContain('导入过了')
    expect(by[10]).toBeUndefined()
    expect(by[11]).toBe('与第 10 行重复')
    // 有问题的行不进可导入列表
    expect(r.lines.map((l) => l.row)).toEqual([10])
  })
})
