/**
 * 从技术部 BOM Excel（CAD 导出）导入工件。这是工件的主来源：工单一下达就能导，不用等 QMS 里品质人员按图纸录完。
 *
 * 规则：
 *   - 列按表头名称识别（图号、版号、部件名称、数量；顺序随意），表头可以不在第 1 行（CAD 导出常带标题行）；
 *   - 每个图号建一个工件（名称、图号、版号、数量），不建工序：自制还是外协由生产识别后再排；
 *   - 螺栓、螺母不建工件（生产辅材采购）；没有图号的行不建（外购件走技术部的采购计划）；
 *   - 文件里同一图号出现多次（挂在不同部件下）合成一个工件，数量相加；
 *   - 工单里已有同图号的工件就跳过，绝不修改已有工件；版号不一样时单独列出，按设计变更处理；
 *   - 数量不是正整数等错误：整批不导入，列出每行问题（行号 = Excel 行号）。
 * 图号和 QMS 用的是同一套编号，之后"从 QMS BOM 导入"会按图号关联到这里建的工件（补 QMS 零件 ID 和工序），不会重复建。
 */
import ExcelJS from 'exceljs'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'

export const MAX_BOM_ROWS = 2000

type Key = 'drawingNo' | 'revision' | 'name' | 'quantity'
const HEADERS: Record<Key, string[]> = {
  drawingNo: ['图号', '零件图号', '部件图号', '代号', '图样代号'],
  revision: ['版号', '版本', '版本号', '版次'],
  name: ['部件名称', '零件名称', '名称'],
  quantity: ['数量', '件数'],
}
const REQUIRED: Key[] = ['drawingNo', 'name', 'quantity']
const LABEL: Record<Key, string> = { drawingNo: '图号', revision: '版号', name: '部件名称', quantity: '数量' }
/** 表头最多往下找这么多行 */
const HEADER_SCAN_ROWS = 20

type Cell = string | number | null

export interface RawBomRow {
  row: number
  drawingNo: string | null
  revision: string | null
  name: string | null
  quantity: Cell
}

/** 图号比较用：去空白、转大写（CAD 和手工录入的大小写、空格常不一致） */
export const drawingKey = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, '').toUpperCase()

/** 螺栓、螺母由生产辅材采购，不建工件 */
export const isFastener = (name: string | null) => !!name && /螺栓|螺母/.test(name)

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim() || null
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue)
    if ('text' in v) return String(v.text).trim() || null
    if ('error' in v) return null
  }
  return String(v).trim() || null
}

const norm = (s: string) => s.replace(/[*＊\s:：]/g, '')
const headerKey = (text: string): Key | undefined => {
  const h = norm(text)
  return (Object.keys(HEADERS) as Key[]).find((k) => HEADERS[k].includes(h))
}
const text = (c: Cell) => (c === null ? null : String(c).trim() || null)

/** 在一张表里找表头行：同一行里认出图号、部件名称、数量三列 */
function findHeader(ws: ExcelJS.Worksheet): { row: number; cols: Map<number, Key> } | null {
  const last = Math.min(ws.rowCount, HEADER_SCAN_ROWS)
  for (let r = 1; r <= last; r++) {
    const cols = new Map<number, Key>()
    ws.getRow(r).eachCell((cell, col) => {
      const k = headerKey(String(cellValue(cell.value) ?? ''))
      if (k && ![...cols.values()].includes(k)) cols.set(col, k)
    })
    if (REQUIRED.every((k) => [...cols.values()].includes(k))) return { row: r, cols }
  }
  return null
}

