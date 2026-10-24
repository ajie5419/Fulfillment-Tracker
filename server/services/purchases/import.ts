/**
 * 采购行 Excel 导入（R10）：页面下载模板 → 采购员填好 → 上传。用 exceljs 读写 .xlsx。
 *
 * 逐行校验，有任何一行不对就整批不导入，返回每行的问题（行号 = Excel 里的行号），改好后重新上传即可：
 * 不会出现"导了一半"、也不会因为改完重传把已导入的行再导一遍。
 * 同一工单下物料名称 + 规格 + 需求日都相同、且没取消的采购行视为重复（文件里重复、或已经导入过），报错不导。
 *
 * 列按表头名称识别（顺序可调，表头的 * 可有可无）：
 *   工单号*、物料名称*、规格型号、数量*、单位、供应商、需求日*、承诺到货日、实际到货日、采购负责人、工件（名称或图号）、总计划节点、备注
 * 供应商：和 QMS 供应商名称完全一致时关联到该供应商，否则按手填名称保存。
 * 采购负责人：QMS 姓名或账号；工件：该工单下的工件名称或图号。找不到或有重名时报错。
 * 总计划节点（R14，可选列）：按该工单的节点名称匹配；匹配不到（或重名）时留空照常导入，结果里逐行提示（warnings）；
 * 工单已发布总计划、这一行又没填节点的也提示。导入不因节点拦截（页面上可以再补挂）。
 */
import ExcelJS from 'exceljs'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { dayString } from '../../schemas/flow'
import { dateFieldDay, shanghaiDay } from '../alerts/rules'
import { FlowError } from '../flow/errors'
import { parseDay } from '../flow/dates'
import { MAX_IMPORT_ROWS, normalizeName } from './constants'
import { lockParts, purchaseTx, refreshPartReady } from './purchases'
import { clearAlertKeys } from '../alerts/clear'
import { w9SplitKey } from '../plan/constants'

export const TEMPLATE_COLUMNS = [
  { key: 'workOrderNumber', header: '工单号', required: true, width: 18, hint: '必填，QMS 工单号' },
  { key: 'materialName', header: '物料名称', required: true, width: 22, hint: '必填。QMS 进货检验按这个名称自动确认到货，尽量与 QMS 物料名称一致' },
  { key: 'spec', header: '规格型号', required: false, width: 18, hint: '可空' },
  { key: 'quantity', header: '数量', required: true, width: 10, hint: '必填，大于 0，最多 3 位小数' },
  { key: 'unit', header: '单位', required: false, width: 8, hint: '可空，如 台、t、套' },
  { key: 'supplier', header: '供应商', required: false, width: 22, hint: '可空。与 QMS 供应商名称完全一致时自动关联' },
  { key: 'needDate', header: '需求日', required: true, width: 13, hint: '必填，日期，如 2026-11-20' },
  { key: 'promisedDate', header: '承诺到货日', required: false, width: 13, hint: '可空，供应商承诺的到货日' },
  { key: 'arrivedDate', header: '实际到货日', required: false, width: 13, hint: '可空，已经到了的填，不能晚于今天' },
  { key: 'buyer', header: '采购负责人', required: false, width: 12, hint: '可空，QMS 姓名或账号；空 = 采购部负责人' },
  { key: 'part', header: '工件（名称或图号）', required: false, width: 20, hint: '可空，用这批物料的工件；全部到货时给它的第一道工序发"可以开工"' },
  { key: 'planNode', header: '总计划节点', required: false, width: 16, hint: '可空，该工单总计划里的节点名称，如"关键物料到货"；对不上时留空导入并提示' },
  { key: 'note', header: '备注', required: false, width: 24, hint: '可空' },
] as const

type Key = (typeof TEMPLATE_COLUMNS)[number]['key']
type Cell = string | number | Date | null
export type RawRow = { row: number; values: Partial<Record<Key, Cell>> }

export interface RowError {
  row: number
  messages: string[]
}

