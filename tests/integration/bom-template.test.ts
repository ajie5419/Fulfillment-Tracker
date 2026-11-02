/**
 * R8 BOM 导入与路线模板：真实 MySQL + 模拟 QMS（scripts/mock-qms-sync.mjs 的 BOM 接口，走真实 HTTP），直接调用服务层。
 * 覆盖：预览（已导入标记、跳过的工序）、导入字段映射、整批事务、重复导入跳过且不改已有工件、QMS 新增行/删行、
 * QMS 故障与凭据错误；模板新建/改名冲突/套用（复制、开工日推算）/改模板不影响已套用工件/另存为模板/删除；演示 BOM 与清除。
 * 运行：TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration
 */
import { execFileSync } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockIdentityBridge } from '../../scripts/mock-identity-bridge.mjs'
import { loadFixture } from '../../scripts/mock-qms-sync.mjs'
import { getTestDatabaseUrl } from '../helpers/test-database'

const DB = getTestDatabaseUrl(process.env.TEST_DATABASE_URL)
const SECRET = 'local-dev-secret-local-dev-secret-0'
const WO1 = 'QMS-WO-2026-001'
const WO2 = 'QMS-WO-2026-002'
const WO3 = 'QMS-WO-2026-003'
const ACTOR = 'u-001'

type Services = {
  sync: typeof import('../../server/services/sync/sync')
  bom: typeof import('../../server/services/bom/import')
  techBom: typeof import('../../server/services/bom/excel')
  source: typeof import('../../server/services/bom/source')
  steps: typeof import('../../server/services/flow/steps')
  templates: typeof import('../../server/services/templates/templates')
  demo: typeof import('../../server/services/dev/demo')
}
type Mock = Awaited<ReturnType<typeof startMockIdentityBridge>>

