/** R8：BOM 导入的映射与幂等计划、BOM 客户端、模板复制、"待补充"判定（纯函数，不连库） */
import { describe, expect, it } from 'vitest'
import { bomPath, fetchWorkOrderBom, type QmsBomItem } from '../../server/services/bom/client'
import { mapBomRow, planBomImport } from '../../server/services/bom/import'
import { needsFill } from '../../server/services/flow/steps'
import { QmsSyncError } from '../../server/services/sync/client'
import { routeFromTemplate } from '../../server/services/templates/templates'

const row = (id: string, over: Partial<QmsBomItem> = {}): QmsBomItem => ({
  id,
  partId: `P-${id}`,
  partName: `零件${id}`,
  partNumber: `DWG-${id}`,
  material: 'Q355B',
  quantity: 2,
  unit: '件',
  remarks: null,
  processes: [
    { processId: 'PRC-CUT', processName: '下料' },
    { processId: 'PRC-WELD', processName: '组焊' },
  ],
  ...over,
})
const known = new Set(['PRC-CUT', 'PRC-WELD', 'PRC-PAINT'])

describe('mapBomRow', () => {
  it('BOM 行 → 工件（名称、图号、数量、QMS 零件 ID、BOM 行 ID）+ 按顺序的工序', () => {
    const { plan, warnings } = mapBomRow(row('1', { processes: [{ processId: 'PRC-WELD', processName: '组焊' }, { processId: 'PRC-CUT', processName: '下料' }] }), known)
    expect(plan).toEqual({
      qmsBomId: '1',
      part: { name: '零件1', drawingNo: 'DWG-1', quantity: 2, qmsPartId: 'P-1' },
      processIds: ['PRC-WELD', 'PRC-CUT'],
    })
    expect(warnings).toEqual([])
  })

  it('没有工序 ID、或履约副本里没有的工序跳过并提示；其余照常', () => {
    const { plan, warnings } = mapBomRow(
      row('2', {
        processes: [
          { processId: 'PRC-CUT', processName: '下料' },
          { processId: null, processName: '探伤' },
          { processId: 'PRC-GONE', processName: '热处理' },
          { processId: 'PRC-PAINT', processName: '涂装' },
        ],
      }),
      known,
    )
    expect(plan.processIds).toEqual(['PRC-CUT', 'PRC-PAINT'])
    expect(warnings).toEqual(['零件2：工序"探伤"在 QMS 没有关联工序，已跳过', '零件2：工序"热处理"在履约还没有同步到，已跳过'])
  })

  it('数量至少 1；空名称用 BOM 行号兜底；空图号、空零件 ID 存空', () => {
    const { plan } = mapBomRow(row('3', { partName: '  ', partNumber: '', partId: null, quantity: 0, processes: [] }), known)
    expect(plan.part).toEqual({ name: 'BOM 行 3', drawingNo: null, quantity: 1, qmsPartId: null })
    expect(plan.processIds).toEqual([])
  })
})

describe('planBomImport（幂等）', () => {
  const rows = [row('1'), row('2'), row('3')]

  it('已导入的跳过，QMS 里已没有的单列，重复勾选只算一次', () => {
    const plan = planBomImport(rows, ['1', '2', '2', '9'], new Set(['2']), known)
    expect(plan.create.map((p) => p.qmsBomId)).toEqual(['1'])
    expect(plan.skipped).toEqual(['2'])
    expect(plan.missing).toEqual(['9'])
  })

  it('第二次导入同一批：全部跳过，不建任何东西', () => {
    const first = planBomImport(rows, ['1', '2', '3'], new Set(), known)
    const imported = new Set(first.create.map((p) => p.qmsBomId))
    const second = planBomImport(rows, ['1', '2', '3'], imported, known)
    expect(first.create).toHaveLength(3)
    expect(second).toEqual({ create: [], link: [], skipped: ['1', '2', '3'], missing: [], warnings: [] })
  })
})

