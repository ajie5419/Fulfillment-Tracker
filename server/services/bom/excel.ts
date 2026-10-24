/**
 * 技术部 BOM（CAD 导出的 Excel）随图纸发放单一起下发（zhao 10-24：BOM 不单独导入，设计完成、下发图纸时自然带出）。
 * 发放时在同一个事务里按图号建工件（applyTechBom），生产、工艺签收发放单时就看到这批工件。这是工件的主来源。
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
import type { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'

export const MAX_BOM_ROWS = 2000
/** 单个工件数量上限（同图号合并后也不能超过） */
export const MAX_QUANTITY = 100000
/** .xlsx 的 MIME（BOM 表上传后 upload_file.mime） */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type Key = 'drawingNo' | 'revision' | 'name' | 'quantity'
const HEADERS: Record<Key, string[]> = {
  drawingNo: ['图号', '零件图号', '部件图号', '代号', '图样代号'],
  revision: ['版号', '版本', '版本号', '版次'],
  name: ['部件名称', '零件名称', '名称'],
  quantity: ['数量', '件数'],
}
/** 数量可以没有：技术部的「图纸明细表」只有代号、名称、张数（张数是图纸张数，不是零件数量），没有数量时每个图号按 1 件建 */
const REQUIRED: Key[] = ['drawingNo', 'name']
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
  /** 表里没有数量列：按 1 件建，提示由生产核对 */
  noQuantityColumn?: boolean
}

export interface BomSheet {
  rows: RawBomRow[]
  /** 表头上方写的工单号（如"工单号：25TL-CL-2626-2"），没写为 null */
  workOrderNumber: string | null
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

/** 在一张表里找表头行：同一行里认出图号、名称两列（数量、版号可选） */
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

/** 表格到这里结束：合计、签字栏 */
const END_RE = /^(合计|总计|编制|审核|批准)/
/** 表头上方的工单号：同一格"工单号：X"，或"工单号"一格、值在右边一格 */
const WO_RE = /工单号\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_/.]*)/

function findWorkOrder(ws: ExcelJS.Worksheet, headerRow: number): string | null {
  for (let r = 1; r < headerRow; r++) {
    const cells: string[] = []
    ws.getRow(r).eachCell((cell) => cells.push(String(cellValue(cell.value) ?? '')))
    for (let k = 0; k < cells.length; k++) {
      const m = WO_RE.exec(cells[k]!)
      if (m) return m[1]!
      if (/工单号\s*[:：]?$/.test(cells[k]!.trim()) && cells[k + 1]) return cells[k + 1]!.trim() || null
    }
  }
  return null
}

/**
 * 读 Excel：取第一张能认出表头的工作表，表头下面每行一条。
 * 整行空的跳过；合并单元格只认左上角那格（表尾跨列的说明行不会被当成零件）；碰到"合计""编制""审核"等签字栏就结束。
 */
export async function readBomFile(buf: Buffer): Promise<BomSheet> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
  } catch {
    throw new FlowError('文件不是有效的 Excel（.xlsx）。CAD 导出的如果是 .xls，请用 Excel 另存为 .xlsx 再选')
  }
  for (const ws of wb.worksheets) {
    const header = findHeader(ws)
    if (!header) continue
    const noQuantityColumn = ![...header.cols.values()].includes('quantity')
    const rows: RawBomRow[] = []
    let ended = false
    // eachRow 只走有内容的行：稀疏表（如只在第 1048576 行有一个格）不会空转上百万次
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (ended || r <= header.row) return
      let isEnd = false
      row.eachCell((cell) => {
        if (cell.master.address === cell.address && END_RE.test(String(cellValue(cell.value) ?? ''))) isEnd = true
      })
      if (isEnd) {
        ended = true
        return
      }
      const v: Partial<Record<Key, Cell>> = {}
      let empty = true
      for (const [col, key] of header.cols) {
        const cell = row.getCell(col)
        // 合并单元格的其他格读出来是左上角的值：只认左上角
        const c = cell.master.address === cell.address ? cellValue(cell.value) : null
        if (c !== null) empty = false
        v[key] = c
      }
      if (empty) return
      if (rows.length >= MAX_BOM_ROWS) throw new FlowError(`一张 BOM 表最多 ${MAX_BOM_ROWS} 行`)
      rows.push({
        row: r,
        drawingNo: text(v.drawingNo ?? null),
        revision: text(v.revision ?? null),
        name: text(v.name ?? null),
        quantity: noQuantityColumn ? 1 : (v.quantity ?? null),
        ...(noQuantityColumn ? { noQuantityColumn } : {}),
      })
    })
    if (!rows.length) throw new FlowError('Excel 表头下面没有数据')
    return { rows, workOrderNumber: findWorkOrder(ws, header.row) }
  }
  throw new FlowError(`没找到表头：需要在同一行里有 ${REQUIRED.map((k) => LABEL[k]).join('、')} 两列（如"代号""名称"；数量、版号可选）`)
}