describe.skipIf(!DB)('R8 BOM 导入与路线模板', () => {
  let db: PrismaClient
  let s: Services
  let mock: Mock
  let config: { apiBase: string; clientId: string; clientSecret: string; enabled: boolean }
  const load = (wo: string, devTools = false) => s.source.loadWorkOrderBom(wo, { config, devTools })

  beforeAll(async () => {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'ignore' })
    process.env.DATABASE_URL = DB
    s = {
      sync: await import('../../server/services/sync/sync'),
      bom: await import('../../server/services/bom/import'),
      techBom: await import('../../server/services/bom/excel'),
      source: await import('../../server/services/bom/source'),
      steps: await import('../../server/services/flow/steps'),
      templates: await import('../../server/services/templates/templates'),
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
    await db.routeTemplate.deleteMany()
    await db.qmsInspection.deleteMany()
    await db.qmsWorkOrder.deleteMany()
    await db.qmsSupplier.deleteMany()
    await db.qmsProcess.deleteMany()
    await db.qmsDepartment.deleteMany()
    await db.qmsUser.deleteMany()
    mock = await startMockIdentityBridge({ sync: loadFixture() })
    config = { apiBase: mock.url, clientId: 'fulfillment', clientSecret: SECRET, enabled: true }
    const r = await s.sync.syncQms({ config, adminIds: [], only: ['work-orders', 'suppliers', 'processes'] })
    expect(r.resources.every((x) => x.status === 'ok')).toBe(true)
  })

  afterAll(async () => {
    await mock?.close()
    await db?.$disconnect()
  })

  it('预览：实时读 QMS BOM，标出履约查不到的工序；QMS 没有 BOM 的工单是空列表', async () => {
    const preview = (await s.bom.previewBom(WO1, await load(WO1))).items
    expect(preview.map((r) => [r.bomId, r.partName, r.imported])).toEqual([
      ['bom-001', '主梁结构件', false],
      ['bom-002', '支腿', false],
    ])
    expect(preview[1]!.processes.map((p) => [p.processName, p.problem])).toEqual([
      ['机加', null],
      ['探伤', '在 QMS 没有关联工序'],
      ['涂装', null],
    ])
    expect(await s.bom.previewBom(WO2, await load(WO2))).toEqual({ items: [], hasTechBom: false, missingInQms: [] })
  })

  it('导入：每行一个工件 + 按顺序的工序（自制、无负责人 → 待补充）；跳过的工序给出提示', async () => {
    const r = await s.bom.importBom(WO1, await load(WO1), ['bom-001', 'bom-002'])
    expect(r).toEqual({ created: 2, linked: 0, steps: 4, skipped: 0, missing: 0, warnings: ['支腿：工序"探伤"在 QMS 没有关联工序，已跳过'] })
    const parts = await s.steps.listParts(WO1)
    expect(parts.map((p) => ({ name: p.name, drawingNo: p.drawingNo, quantity: p.quantity, qmsPartId: p.qmsPartId, qmsBomId: p.qmsBomId }))).toEqual([
      { name: '主梁结构件', drawingNo: 'ZL-001', quantity: 2, qmsPartId: 'qms-part-001', qmsBomId: 'bom-001' },
      { name: '支腿', drawingNo: 'ZT-002', quantity: 4, qmsPartId: 'qms-part-002', qmsBomId: 'bom-002' },
    ])
    expect(parts[1]!.steps.map((x) => [x.seq, x.processName, x.mode, x.ownerId, x.needsFill])).toEqual([
      [1, '机加', 'SELF', null, true],
      [2, '涂装', 'SELF', null, true],
    ])
    // 补上负责人后不再待补充；改成外协但没选外协厂又算待补充
    const step = parts[1]!.steps[0]!
    await s.steps.updateStep(step.id, { ownerId: ACTOR })
    expect((await s.steps.listParts(WO1))[1]!.steps[0]!.needsFill).toBe(false)
    await s.steps.updateStep(step.id, { mode: 'EXTERNAL_OUTSOURCE' })
    expect((await s.steps.listParts(WO1))[1]!.steps[0]!.needsFill).toBe(true)
  })

  it('重复导入：已导入的跳过，绝不改已有工件；QMS 新增的行照常导入，已删的行单列', async () => {
    const before = await db.part.findFirstOrThrow({ where: { qmsBomId: 'bom-001' } })
    await db.part.update({ where: { id: before.id }, data: { name: '主梁结构件（现场改名）' } })
    const again = await s.bom.importBom(WO1, await load(WO1), ['bom-001', 'bom-002'])
    expect(again).toEqual({ created: 0, linked: 0, steps: 0, skipped: 2, missing: 0, warnings: [] })
    expect((await db.part.findUniqueOrThrow({ where: { id: before.id } })).name).toBe('主梁结构件（现场改名）')
    expect(await db.routeStep.count({ where: { partId: before.id } })).toBe(2)

    const fixture = loadFixture().boms[WO1]
    mock.sync!.setBom(WO1, [
      fixture[0],
      { ...fixture[0], id: 'bom-003', partId: 'qms-part-003', partName: '端梁', partNumber: 'DL-003', processes: [{ position: 0, processId: 'prc-weld', processName: '组焊' }] },
    ])
    expect((await s.bom.previewBom(WO1, await load(WO1))).items.map((r) => [r.bomId, r.imported])).toEqual([
      ['bom-001', true],
      ['bom-003', false],
    ])
    const r = await s.bom.importBom(WO1, await load(WO1), ['bom-001', 'bom-002', 'bom-003'])
    expect(r).toMatchObject({ created: 1, steps: 1, skipped: 1, missing: 1 })
    expect(await db.part.count({ where: { workOrderNumber: WO1 } })).toBe(3)
  })

  it('整批一个事务：中途失败（工单不存在）什么都不建；QMS 故障、凭据不对给出中文错误', async () => {
    const rows = await load(WO1)
    await expect(s.bom.importBom('NO-SUCH-WO', rows, ['bom-001'])).rejects.toThrow('工单不存在')
    expect(await db.part.count({ where: { workOrderNumber: 'NO-SUCH-WO' } })).toBe(0)
    await expect(s.bom.importBom(WO1, rows, [])).rejects.toThrow('请勾选')

    mock.sync!.failNext('bom', 1, 503)
    await expect(load(WO1)).rejects.toThrow('读取 QMS BOM 失败：QMS BOM 接口返回 503')
    const wrong = s.source.loadWorkOrderBom(WO1, { config: { ...config, clientSecret: 'wrong-secret-wrong-secret-wrong-00' }, devTools: false })
    await expect(wrong).rejects.toThrow('401')
    await expect(wrong).rejects.not.toThrow('secret')
  })

  it('模板：新建、套用到没有工序的工件（复制，负责人默认操作人，按开工日推算日期）、改模板不影响已套用的工件', async () => {
    const t = await s.templates.createTemplate(
      {
        name: '结构件路线',
        description: '下料外协',
        steps: [
          { processId: 'prc-weld', mode: 'EXTERNAL_OUTSOURCE', supplierId: 'sup-weld', defaultDays: 7 },
          { processId: 'prc-paint', mode: 'SELF', defaultDays: 3 },
        ],
      },
      ACTOR,
    )
    // 自制只能带厂内班组（10-26 派工到班组），外协厂直接拒绝，不再悄悄丢掉
    await expect(s.templates.createTemplate({ name: '自制带外协厂', steps: [{ processId: 'prc-paint', mode: 'SELF', supplierId: 'sup-weld' }] }, ACTOR)).rejects.toThrow('只能派给厂内班组')
    await expect(s.templates.createTemplate({ name: '结构件路线', steps: [{ processId: 'prc-weld', mode: 'SELF' }] }, ACTOR)).rejects.toThrow('模板名称已存在')
    await expect(s.templates.createTemplate({ name: '坏模板', steps: [{ processId: 'prc-nope', mode: 'SELF' }] }, ACTOR)).rejects.toThrow('不存在或已停用')

    const part = await s.steps.createPart(WO2, { name: '手工工件', quantity: 1 })
    expect(await s.templates.applyTemplate(part.id, t.id, 'u-002', '2026-11-01')).toEqual({ copied: 2, template: '结构件路线' })
    const steps = await db.routeStep.findMany({ where: { partId: part.id }, orderBy: { seq: 'asc' } })
    expect(steps.map((x) => [x.seq, x.processId, x.mode, x.supplierId, x.ownerId, x.dueDate?.toISOString().slice(0, 10)])).toEqual([
      [1, 'prc-weld', 'EXTERNAL_OUTSOURCE', 'sup-weld', 'u-002', '2026-11-08'],
      [2, 'prc-paint', 'SELF', null, 'u-002', '2026-11-11'],
    ])
    await expect(s.templates.applyTemplate(part.id, t.id, ACTOR)).rejects.toThrow('已经有工序链')

    await s.templates.updateTemplate(t.id, { name: '结构件路线 v2', steps: [{ processId: 'prc-mach', mode: 'SELF' }] })
    const list = await s.templates.listTemplates()
    expect(list.find((x) => x.id === t.id)!.steps.map((x) => x.processName)).toEqual(['机加'])
    expect(await db.routeStep.count({ where: { partId: part.id } })).toBe(2) // 已套用的不变

    // 另存为模板、删除模板（已套用的工件不受影响）
    const imported = await db.part.findFirstOrThrow({ where: { qmsBomId: 'bom-001' } })
    const saved = await s.templates.saveTemplateFromPart(imported.id, { name: '主梁路线' }, ACTOR)
    expect((await db.routeTemplateStep.findMany({ where: { templateId: saved.id }, orderBy: { seq: 'asc' } })).map((x) => x.processId)).toEqual(['prc-weld', 'prc-paint'])
    await s.templates.deleteTemplate(t.id)
    await expect(s.templates.deleteTemplate(t.id)).rejects.toThrow('不存在')
    expect(await db.routeStep.count({ where: { partId: part.id } })).toBe(2)
  })

  it('演示：DEMO- 工单读演示 BOM（不连 QMS），带演示模板；清除演示数据一并删掉', async () => {
    const seeded = await s.demo.seedDemo({ skipUsers: true })
    expect(seeded.templates).toBe(1)
    const rows = await load('DEMO-WO-002', true)
    expect(rows).toHaveLength(3)
    const r = await s.bom.importBom('DEMO-WO-002', rows, rows.map((x) => x.id))
    expect(r).toMatchObject({ created: 3, steps: 7, warnings: ['横梁：工序"探伤"在 QMS 没有关联工序，已跳过'] })
    // 演示工具关着时 DEMO- 工单也走 QMS（模拟 QMS 里没有 → 空）
    expect(await load('DEMO-WO-002', false)).toEqual([])
    const demoPart = await s.steps.createPart('DEMO-WO-003', { name: '演示空工件', quantity: 1 })
    expect(await s.templates.applyTemplate(demoPart.id, 'DEMO-TPL-001', ACTOR)).toMatchObject({ copied: 3 })

    const reset = await s.demo.resetDemo()
    expect(reset.templates).toBe(1)
    expect(await db.part.count({ where: { workOrderNumber: { startsWith: 'DEMO-' } } })).toBe(0)
    expect(await db.routeTemplate.count({ where: { name: '主梁路线' } })).toBe(1) // 真实模板不动
  })
  it('技术部 BOM Excel：建工件不建工序、螺栓螺母和没图号的不建、再发同一份只关联不重复建；之后 QMS BOM 按图号关联，不重复建', async () => {
    const book = async (rows: (string | number | null)[][]) => {
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('BOM').addRows(rows)
      return Buffer.from(await wb.xlsx.writeBuffer())
    }
    const buf = await book([
      ['车架 BOM 明细'],
      ['图号', '版号', '部件名称', '数量'],
      ['zl-001 ', 'A', '主梁', 1],
      ['ZL-001', 'A', '主梁', 1],
      ['DL-009', 'B', '端梁', 2],
      ['GB5783', null, '六角头螺栓 M16', 40],
      [null, null, '减速机', 1],
    ])
    const preview = await s.techBom.previewTechBom(WO3, buf)
    expect(preview.errors).toEqual([])
    expect(preview.lines.map((l) => [l.drawingNo, l.status, l.quantity])).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/ZL-001/i), 'new', 2],
        ['DL-009', 'new', 2],
      ]),
    )
    expect(preview.lines.filter((l) => l.status === 'fastener' || l.status === 'noDrawing')).toHaveLength(2)

    // 随图纸发放建工件（发放单那一层见 drawing.test.ts），这里直接在事务里调
    const apply = async (b: Buffer) => {
      const rows = await s.techBom.readBomWorkbook(b)
      const r = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT workOrderNumber FROM qms_work_order WHERE workOrderNumber = ${WO3} FOR UPDATE`
        return s.techBom.applyTechBom(tx, WO3, rows)
      })
      return { created: r.created.length, matched: r.matched.length, skipped: r.skipped }
    }
    expect(await apply(buf)).toMatchObject({ created: 2, matched: 0, skipped: 2 })
    const parts = await db.part.findMany({ where: { workOrderNumber: WO3 }, include: { steps: true }, orderBy: { name: 'asc' } })
    expect(parts.map((p) => [p.name, p.revision, p.quantity, p.fromTechBom, p.steps.length, p.qmsPartId])).toEqual([
      ['主梁', 'A', 2, true, 0, null],
      ['端梁', 'B', 2, true, 0, null],
    ])
    // 再发同一份：都已存在，不建、只关联
    expect(await apply(buf)).toMatchObject({ created: 0, matched: 2 })
    expect(await db.part.count({ where: { workOrderNumber: WO3 } })).toBe(2)
    // 版号变了：预览标出来（发放时会拦下），不自动改
    const v2 = await book([
      ['图号', '版号', '部件名称', '数量'],
      ['DL-009', 'C', '端梁', 2],
    ])
    const p2 = await s.techBom.previewTechBom(WO3, v2)
    expect(p2.lines.map((l) => l.status)).toEqual(['revisionChanged'])
    expect(p2.blocking).toBe(1)
    await expect(apply(v2)).rejects.toThrow('版号变了')
    expect((await db.part.findFirstOrThrow({ where: { workOrderNumber: WO3, drawingNo: 'DL-009' } })).revision).toBe('B')

    // QMS 录完：同图号的关联到已有工件（补 QMS 零件 ID 和工序），只有 QMS 有的新建
    const fixture = loadFixture().boms[WO1]
    mock.sync!.setBom(WO3, [
      { ...fixture[0], id: 'bom-301', partId: 'qms-part-301', partName: '主梁结构件', partNumber: 'ZL-001' },
      { ...fixture[0], id: 'bom-302', partId: 'qms-part-302', partName: '吊耳', partNumber: 'DE-010', processes: [{ position: 0, processId: 'prc-weld', processName: '组焊' }] },
    ])
    const qmsPreview = await s.bom.previewBom(WO3, await load(WO3))
    expect(qmsPreview.hasTechBom).toBe(true)
    const r = await s.bom.importBom(WO3, await load(WO3), ['bom-301', 'bom-302'])
    expect(r).toMatchObject({ created: 1, linked: 1 })
    const after = await db.part.findMany({ where: { workOrderNumber: WO3 }, include: { _count: { select: { steps: true } } }, orderBy: { name: 'asc' } })
    expect(after.map((p) => [p.name, p.drawingNo, p.qmsPartId, p.qmsBomId, p._count.steps])).toEqual([
      ['主梁', expect.stringMatching(/ZL-001/i), 'qms-part-301', 'bom-301', fixture[0].processes.filter((x: { processId: string | null }) => x.processId).length],
      ['吊耳', 'DE-010', 'qms-part-302', 'bom-302', 1],
      ['端梁', 'DL-009', null, null, 0],
    ])
  })
})