/** 读 Excel：取第一张能认出表头的工作表，表头下面每行一条（整行空的跳过） */
export async function readBomWorkbook(buf: Buffer): Promise<RawBomRow[]> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
  } catch {
    throw new FlowError('文件不是有效的 Excel（.xlsx）。CAD 导出的如果是 .xls，请用 Excel 另存为 .xlsx 再导入')
  }
  for (const ws of wb.worksheets) {
    const header = findHeader(ws)
    if (!header) continue
    const rows: RawBomRow[] = []
    for (let r = header.row + 1; r <= ws.rowCount; r++) {
      const v: Partial<Record<Key, Cell>> = {}
      let empty = true
      for (const [col, key] of header.cols) {
        const c = cellValue(ws.getRow(r).getCell(col).value)
        if (c !== null) empty = false
        v[key] = c
      }
      if (empty) continue
      if (rows.length >= MAX_BOM_ROWS) throw new FlowError(`一次最多导入 ${MAX_BOM_ROWS} 行`)
      rows.push({ row: r, drawingNo: text(v.drawingNo ?? null), revision: text(v.revision ?? null), name: text(v.name ?? null), quantity: v.quantity ?? null })
    }
    if (!rows.length) throw new FlowError('Excel 表头下面没有数据')
    return rows
  }
  throw new FlowError(`没找到表头：需要在同一行里有 ${REQUIRED.map((k) => LABEL[k]).join('、')} 三列（版号可选）`)
}

// ───────────── 归类（纯函数） ─────────────

export type BomLineStatus = 'new' | 'exists' | 'revisionChanged' | 'fastener' | 'noDrawing'

export interface BomLine {
  /** 文件里的行号（合并后为第一次出现的行） */
  rows: number[]
  drawingNo: string | null
  revision: string | null
  name: string
  quantity: number
  status: BomLineStatus
  /** 已有工件（exists / revisionChanged） */
  existing?: { id: string; name: string; revision: string | null }
  notes: string[]
}

export interface ExistingPart {
  id: string
  name: string
  drawingNo: string | null
  revision: string | null
}

export interface BomRowError {
  row: number
  messages: string[]
}

function parseQuantity(v: Cell): number | undefined {
  if (v === null) return undefined
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，\s]/g, ''))
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : undefined
}

/** 行 → 待导入清单：校验数量、合并同图号、对照工单里已有的工件 */
export function classifyBom(rows: RawBomRow[], existing: ExistingPart[]): { lines: BomLine[]; errors: BomRowError[] } {
  const errors: BomRowError[] = []
  const lines: BomLine[] = []
  const byKey = new Map<string, BomLine>()
  const have = new Map<string, ExistingPart>()
  for (const p of existing) {
    const k = drawingKey(p.drawingNo)
    if (k && !have.has(k)) have.set(k, p)
  }
  for (const r of rows) {
    const messages: string[] = []
    const name = r.name?.slice(0, 191) ?? null
    const drawingNo = r.drawingNo?.slice(0, 191) ?? null
    const revision = r.revision?.slice(0, 64) ?? null
    if (!name && !drawingNo) continue // 只有数量等零散内容的行（小计、备注）不算
    if (isFastener(name)) {
      lines.push({ rows: [r.row], drawingNo, revision, name: name!, quantity: parseQuantity(r.quantity) ?? 0, status: 'fastener', notes: ['螺栓、螺母由生产辅材采购，不建工件'] })
      continue
    }
    if (!drawingNo) {
      lines.push({ rows: [r.row], drawingNo: null, revision, name: name!, quantity: parseQuantity(r.quantity) ?? 0, status: 'noDrawing', notes: ['没有图号：外购件走技术部采购计划，不建工件'] })
      continue
    }
    const quantity = parseQuantity(r.quantity)
    if (quantity === undefined) messages.push(r.quantity === null ? '数量没填' : `数量"${r.quantity}"不对，要是 1 到 100000 的整数`)
    if (messages.length) {
      errors.push({ row: r.row, messages })
      continue
    }
    const key = drawingKey(drawingNo)
    const same = byKey.get(key)
    if (same) {
      same.rows.push(r.row)
      same.quantity = Math.min(same.quantity + quantity!, 100000)
      if (name && name !== same.name) same.notes.push(`第 ${r.row} 行名称是"${name}"，按第 ${same.rows[0]} 行的"${same.name}"建`)
      if (revision && revision !== same.revision) same.notes.push(`第 ${r.row} 行版号是"${revision}"，和第 ${same.rows[0]} 行"${same.revision ?? '空'}"不一致`)
      continue
    }
    const old = have.get(key)
    const line: BomLine = { rows: [r.row], drawingNo, revision, name: name ?? drawingNo, quantity: quantity!, status: 'new', notes: [] }
    if (old) {
      line.existing = { id: old.id, name: old.name, revision: old.revision }
      const changed = !!revision && !!old.revision && drawingKey(revision) !== drawingKey(old.revision)
      line.status = changed ? 'revisionChanged' : 'exists'
      line.notes.push(changed ? `已有工件"${old.name}"是版号 ${old.revision}，表里是 ${revision}：不自动改，按设计变更处理` : `已有工件"${old.name}"，跳过`)
    }
    byKey.set(key, line)
    lines.push(line)
  }
  // 合并后再说明一次
  for (const l of lines) if (l.rows.length > 1) l.notes.unshift(`文件里出现 ${l.rows.length} 次（第 ${l.rows.join('、')} 行），数量合计 ${l.quantity}`)
  return { lines, errors }
}