export const readBomWorkbook = async (buf: Buffer) => (await readBomFile(buf)).rows

/** 粘贴的明细最多多少字（2000 行 × 每行约 100 字） */
export const MAX_BOM_TEXT = 200_000

/**
 * 把从 Word / Excel / PDF 复制来的明细表文字转成 .xlsx（之后和上传的 Excel 走同一套读表、归类；这份 xlsx 也作为发放单的 BOM 表存档）。
 * 有制表符按制表符分列，没有就按空白分列。认不出表头时补一行表头（代号、名称，有第三列再加数量）；
 * 每行第一列是纯数字且后面还有两列以上时当序号去掉。
 * 空行原样留成空行（读表时跳过），所以 xlsx 行号 - rowOffset = 粘贴内容里的第几行，报错时按这个行号告诉用户。
 */
export async function bomTextToXlsx(textIn: string): Promise<{ buf: Buffer; rowOffset: number }> {
  const lines = textIn.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map((l) => l.trim())
  const filled = lines.filter(Boolean)
  if (!filled.length) throw new FlowError('请粘贴明细')
  if (filled.length > MAX_BOM_ROWS + HEADER_SCAN_ROWS) throw new FlowError(`一张 BOM 表最多 ${MAX_BOM_ROWS} 行`)
  const byTab = filled.some((l) => l.includes('\t'))
  let grid = lines.map((l) => (!l ? [] : (byTab ? l.split('\t') : l.split(/\s+/)).map((c) => c.trim())))
  const hasHeader = grid.slice(0, HEADER_SCAN_ROWS).some((row) => {
    const keys = new Set(row.map(headerKey).filter(Boolean))
    return REQUIRED.every((k) => keys.has(k))
  })
  if (!hasHeader) {
    grid = grid.map((row) => {
      const cells = row.filter((c) => c !== '')
      return cells.length >= 3 && /^\d+$/.test(cells[0]!) ? cells.slice(1) : cells
    })
    // 有第三列才当有数量列；只有代号、名称两列时按每个图号 1 件
    grid.unshift(grid.some((r) => r.length >= 3) ? ['代号', '名称', '数量'] : ['代号', '名称'])
  }
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('明细').addRows(grid)
  return { buf: Buffer.from(await wb.xlsx.writeBuffer()), rowOffset: hasHeader ? 0 : 1 }
}

/** 表上写的工单号和发放时选的工单不一样（忽略大小写和空格）；表上没写不算 */
export const workOrderMismatch = (sheet: string | null, selected: string) => !!sheet && drawingKey(sheet) !== drawingKey(selected)

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
  return Number.isInteger(n) && n >= 1 && n <= MAX_QUANTITY ? n : undefined
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
      // 同一图号两行版号不一样：说不清按哪个版发，整张拦下（不然会绕过和已有工件的版号比对）
      if (drawingKey(revision) !== drawingKey(same.revision)) {
        errors.push({ row: r.row, messages: [`图号 ${drawingNo} 的版号"${revision ?? '空'}"和第 ${same.rows[0]} 行的"${same.revision ?? '空'}"不一致`] })
        continue
      }
      if (same.quantity + quantity! > MAX_QUANTITY) {
        // 合计超过上限时报错，不悄悄截断
        errors.push({ row: r.row, messages: [`图号 ${drawingNo} 合并后数量 ${same.quantity + quantity!} 超过 ${MAX_QUANTITY}`] })
        continue
      }
      same.rows.push(r.row)
      same.quantity += quantity!
      if (name && name !== same.name) same.notes.push(`第 ${r.row} 行名称是"${name}"，按第 ${same.rows[0]} 行的"${same.name}"建`)
      continue
    }
    const old = have.get(key)
    const line: BomLine = { rows: [r.row], drawingNo, revision, name: name ?? drawingNo, quantity: quantity!, status: 'new', notes: [] }
    if (r.noQuantityColumn) line.notes.push('表里没有数量列，按每个图号 1 件建，数量请生产核对')
    if (old) {
      line.existing = { id: old.id, name: old.name, revision: old.revision }
      // 表里有版号、已有工件没有或不同，都算版号不一致：没有的发放时补上，不同的拦下走设计变更
      const changed = !!revision && (!old.revision || drawingKey(revision) !== drawingKey(old.revision))
      line.status = changed ? 'revisionChanged' : 'exists'
      line.notes.push(
        !changed ? `已有工件"${old.name}"，不重复建，一并关联到发放单`
        : old.revision ? `已有工件"${old.name}"是版号 ${old.revision}，表里是 ${revision}：版号变了不能随图纸发放，请发"设计变更"`
        : `已有工件"${old.name}"没记版号，发放时补上版号 ${revision}`,
      )
    }
    byKey.set(key, line)
    lines.push(line)
  }
  // 合并后再说明一次
  for (const l of lines) if (l.rows.length > 1) l.notes.unshift(`文件里出现 ${l.rows.length} 次（第 ${l.rows.join('、')} 行），数量合计 ${l.quantity}`)
  return { lines, errors }
}