/** 模板：第一张表是表头（必填列带 *），第二张是填写说明和示例 */
export async function buildTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('关键物料')
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.required ? `${c.header}*` : c.header, key: c.key, width: c.width }))
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  for (const k of ['needDate', 'promisedDate', 'arrivedDate'] as const) ws.getColumn(k).numFmt = 'yyyy-mm-dd'
  const help = wb.addWorksheet('填写说明')
  help.columns = [
    { header: '列', key: 'col', width: 20 },
    { header: '说明', key: 'hint', width: 60 },
    { header: '示例', key: 'example', width: 24 },
  ]
  help.getRow(1).font = { bold: true }
  const example: Record<Key, string> = {
    workOrderNumber: 'WO-2026-001',
    materialName: '回转支承',
    spec: '013.45.1250',
    quantity: '1',
    unit: '套',
    supplier: '某某轴承有限公司',
    needDate: '2026-11-20',
    promisedDate: '2026-11-15',
    arrivedDate: '',
    buyer: '张三',
    part: '回转平台',
    planNode: '关键物料到货',
    note: '进口，周期 90 天',
  }
  for (const c of TEMPLATE_COLUMNS) help.addRow({ col: c.header, hint: c.hint, example: example[c.key] })
  help.addRow({})
  help.addRow({ col: '注意', hint: '只填关键物料（长周期、进口、大件）。从第 2 行开始填，一次最多 500 行；有任何一行不对整批不导入，按提示改好后重新上传。' })
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 单元格 → 字符串 / 数字 / 日期（富文本、公式结果、超链接文字都取出来） */
function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null
  if (v instanceof Date) return v
  if (typeof v === 'string' || typeof v === 'number') return v
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('')
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue)
    if ('text' in v) return String(v.text)
    if ('error' in v) return null
  }
  return String(v)
}

const headerKey = (text: string): Key | undefined => {
  const h = text.replace(/[*＊\s]/g, '')
  return TEMPLATE_COLUMNS.find((c) => c.header.replace(/\s/g, '') === h || (c.key === 'part' && h === '工件'))?.key
}

/** 读第一张表：第 1 行表头，之后每行一条（整行空的跳过） */
export async function readWorkbook(buf: Buffer): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
  } catch {
    throw new FlowError('文件不是有效的 Excel（.xlsx），请用页面上下载的模板填写')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new FlowError('Excel 里没有工作表')
  const cols = new Map<number, Key>()
  ws.getRow(1).eachCell((cell, col) => {
    const k = headerKey(String(cellValue(cell.value) ?? ''))
    if (k && ![...cols.values()].includes(k)) cols.set(col, k)
  })
  const missing = TEMPLATE_COLUMNS.filter((c) => c.required && ![...cols.values()].includes(c.key)).map((c) => c.header)
  if (missing.length) throw new FlowError(`表头不对，缺少列：${missing.join('、')}。请用页面上下载的模板`)
  const rows: RawRow[] = []
  // eachRow 只走有内容的行：稀疏表不会空转上百万次
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r < 2) return
    const values: RawRow['values'] = {}
    let empty = true
    for (const [col, key] of cols) {
      let v = cellValue(row.getCell(col).value)
      if (typeof v === 'string') v = v.trim() || null
      if (v !== null) empty = false
      values[key] = v
    }
    if (empty) return
    if (rows.length >= MAX_IMPORT_ROWS) throw new FlowError(`一次最多导入 ${MAX_IMPORT_ROWS} 行，请分批导入`)
    rows.push({ row: r, values })
  })
  if (!rows.length) throw new FlowError('Excel 里没有数据（从第 2 行开始填）')
  return rows
}

// ───────────── 逐行校验（纯函数） ─────────────

