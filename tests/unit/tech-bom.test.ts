/** 技术部 BOM Excel 导入：读表头、归类（螺栓螺母、没图号、同图号合并、已有工件、版号不同）；QMS BOM 按图号关联（纯函数，不连库） */
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { classifyBom, drawingKey, readBomWorkbook, type RawBomRow } from '../../server/services/bom/excel'
import { planBomImport } from '../../server/services/bom/import'
import type { QmsBomItem } from '../../server/services/bom/client'

async function xlsx(rows: (string | number | null)[][], sheets: (string | number | null)[][][] = []) {
  const wb = new ExcelJS.Workbook()
  for (const s of sheets) wb.addWorksheet().addRows(s)
  wb.addWorksheet('BOM').addRows(rows)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const raw = (row: number, drawingNo: string | null, name: string | null, quantity: string | number | null, revision: string | null = null): RawBomRow => ({ row, drawingNo, name, quantity, revision })

describe('readBomWorkbook', () => {
  it('表头不在第 1 行、列顺序随意、带别名；跳过空行', async () => {
    const buf = await xlsx(
      [
        ['XX 项目明细表'],
        [],
        ['序号', '部件名称', '数量', '版号', '图号 '],
        [1, '主梁', 2, 'A', 'ZL-001'],
        [],
        [2, '端梁', '4', null, 'DL-002'],
      ],
      [[['说明页'], ['随便写点']]],
    )
    expect(await readBomWorkbook(buf)).toEqual([
      { row: 4, drawingNo: 'ZL-001', revision: 'A', name: '主梁', quantity: 2 },
      { row: 6, drawingNo: 'DL-002', revision: null, name: '端梁', quantity: '4' },
    ])
  })

  it('认不出表头 / 不是 Excel 时给中文提示', async () => {
    await expect(readBomWorkbook(await xlsx([['名称', '数量'], ['主梁', 1]]))).rejects.toThrow('没找到表头')
    await expect(readBomWorkbook(Buffer.from('not a zip'))).rejects.toThrow('不是有效的 Excel')
  })

  it('稀疏表（最后一行在第 1048576 行）只读有内容的行，不空转', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('BOM')
    ws.addRows([['图号', '部件名称', '数量'], ['ZL-001', '主梁', 1]])
    ws.getCell('A1048576').value = 'X-END'
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const t0 = Date.now()
    const rows = await readBomWorkbook(buf)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(rows.map((r) => [r.row, r.drawingNo])).toEqual([[2, 'ZL-001'], [1048576, 'X-END']])
  })
})

describe('classifyBom', () => {
  it('螺栓螺母不建、没图号不建；同图号合并数量；数量不对报行错误', () => {
    const { lines, errors } = classifyBom(
      [
        raw(2, 'ZL-001', '主梁', 2, 'A'),
        raw(3, 'GB/T 5782', '六角头螺栓 M20', 48),
        raw(4, null, '减速机', 1),
        raw(5, 'zl-001 ', '主梁', 1, 'A'),
        raw(6, 'ZT-003', '支腿', 'x'),
        raw(7, 'ZT-004', '支腿2', null),
        raw(8, null, null, 3), // 小计行
      ],
      [],
    )
    expect(errors).toEqual([
      { row: 6, messages: ['数量"x"不对，要是 1 到 100000 的整数'] },
      { row: 7, messages: ['数量没填'] },
    ])
    expect(lines.map((l) => [l.rows, l.drawingNo, l.name, l.quantity, l.status])).toEqual([
      [[2, 5], 'ZL-001', '主梁', 3, 'new'],
      [[3], 'GB/T 5782', '六角头螺栓 M20', 48, 'fastener'],
      [[4], null, '减速机', 1, 'noDrawing'],
    ])
    expect(lines[0]!.notes[0]).toBe('文件里出现 2 次（第 2、5 行），数量合计 3')
  })

  it('已有同图号工件跳过；版号不同单列，不自动改', () => {
    const { lines } = classifyBom(
      [raw(2, 'ZL-001', '主梁', 2, 'B'), raw(3, 'DL-002', '端梁', 1, 'A'), raw(4, 'ZT-003', '支腿', 1)],
      [
        { id: 'p1', name: '主梁（现场名）', drawingNo: 'ZL-001', revision: 'A' },
        { id: 'p2', name: '端梁', drawingNo: 'dl-002', revision: null },
      ],
    )
    expect(lines.map((l) => [l.drawingNo, l.status, l.existing?.id])).toEqual([
      ['ZL-001', 'revisionChanged', 'p1'],
      // 已有工件没记版号、表里是 A：也单列提示
      ['DL-002', 'revisionChanged', 'p2'],
      ['ZT-003', 'new', undefined],
    ])
  })

  it('同图号合并后数量超过上限：报错，不悄悄截断', () => {
    const { lines, errors } = classifyBom([raw(2, 'ZL-001', '主梁', 60000), raw(3, 'ZL-001', '主梁', 60000)], [])
    expect(errors).toEqual([{ row: 3, messages: ['图号 ZL-001 合并后数量 120000 超过 100000'] }])
    expect(lines.map((l) => l.quantity)).toEqual([60000])
  })

  it('已有工件没记版号、表里有版号：也算版号不一致，不自动改', () => {
    const { lines } = classifyBom([raw(2, 'ZL-001', '主梁', 1, 'A'), raw(3, 'DL-002', '端梁', 1)], [
      { id: 'p1', name: '主梁', drawingNo: 'ZL-001', revision: null },
      { id: 'p2', name: '端梁', drawingNo: 'DL-002', revision: null },
    ])
    expect(lines.map((l) => [l.drawingNo, l.status])).toEqual([['ZL-001', 'revisionChanged'], ['DL-002', 'exists']])
    expect(lines[0]!.notes).toEqual(['已有工件"主梁"没记版号，表里是 A：不自动改，需要的话在工件上补版号'])
  })

  it('图号比较忽略空格和大小写', () => {
    expect(drawingKey(' zl - 001 ')).toBe('ZL-001')
  })
})

