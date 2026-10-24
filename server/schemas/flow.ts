/** 接口请求体的 zod 片段（多个路由共用）。放在 api/ 外面，避免被当成路由。 */
import { z } from 'zod'
import { parseDay } from '../services/flow/dates'

/** 'YYYY-MM-DD' 且是真实存在的日期（2026-13-45、2026-02-30 这类直接 400，不让 Invalid Date 进数据库） */
export const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine((d) => {
    const t = parseDay(d)
    return Number.isFinite(t.getTime()) && t.toISOString().slice(0, 10) === d
  }, '日期无效')

export const day = dayString.transform(parseDay)

export const stepFields = {
  processId: z.string().min(1, '请选择工序').max(64),
  mode: z.enum(['SELF', 'IN_PLANT_OUTSOURCE', 'EXTERNAL_OUTSOURCE']),
  supplierId: z.string().max(64).nullish(),
  ownerId: z.string().max(64).nullish(),
  dueDate: day.nullish(),
  /** 所属总计划节点（R14）；工单已发布总计划时新加工序必填 */
  planNodeId: z.string().max(191).nullish(),
}

export const source = z.enum(['MOBILE', 'PC']).default('PC')

export const partFields = {
  name: z.string().trim().min(1, '请填写工件名称').max(191),
  drawingNo: z.string().trim().max(191).nullish(),
  revision: z.string().trim().max(64).nullish(),
  quantity: z.number().int().min(1, '数量至少为 1').max(100000),
  qmsPartId: z.string().trim().max(64).nullish(),
}