/** 日期单元格：Excel 日期、'YYYY-MM-DD' / 'YYYY/M/D' / 'YYYY.M.D' 文本、Excel 日期序号 → 'YYYY-MM-DD'；不认识返回 undefined */
export function parseDateCell(v: Cell): string | null | undefined {
  if (v === null || v === '') return null
  let s: string
  if (v instanceof Date) {
    if (!Number.isFinite(+v)) return undefined
    s = v.toISOString().slice(0, 10) // exceljs 把 Excel 日期读成当天 UTC 零点
  } else if (typeof v === 'number') {
    if (!(v > 20000 && v < 80000)) return undefined
    s = new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10)
  } else {
    const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(v.trim())
    if (!m) return undefined
    s = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  }
  return dayString.safeParse(s).success ? s : undefined
}

export function parseQuantity(v: Cell): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number.NaN
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return undefined
  if (Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) return undefined
  return n
}

const text = (v: Cell) => (v === null ? null : v instanceof Date ? dateFieldDay(v) : String(v).trim() || null)

export interface ImportContext {
  /** 存在且未删除的工单 */
  workOrders: Set<string>
  canSee: (wo: string) => boolean
  /** 有权修改该工单的采购行（采购部、该工单项目经理、管理员）；不给时不限 */
  canEdit?: (wo: string) => boolean
  /** QMS 供应商（未删除）：名称 → ID；同名多个时不关联 */
  suppliers: { id: string; name: string }[]
  /** 在职用户 */
  users: { id: string; username: string; realName: string | null }[]
  /** 相关工单下的工件 */
  parts: { id: string; workOrderNumber: string; name: string; drawingNo: string | null }[]
  /** 已有的没取消的采购行（查重） */
  existing: { workOrderNumber: string; materialName: string; spec: string | null; needDate: Date }[]
  today: string
  /** 相关工单的总计划节点（R14）；不给时不匹配 */
  planNodes?: { id: string; workOrderNumber: string; name: string }[]
  /** 已发布总计划的工单 */
  publishedWos?: Set<string>
}

export interface ImportLine {
  row: number
  workOrderNumber: string
  materialName: string
  spec: string | null
  quantity: number
  unit: string | null
  supplierId: string | null
  supplierName: string | null
  needDate: string
  promisedDate: string | null
  arrivedDate: string | null
  buyerId: string | null
  partId: string | null
  planNodeId: string | null
  note: string | null
}

const dupKey = (wo: string, name: string, spec: string | null, need: string) => `${wo}\u0000${normalizeName(name)}\u0000${normalizeName(spec)}\u0000${need}`

