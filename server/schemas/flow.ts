/** 接口请求体的 zod 片段（多个路由共用）。放在 api/ 外面，避免被当成路由。 */
import { z } from 'zod'
import { parseDay } from '../services/flow/dates'

export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .transform(parseDay)

export const stepFields = {
  processId: z.string().min(1, '请选择工序').max(64),
  mode: z.enum(['SELF', 'IN_PLANT_OUTSOURCE', 'EXTERNAL_OUTSOURCE']),
  supplierId: z.string().max(64).nullish(),
  ownerId: z.string().max(64).nullish(),
  dueDate: day.nullish(),
}

export const source = z.enum(['MOBILE', 'PC']).default('PC')

export const partFields = {
  name: z.string().trim().min(1, '请填写工件名称').max(191),
  drawingNo: z.string().trim().max(191).nullish(),
  quantity: z.number().int().min(1, '数量至少为 1').max(100000),
  qmsPartId: z.string().trim().max(64).nullish(),
}