// ───────────── 预览 / 随发放单建工件 ─────────────

async function assertWorkOrder(workOrderNumber: string) {
  const wo = await prisma.qmsWorkOrder.findFirst({ where: { workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
  if (!wo) throw new FlowError('工单不存在或已删除')
}

const loadExisting = (db: Pick<typeof prisma, 'part'>, workOrderNumber: string) =>
  db.part.findMany({ where: { workOrderNumber, drawingNo: { not: null } }, select: { id: true, name: true, drawingNo: true, revision: true }, orderBy: { createdAt: 'asc' } })

/**
 * 预览：读文件 → 归类，不写库。blocking 为版号变了、发放时会被拦下的图号数；
 * sheetWorkOrder 为表上写的工单号，和选的工单不一样时 workOrderMismatch = true（发放时拦下）。
 */
/** rowOffset：粘贴的明细（bomTextToXlsx）把行号换成粘贴内容里的第几行，提示文字里的行号也跟着对上 */
export async function previewTechBom(workOrderNumber: string, buf: Buffer, rowOffset = 0) {
  await assertWorkOrder(workOrderNumber)
  const sheet = await readBomFile(buf)
  const rows = sheet.rows.map((r) => ({ ...r, row: r.row - rowOffset }))
  const sheetWorkOrder = sheet.workOrderNumber
  const { lines, errors } = classifyBom(rows, await loadExisting(prisma, workOrderNumber))
  const blocking = lines.filter((l) => l.status === 'revisionChanged' && l.existing?.revision).length
  return { rows: rows.length, lines, errors, blocking, sheetWorkOrder, workOrderMismatch: workOrderMismatch(sheetWorkOrder, workOrderNumber) }
}

export interface TechBomResult {
  /** 新建的工件 */
  created: string[]
  /** 已有、本次 BOM 也有的工件（发放单一并关联） */
  matched: string[]
  /** 原来没记版号、这次补上版号的工件数 */
  revisionFilled: number
  /** 不建的行：螺栓螺母、没有图号的外购件 */
  skipped: number
}

/**
 * 在调用方的事务里按 BOM 建工件（发放图纸时用）。调用方须已锁住工单行（qms_work_order FOR UPDATE），
 * 这里再按 ID 顺序锁住该工单的全部工件，读最新数据后归类：
 *   - 有任何行错误：整张发放单不发，报出前几行的问题；
 *   - 已有同图号工件、版号不同（双方都有版号）：不发，提示走设计变更；已有工件没记版号的补上版号；
 *   - 其余新图号建工件，已有的一并关联到发放单。
 * 分批发图纸时每批只带自己那部分 BOM，按图号累加，不会重复建。
 */
export async function applyTechBom(tx: Prisma.TransactionClient, workOrderNumber: string, rows: RawBomRow[]): Promise<TechBomResult> {
  await tx.$queryRaw`SELECT id FROM part WHERE workOrderNumber = ${workOrderNumber} ORDER BY id FOR UPDATE`
  const { lines, errors } = classifyBom(rows, await loadExisting(tx, workOrderNumber))
  if (errors.length) {
    const head = errors.slice(0, 5).map((e) => `第 ${e.row} 行：${e.messages.join('，')}`).join('；')
    throw new FlowError(`BOM 表有 ${errors.length} 行不对，没有发放：${head}${errors.length > 5 ? ' 等' : ''}`)
  }
  const conflict = lines.filter((l) => l.status === 'revisionChanged' && l.existing?.revision)
  if (conflict.length) {
    const head = conflict.slice(0, 5).map((l) => `${l.drawingNo}（已有 ${l.existing!.revision}，表里 ${l.revision}）`).join('、')
    throw new FlowError(`BOM 里 ${conflict.length} 个图号的版号和已有工件不一样，没有发放：${head}。版号变了请发"设计变更"`)
  }
  const fill = lines.filter((l) => l.status === 'revisionChanged' && !l.existing?.revision)
  for (const l of fill) await tx.part.update({ where: { id: l.existing!.id }, data: { revision: l.revision } })
  const toCreate = lines.filter((l) => l.status === 'new')
  const created: string[] = []
  for (const l of toCreate) {
    const p = await tx.part.create({
      data: { workOrderNumber, name: l.name, drawingNo: l.drawingNo, revision: l.revision, quantity: l.quantity, fromTechBom: true },
      select: { id: true },
    })
    created.push(p.id)
  }
  const matched = lines.filter((l) => (l.status === 'exists' || l.status === 'revisionChanged') && l.existing).map((l) => l.existing!.id)
  if (!created.length && !matched.length) throw new FlowError('BOM 表里没有要建的工件（只有螺栓螺母或没有图号的行），没有发放')
  return { created, matched, revisionFilled: fill.length, skipped: lines.filter((l) => l.status === 'fastener' || l.status === 'noDrawing').length }
}