/** 逐行校验：返回可导入的行、每行的问题（有问题的行不进 lines），以及不拦截的提示（总计划节点对不上等） */
export function validateRows(rows: RawRow[], ctx: ImportContext): { lines: ImportLine[]; errors: RowError[]; warnings: RowError[] } {
  const lines: ImportLine[] = []
  const errors: RowError[] = []
  const warnings: RowError[] = []
  const seen = new Map<string, number>()
  for (const e of ctx.existing) seen.set(dupKey(e.workOrderNumber, e.materialName, e.spec, dateFieldDay(e.needDate)), 0)
  for (const { row, values: v } of rows) {
    const msgs: string[] = []
    const wo = text(v.workOrderNumber ?? null)
    if (!wo) msgs.push('工单号必填')
    else if (!ctx.workOrders.has(wo)) msgs.push(`工单 ${wo} 不存在`)
    else if (!ctx.canSee(wo)) msgs.push(`无权查看工单 ${wo}`)
    else if (ctx.canEdit && !ctx.canEdit(wo)) msgs.push(`无权修改工单 ${wo} 的采购行（采购部、该工单项目经理或管理员）`)
    const materialName = text(v.materialName ?? null)
    if (!materialName) msgs.push('物料名称必填')
    else if (materialName.length > 191) msgs.push('物料名称最多 191 字')
    const spec = text(v.spec ?? null)
    if (spec && spec.length > 191) msgs.push('规格型号最多 191 字')
    const quantity = parseQuantity(v.quantity ?? null)
    if (quantity === undefined) msgs.push(v.quantity == null ? '数量必填' : '数量要大于 0，最多 3 位小数')
    const unit = text(v.unit ?? null)
    if (unit && unit.length > 20) msgs.push('单位最多 20 字')
    const dates = { needDate: '需求日', promisedDate: '承诺到货日', arrivedDate: '实际到货日' } as const
    const d: Record<keyof typeof dates, string | null> = { needDate: null, promisedDate: null, arrivedDate: null }
    for (const [k, label] of Object.entries(dates) as [keyof typeof dates, string][]) {
      const parsed = parseDateCell(v[k] ?? null)
      if (parsed === undefined) msgs.push(`${label}不是有效日期（如 2026-11-20）`)
      else d[k] = parsed
    }
    if (!d.needDate && v.needDate == null) msgs.push('需求日必填')
    if (d.arrivedDate && d.arrivedDate > ctx.today) msgs.push('实际到货日不能晚于今天')
    let supplierId: string | null = null
    const supplierName = text(v.supplier ?? null)
    if (supplierName) {
      if (supplierName.length > 191) msgs.push('供应商最多 191 字')
      const same = ctx.suppliers.filter((s) => s.name.trim() === supplierName)
      if (same.length === 1) supplierId = same[0]!.id
    }
    let buyerId: string | null = null
    const buyer = text(v.buyer ?? null)
    if (buyer) {
      const byAccount = ctx.users.filter((u) => u.username === buyer)
      const byName = ctx.users.filter((u) => u.realName?.trim() === buyer)
      const hit = byAccount.length === 1 ? byAccount : byName
      if (hit.length === 1) buyerId = hit[0]!.id
      else msgs.push(hit.length ? `采购负责人"${buyer}"有重名，请填 QMS 账号` : `采购负责人"${buyer}"不存在或已停用`)
    }
    let partId: string | null = null
    const part = text(v.part ?? null)
    if (part && wo && ctx.workOrders.has(wo)) {
      const inWo = ctx.parts.filter((p) => p.workOrderNumber === wo)
      const byDrawing = inWo.filter((p) => p.drawingNo?.trim() === part)
      const byName = inWo.filter((p) => p.name.trim() === part)
      const hit = byDrawing.length === 1 ? byDrawing : byName
      if (hit.length === 1) partId = hit[0]!.id
      else msgs.push(hit.length ? `工件"${part}"有重名，请填图号` : `工单 ${wo} 下没有工件"${part}"`)
    }
    let planNodeId: string | null = null
    const nodeName = text(v.planNode ?? null)
    if (wo && ctx.workOrders.has(wo)) {
      if (nodeName) {
        const hit = (ctx.planNodes ?? []).filter((n) => n.workOrderNumber === wo && n.name.trim() === nodeName)
        if (hit.length === 1) planNodeId = hit[0]!.id
        else warnings.push({ row, messages: [hit.length ? `总计划节点"${nodeName}"有重名，已留空，请在页面上选择` : `工单 ${wo} 的总计划里没有节点"${nodeName}"，已留空`] })
      } else if (ctx.publishedWos?.has(wo)) {
        warnings.push({ row, messages: [`工单 ${wo} 已发布总计划，这一行没填总计划节点，已留空，请在页面上补挂`] })
      }
    }
    const note = text(v.note ?? null)
    if (note && note.length > 500) msgs.push('备注最多 500 字')
    if (wo && materialName && d.needDate) {
      const k = dupKey(wo, materialName, spec, d.needDate)
      const prev = seen.get(k)
      if (prev === 0) msgs.push('已经有同工单、同物料、同规格、同需求日的采购行（导入过了？）')
      else if (prev !== undefined) msgs.push(`与第 ${prev} 行重复`)
      else seen.set(k, row)
    }
    if (msgs.length) {
      errors.push({ row, messages: msgs })
      continue
    }
    lines.push({
      row,
      workOrderNumber: wo!,
      materialName: materialName!,
      spec,
      quantity: quantity!,
      unit,
      supplierId,
      supplierName,
      needDate: d.needDate!,
      promisedDate: d.promisedDate,
      arrivedDate: d.arrivedDate,
      buyerId,
      partId,
      planNodeId,
      note,
    })
  }
  return { lines, errors, warnings }
}

