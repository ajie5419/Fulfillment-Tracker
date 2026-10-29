import { z } from 'zod'
import { day } from './flow'
import { newLineBody } from './purchases'
import { paginationFields, safePageOffset } from './pagination'

export const planItemBody = newLineBody.pick({ materialName: true, spec: true, quantity: true, unit: true, partId: true, supplierName: true, note: true }).extend({
  // BOM 草稿保留解析结果（含 0），下发前校验完整性。
  quantity: z.number().min(0).max(1e9).refine(n => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6, '数量最多 3 位小数'),
  needDate: day.nullish(),
  sortOrder: z.number().int().min(0).max(100000).default(0),
}).strict()
export const planHeadBody = z.object({
  title: z.string().trim().min(1, '请填写标题').max(191),
  category: z.string().trim().max(191).default(''),
  planNodeId: z.string().max(191).nullish(),
  note: z.string().trim().max(500).nullish(),
}).strict()
export const newPlanBody = planHeadBody.extend({ workOrderNumber: z.string().trim().min(1).max(64) }).strict()
export const planListQuery = z.object({
  ...paginationFields,
  workOrderNumber: z.string().max(64).optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'WITHDRAWN']).optional(),
}).superRefine(safePageOffset)
export const convertPlanBody = z.object({ itemIds: z.array(z.string().min(1).max(191)).min(1).max(2000).optional() }).strict()