describe('planBomImport 按图号关联', () => {
  const row = (id: string, partNumber: string | null): QmsBomItem => ({
    id,
    partId: `P-${id}`,
    partName: `零件${id}`,
    partNumber,
    material: null,
    quantity: 1,
    unit: null,
    remarks: null,
    processes: [{ processId: 'PRC-CUT', processName: '下料' }],
  })
  const known = new Set(['PRC-CUT'])

  it('同图号的已有工件只关联不新建；已有工序的不补工序；QMS 重复录入的第二行跳过', () => {
    const linkable = new Map([
      ['ZL-001', { id: 'p1', name: '主梁', hasSteps: false }],
      ['DL-002', { id: 'p2', name: '端梁', hasSteps: true }],
    ])
    const plan = planBomImport([row('1', 'zl-001'), row('2', 'DL-002'), row('3', 'ZT-003'), row('4', 'ZL-001')], ['1', '2', '3', '4'], new Set(), known, linkable)
    expect(plan.link).toEqual([
      { qmsBomId: '1', partId: 'p1', qmsPartId: 'P-1', processIds: ['PRC-CUT'] },
      { qmsBomId: '2', partId: 'p2', qmsPartId: 'P-2', processIds: [] },
    ])
    expect(plan.create.map((p) => p.qmsBomId)).toEqual(['3'])
    expect(plan.skipped).toEqual(['4'])
    expect(plan.warnings).toEqual(['零件4：图号 ZL-001 在 QMS 里录了不止一行，已关联到工件"主梁"，这行跳过'])
  })

  it('上次已关联过的图号：之后再勾选同图号的 QMS 行也不新建', () => {
    const plan = planBomImport([row('5', 'ZL-001'), row('6', 'ZT-003')], ['5', '6'], new Set(), known, new Map(), new Map([['ZL-001', '主梁']]))
    expect(plan.create.map((p) => p.qmsBomId)).toEqual(['6'])
    expect(plan.skipped).toEqual(['5'])
    expect(plan.warnings[0]).toBe('零件5：图号 ZL-001 已有关联 QMS 的工件"主梁"，这行跳过')
  })

  it('同图号既有已关联、又有未关联的工件：已关联优先，这行跳过', () => {
    const linkable = new Map([['ZL-001', { id: 'p9', name: '主梁（手建）', hasSteps: false }]])
    const plan = planBomImport([row('7', 'ZL-001')], ['7'], new Set(), known, linkable, new Map([['ZL-001', '主梁']]))
    expect(plan.link).toEqual([])
    expect(plan.create).toEqual([])
    expect(plan.skipped).toEqual(['7'])
  })
})