// ───────────── 导入 ─────────────

export interface ImportResult {
  imported: number
  /** 有问题的行；不为空时什么都没导入 */
  errors: RowError[]
  /** 不拦截的提示（总计划节点对不上、已发布总计划却没填节点）；导入照常 */
  warnings: RowError[]
  rows: number
}

export async function importPurchases(
  buf: Buffer,
  actorId: string,
  canSee: (wo: string) => boolean,
  now = new Date(),
  canEdit?: (wo: string) => boolean,
): Promise<ImportResult> {
  const rows = await readWorkbook(buf)
  const wos = [...new Set(rows.map((r) => text(r.values.workOrderNumber ?? null)).filter((x): x is string => !!x))]
  const [workOrders, suppliers, users, parts, existing, planNodes, plans] = await Promise.all([
    prisma.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: wos }, isDeleted: false }, select: { workOrderNumber: true } }),
    prisma.qmsSupplier.findMany({ where: { isDeleted: false, kind: 'SUPPLIER' }, select: { id: true, name: true } }),
    prisma.qmsUser.findMany({ where: { isDeleted: false, status: 'ACTIVE' }, select: { id: true, username: true, realName: true } }),
    prisma.part.findMany({ where: { workOrderNumber: { in: wos } }, select: { id: true, workOrderNumber: true, name: true, drawingNo: true } }),
    prisma.purchaseLine.findMany({ where: { workOrderNumber: { in: wos }, status: { not: 'CANCELLED' } }, select: { workOrderNumber: true, materialName: true, spec: true, needDate: true } }),
    prisma.planNode.findMany({ where: { workOrderNumber: { in: wos } }, select: { id: true, workOrderNumber: true, name: true } }),
    prisma.workOrderPlan.findMany({ where: { workOrderNumber: { in: wos }, status: 'PUBLISHED' }, select: { workOrderNumber: true } }),
  ])
  const { lines, errors, warnings } = validateRows(rows, {
    workOrders: new Set(workOrders.map((w) => w.workOrderNumber)),
    canSee,
    canEdit,
    suppliers,
    users,
    parts,
    existing,
    today: shanghaiDay(now),
    planNodes,
    publishedWos: new Set(plans.map((p) => p.workOrderNumber)),
  })
  if (errors.length) return { imported: 0, errors, warnings, rows: rows.length }
  await purchaseTx(async (tx) => {
    // 先锁要挂的工件（与确认到货同一加锁顺序：工件 → 采购行）
    await lockParts(tx, lines.map((l) => l.partId))
    const data: Prisma.PurchaseLineCreateManyInput[] = lines.map((l) => ({
      workOrderNumber: l.workOrderNumber,
      partId: l.partId,
      materialName: l.materialName,
      spec: l.spec,
      quantity: l.quantity,
      unit: l.unit,
      supplierId: l.supplierId,
      supplierName: l.supplierName,
      needDate: parseDay(l.needDate),
      promisedDate: l.promisedDate ? parseDay(l.promisedDate) : null,
      buyerId: l.buyerId,
      planNodeId: l.planNodeId,
      note: l.note,
      createdBy: actorId,
      ...(l.arrivedDate ? { status: 'ARRIVED' as const, arrivedDate: parseDay(l.arrivedDate), arrivalSource: 'PC' as const, arrivedBy: actorId, arrivedAt: now } : {}),
    }))
    await tx.purchaseLine.createMany({ data })
    // 挂上节点的：节点已分解，清掉"未分解"提醒
    await clearAlertKeys(tx, [...new Set(lines.map((l) => l.planNodeId).filter((x): x is string => !!x))].map(w9SplitKey))
    // 挂上了未到货物料的工件：作废没处理的"可以开工"
    for (const partId of new Set(lines.filter((l) => l.partId && !l.arrivedDate).map((l) => l.partId!))) await refreshPartReady(tx, partId, false)
  })
  return { imported: lines.length, errors: [], warnings, rows: rows.length }
}