// ───────────── 预览 / 导入 ─────────────

async function assertWorkOrder(workOrderNumber: string) {
  const wo = await prisma.qmsWorkOrder.findFirst({ where: { workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
  if (!wo) throw new FlowError('工单不存在或已删除')
}

const loadExisting = (db: Pick<typeof prisma, 'part'>, workOrderNumber: string) =>
  db.part.findMany({ where: { workOrderNumber, drawingNo: { not: null } }, select: { id: true, name: true, drawingNo: true, revision: true }, orderBy: { createdAt: 'asc' } })

/** 预览：读文件 → 归类，不写库 */
export async function previewTechBom(workOrderNumber: string, buf: Buffer) {
  await assertWorkOrder(workOrderNumber)
  const rows = await readBomWorkbook(buf)
  const { lines, errors } = classifyBom(rows, await loadExisting(prisma, workOrderNumber))
  return { rows: rows.length, lines, errors }
}

/**
 * 导入勾选的图号（整批一个事务）。服务端重新读一次文件、对照最新的工件；有行错误整批不导。
 * selected 为空表示导入全部可导入的。
 */
export async function importTechBom(workOrderNumber: string, buf: Buffer, selected: string[] | null) {
  await assertWorkOrder(workOrderNumber)
  const rows = await readBomWorkbook(buf)
  return prisma.$transaction(async (tx) => {
    // 锁住这个工单的工件行，两个人同时导同一份 BOM 时后一个等前一个提交，再按图号跳过
    await tx.$queryRaw`SELECT id FROM part WHERE workOrderNumber = ${workOrderNumber} FOR UPDATE`
    const { lines, errors } = classifyBom(rows, await loadExisting(tx, workOrderNumber))
    if (errors.length) return { created: 0, skipped: 0, errors, rows: rows.length }
    const want = selected ? new Set(selected.map(drawingKey)) : null
    const toCreate = lines.filter((l) => l.status === 'new' && (!want || want.has(drawingKey(l.drawingNo))))
    if (!toCreate.length) throw new FlowError(selected ? '勾选的图号都已经有工件了，没有要导入的' : '没有要导入的工件（都已存在，或是螺栓螺母、没有图号的行）')
    await tx.part.createMany({
      data: toCreate.map((l) => ({ workOrderNumber, name: l.name, drawingNo: l.drawingNo, revision: l.revision, quantity: l.quantity, fromTechBom: true })),
    })
    return { created: toCreate.length, skipped: lines.length - toCreate.length, errors: [], rows: rows.length }
  })
}