describe('fetchWorkOrderBom', () => {
  const cfg = { apiBase: 'http://qms.test:3000', clientId: 'fulfillment', clientSecret: 'super-secret-value-super-secret-00', enabled: false }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('带客户端请求头、工单号编码进路径；同步开关关着也能读', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const items = await fetchWorkOrderBom(cfg, 'WO/2026 001', async (url, init) => {
      seen = { url: String(url), headers: init!.headers as Record<string, string> }
      return json({ code: 0, data: { workOrderNumber: 'WO/2026 001', items: [{ id: 'b1', partId: null, partName: '主梁', partNumber: null, quantity: 3, processes: [{ position: 0, processId: 'p1', processName: '组焊' }] }] } })
    })
    expect(new URL(seen!.url).pathname).toBe(bomPath('WO/2026 001'))
    expect(bomPath('WO/2026 001')).toBe('/api/integration/fulfillment/work-orders/WO%2F2026%20001/bom')
    expect(seen!.headers).toMatchObject({ 'X-Identity-Client-Id': 'fulfillment', 'X-Identity-Client-Secret': cfg.clientSecret })
    expect(items).toEqual([{ id: 'b1', partId: null, partName: '主梁', partNumber: null, material: null, quantity: 3, unit: null, remarks: null, processes: [{ processId: 'p1', processName: '组焊' }] }])
  })

  it('404（QMS 未升级）、未配置凭据都报中文错误，错误里不带密钥', async () => {
    const err = await fetchWorkOrderBom(cfg, 'WO-1', async () => json({}, 404)).catch((e) => e)
    expect(err).toBeInstanceOf(QmsSyncError)
    expect(err.message).toContain('需先升级 QMS')
    expect(err.message).not.toContain(cfg.clientSecret)
    await expect(fetchWorkOrderBom({ ...cfg, clientSecret: '' }, 'WO-1', async () => json({}))).rejects.toThrow('没有配置')
  })
})

describe('routeFromTemplate（套用模板 = 复制）', () => {
  const steps = [
    { processId: 'PRC-CUT', mode: 'SELF' as const, supplierId: 'S-x', defaultDays: 2 },
    { processId: 'PRC-WELD', mode: 'EXTERNAL_OUTSOURCE' as const, supplierId: 'S-2', defaultDays: null },
    { processId: 'PRC-PAINT', mode: 'EXTERNAL_OUTSOURCE' as const, supplierId: null, defaultDays: 5 },
  ]

  it('复制工序、方式、外协厂 / 班组（自制可带派工班组，10-26 起）；不给开工日就不设日期', () => {
    expect(routeFromTemplate(steps)).toEqual([
      { seq: 1, processId: 'PRC-CUT', mode: 'SELF', supplierId: 'S-x', planStartDate: null, dueDate: null },
      { seq: 2, processId: 'PRC-WELD', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'S-2', planStartDate: null, dueDate: null },
      { seq: 3, processId: 'PRC-PAINT', mode: 'EXTERNAL_OUTSOURCE', supplierId: null, planStartDate: null, dueDate: null },
    ])
  })

  it('给了开工日：按默认工期逐道累加日历天；没填工期的那道不设日期、也不占天数', () => {
    const due = routeFromTemplate(steps, '2026-10-30').map((r) => r.dueDate?.toISOString().slice(0, 10) ?? null)
    expect(due).toEqual(['2026-11-01', null, '2026-11-06'])
    // 应开工日 = 上一道的要求完成日（没填工期的那道不占天数）
    const start = routeFromTemplate(steps, '2026-10-30').map((r) => r.planStartDate?.toISOString().slice(0, 10) ?? null)
    expect(start).toEqual(['2026-10-30', '2026-11-01', '2026-11-01'])
  })

  it('结果是新对象：之后改模板步骤不影响已生成的步骤', () => {
    const src = [{ ...steps[0]! }]
    const out = routeFromTemplate(src)
    src[0]!.processId = 'CHANGED'
    expect(out[0]!.processId).toBe('PRC-CUT')
  })
})

describe('needsFill（待补充）', () => {
  const s = (over: Partial<Parameters<typeof needsFill>[0]> = {}) => needsFill({ status: 'PENDING', ownerId: 'u-1', mode: 'SELF', supplierId: null, ...over })
  it('缺负责人、或外协没选外协厂 → 待补充；已开工的不算', () => {
    expect(s()).toBe(false)
    expect(s({ ownerId: null })).toBe(true) // BOM 导入的默认状态
    expect(s({ mode: 'EXTERNAL_OUTSOURCE' })).toBe(true)
    expect(s({ mode: 'IN_PLANT_OUTSOURCE', supplierId: 'T-1' })).toBe(false)
    expect(s({ ownerId: null, status: 'IN_PROGRESS' })).toBe(false)
  })
})

describe('dayString', () => {
  it('rejects calendar-invalid dates', async () => {
    const { dayString } = await import('../../server/schemas/flow')
    expect(dayString.safeParse('2026-10-18').success).toBe(true)
    expect(dayString.safeParse('2028-02-29').success).toBe(true)
    expect(dayString.safeParse('2026-13-45').success).toBe(false)
    expect(dayString.safeParse('2026-02-30').success).toBe(false)
    expect(dayString.safeParse('2026-1-5').success).toBe(false)
  })
})
