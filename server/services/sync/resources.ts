/**
 * 7 类资源的字段校验（契约 v1）与写入只读副本（upsert，isDeleted 照抄）。
 * 契约里没有、副本表里有的列（如演示数据的 roleName）更新时不动。
 * 工单（履约新建工单 10-27 契约）：QMS 新版多输出 customerNameId、division、divisionId、version，都是可选的——
 *   旧 QMS 不输出时这几列更新时不动（不会被清空）；输出 null 时照写 null。
 */
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import type { SyncResource } from './client'

type Tx = Prisma.TransactionClient

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s))
const optDate = isoDate.nullish().transform((v) => v ?? null)
/** QMS 的 ID 大多是 cuid 字符串，个别表可能是数字，统一成字符串 */
const id = z
  .union([z.string().min(1), z.number()])
  .transform(String)
  .pipe(z.string().max(64))
const optId = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined || v === '' ? null : String(v)))
  .pipe(z.string().max(64).nullable())
const optText = z
  .string()
  .nullish()
  .transform((v) => v ?? null)
const int = z.coerce.number().int()
const base = { isDeleted: z.boolean().default(false), updatedAt: isoDate }

/** 可选字段：不带（旧 QMS）= undefined，写库时不动该列；带 null / 空串 = null */
const keepId = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : String(v)))
  .pipe(z.string().max(64).nullish())
const keepText = z.string().nullish()

/** 工单对象：同步接口 items 和履约写接口（新建 / 修改 / 取消）返回的 data 都是这个形状 */
export const qmsWorkOrderSchema = z.object({
  workOrderNumber: id,
  projectName: optText,
  customerName: optText,
  customerNameId: keepId,
  division: keepText,
  divisionId: keepId,
  quantity: int.default(0),
  deliveryDate: isoDate,
  status: z.string().max(20),
  version: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : Number(v)))
    .pipe(z.number().int().nullish()),
  ...base,
})
export type QmsWorkOrderRow = z.output<typeof qmsWorkOrderSchema>

/**
 * 写一行工单副本。本地已有更新的（updatedAt 更晚，如履约刚写入 QMS 后存下的返回值）时不覆盖：
 * 防止同步早一步拉到的旧页在履约写入之后才落库，把新数据改回去。
 */
export async function writeWorkOrderCopy(tx: Tx, r: QmsWorkOrderRow) {
  const cur = await tx.qmsWorkOrder.findUnique({ where: { workOrderNumber: r.workOrderNumber }, select: { updatedAt: true } })
  if (cur && cur.updatedAt > r.updatedAt) return
  const data = { ...r, customerName: r.customerName ?? '' }
  await tx.qmsWorkOrder.upsert({ where: { workOrderNumber: r.workOrderNumber }, create: data, update: data })
}

const supplier = z.object({
  id,
  name: z.string(),
  category: optText,
  outsourcingMode: optText,
  status: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? null : String(v).slice(0, 40))),
  // 新契约里 suppliers 只有真实供应商（kind 恒为 SUPPLIER 或不带）；班组改走 teams。
  // 旧版 QMS 仍可能在这里返回 kind = TEAM 的行：照旧按班组写入，不把已有班组改成供应商。
  kind: z
    .string()
    .nullish()
    .transform((v) => (v === 'TEAM' ? 'TEAM' : 'SUPPLIER')),
  ...base,
})

/** 厂内外协班组（QMS teams）：和供应商同存 qms_supplier（kind = TEAM，id 与报检的 teamId 相同） */
const team = z.object({
  id,
  name: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  ...base,
})

const process = z.object({
  id,
  name: z.string(),
  code: optText.pipe(z.string().max(64).nullable()),
  status: int.default(1),
  ...base,
})

const department = z.object({
  id,
  name: z.string(),
  parentId: optId.transform((v) => v ?? '0'),
  status: int.default(1),
  ...base,
})

const user = z.object({
  id,
  username: z.string(),
  realName: optText,
  departmentId: optId,
  isActive: z.boolean(),
  ...base,
})

const inspection = z.object({
  id,
  requestNo: z.string().max(64),
  workOrderNumber: id,
  workOrderNumbers: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
  partId: optId,
  partName: optText.transform((v) => v ?? ''),
  processId: optId,
  processName: optText.transform((v) => v ?? ''),
  supplierId: optId,
  supplierName: optText,
  teamId: optId,
  teamName: optText,
  category: optText.pipe(z.string().max(40).nullable()),
  quantity: int.default(0),
  status: z.string().max(20),
  inspectionResult: z.string().max(20).nullish().transform((v) => v ?? 'PASS'),
  unqualifiedQuantity: int.nullish().transform((v) => v ?? null),
  linkedIssueId: optId,
  linkedIssueNo: optText,
  reporterId: optId,
  submittedAt: isoDate,
  closedAt: optDate,
  ...base,
})

export interface ResourceDef<T extends { updatedAt: Date }> {
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  /** 游标里的 key：工单是 workOrderNumber，其余是 id */
  key: (row: T) => string
  write: (tx: Tx, rows: T[]) => Promise<void>
}

const def = <T extends { updatedAt: Date }>(d: ResourceDef<T>) => d as unknown as ResourceDef<{ updatedAt: Date }>

export const RESOURCES: Record<SyncResource, ResourceDef<{ updatedAt: Date }>> = {
  'work-orders': def({
    schema: qmsWorkOrderSchema,
    key: (r) => r.workOrderNumber,
    async write(tx, rows) {
      for (const r of rows) await writeWorkOrderCopy(tx, r)
    },
  }),
  suppliers: def({
    schema: supplier,
    key: (r) => r.id,
    async write(tx, rows) {
      for (const r of rows) await tx.qmsSupplier.upsert({ where: { id: r.id }, create: r, update: r })
    },
  }),
  teams: def({
    schema: team,
    key: (r) => r.id,
    async write(tx, rows) {
      for (const r of rows) {
        const data = { ...r, kind: 'TEAM', category: null, outsourcingMode: null }
        await tx.qmsSupplier.upsert({ where: { id: r.id }, create: data, update: data })
      }
    },
  }),
  processes: def({
    schema: process,
    key: (r) => r.id,
    async write(tx, rows) {
      for (const r of rows) await tx.qmsProcess.upsert({ where: { id: r.id }, create: r, update: r })
    },
  }),
  departments: def({
    schema: department,
    key: (r) => r.id,
    async write(tx, rows) {
      for (const r of rows) await tx.qmsDepartment.upsert({ where: { id: r.id }, create: r, update: r })
    },
  }),
  users: def({
    schema: user,
    key: (r) => r.id,
    async write(tx, rows) {
      for (const { isActive, ...r } of rows) {
        const data = { ...r, status: isActive ? 'ACTIVE' : 'INACTIVE' }
        await tx.qmsUser.upsert({ where: { id: r.id }, create: data, update: data })
      }
    },
  }),
  inspections: def({
    schema: inspection,
    key: (r) => r.id,
    async write(tx, rows) {
      for (const r of rows) {
        // 主工单也放进 workOrderNumbers，去重
        const data = { ...r, workOrderNumbers: [...new Set([r.workOrderNumber, ...r.workOrderNumbers])] }
        await tx.qmsInspection.upsert({ where: { id: r.id }, create: data, update: data })
      }
    },
  }),
}
